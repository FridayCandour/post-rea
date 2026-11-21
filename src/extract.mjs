import { blockHeavyResources, createPage, openPage } from './browser.mjs';
import { countWords, renderBlocks, renderMarkdownDocument } from './markdown.mjs';

/**
 * Runs inside the page. Picks the main content container, strips navigation /
 * share / cookie chrome, and walks the DOM into a block tree that
 * `markdown.mjs` can render deterministically.
 */
function extractInPage() {
  const JUNK =
    /(?:^|[-_\s])(?:share|sharing|social|related|recommended|newsletter|subscribe|signup|comments?|comment-form|cookie|consent|gdpr|advert|advertisement|sponsor|breadcrumbs?|pagination|pager|sidebar|widget|author-bio|avatar|post-tags|tag-list|tags-list|post-meta|entry-meta|article-meta|byline|posted-on|reading-time|toc|table-of-contents|skip-link|nav|menu|site-header|site-footer|masthead)(?:[-_\s]|$)/i;

  const JUNK_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'nav', 'footer', 'aside', 'form', 'button',
    'input', 'select', 'textarea', 'svg', 'canvas', 'iframe', 'video', 'audio', 'dialog',
    'link', 'meta', 'object', 'embed', 'map', 'area',
  ]);

  const TRANSPARENT = new Set([
    'div', 'section', 'article', 'main', 'header', 'figure-inner', 'body', 'html', 'span', 'center',
  ]);

  const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const clean = (value) => String(value ?? '').replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ');

  const absolutize = (raw) => {
    if (!raw) return null;
    const value = String(raw).trim();
    if (!value || /^(?:data:|about:|javascript:|mailto:|tel:|#)/i.test(value)) return null;
    try {
      const url = new URL(value, document.baseURI);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };

  const pickSrcset = (value) => {
    const parts = String(value || '')
      .split(',')
      .map((part) => {
        const [url, descriptor] = part.trim().split(/\s+/);
        const match = /([\d.]+)([wx])/i.exec(descriptor || '');
        const weight = match ? Number(match[1]) * (match[2].toLowerCase() === 'x' ? 1000 : 1) : 0;
        return { url, weight };
      })
      .filter((entry) => entry.url);
    if (!parts.length) return null;
    parts.sort((a, b) => b.weight - a.weight);
    return parts[0].url;
  };

  const imageSrc = (img) => {
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
    const current = img.currentSrc && !/^data:/i.test(img.currentSrc) ? img.currentSrc : '';
    const src = img.getAttribute('src');
    const usable = src && !/^data:/i.test(src) ? src : '';
    const fromSet = pickSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
    const candidate = lazy || fromSet || current || usable;
    return absolutize(candidate);
  };

  const isJunkElement = (el) => {
    if (JUNK_TAGS.has(el.tagName.toLowerCase())) return true;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
    const signature = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`;
    return signature.trim().length > 0 && JUNK.test(signature);
  };

  const mergeText = (nodes) => {
    const merged = [];
    for (const node of nodes) {
      if (!node) continue;
      const last = merged[merged.length - 1];
      if (node.t === 'text' && last && last.t === 'text') last.v += node.v;
      else if (node.t !== 'text' || node.v) merged.push(node);
    }
    return merged;
  };

  const hasContent = (nodes) => nodes.some((node) => (node.t === 'text' ? node.v.trim().length > 0 : true));

  const plainText = (nodes) =>
    nodes
      .map((node) => (node.t === 'text' ? node.v : node.t === 'img' ? '' : plainText(node.c || [])))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

  const inlineNodes = (root) => {
    const out = [];
    const walk = (node) => {
      if (node.nodeType === 3) {
        const value = clean(node.nodeValue).replace(/\s+/g, ' ');
        if (value) out.push({ t: 'text', v: value });
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      if (isJunkElement(el)) return;
      const tag = el.tagName.toLowerCase();

      if (tag === 'br') return out.push({ t: 'br' });
      if (tag === 'strong' || tag === 'b') return out.push({ t: 'strong', c: inlineNodes(el) });
      if (tag === 'em' || tag === 'i') return out.push({ t: 'em', c: inlineNodes(el) });
      if (tag === 'del' || tag === 's' || tag === 'strike') return out.push({ t: 'del', c: inlineNodes(el) });
      if (tag === 'code') {
        const value = clean(el.textContent).replace(/\s+/g, ' ').trim();
        if (value) out.push({ t: 'code', v: value });
        return;
      }
      if (tag === 'a') {
        const href = absolutize(el.getAttribute('href'));
        const children = inlineNodes(el);
        if (!href) return out.push(...children);
        return out.push({
          t: 'a',
          href,
          title: el.getAttribute('title') || undefined,
          c: children.length ? children : [{ t: 'text', v: href }],
        });
      }
      if (tag === 'img') {
        const src = imageSrc(el);
        if (src) out.push({ t: 'img', src, alt: (el.getAttribute('alt') || '').trim(), title: el.getAttribute('title') || undefined });
        return;
      }
      for (const child of el.childNodes) walk(child);
    };
    for (const child of root.childNodes) walk(child);
    return mergeText(out);
  };

  const tableBlock = (table) => {
    const rows = [];
    table.querySelectorAll('tr').forEach((row) => {
      const cells = [...row.children]
        .filter((cell) => ['td', 'th'].includes(cell.tagName.toLowerCase()))
        .map((cell) => inlineNodes(cell));
      if (cells.some(hasContent)) rows.push(cells);
    });
    return rows.length ? { b: 'table', rows } : null;
  };

  const walkBlocks = (root) => {
    const out = [];
    let pending = [];

    const flush = () => {
      if (!pending.length) return;
      const nodes = mergeText(pending);
      pending = [];
      if (hasContent(nodes)) out.push({ b: 'p', c: nodes });
    };

    const visit = (node) => {
      if (node.nodeType === 3) {
        const value = clean(node.nodeValue).replace(/\s+/g, ' ');
        if (value.trim()) pending.push({ t: 'text', v: value });
        else if (value && pending.length) pending.push({ t: 'text', v: ' ' });
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      if (isJunkElement(el)) return;
      const tag = el.tagName.toLowerCase();

      if (/^h[1-6]$/.test(tag)) {
        flush();
        const children = inlineNodes(el);
        if (hasContent(children)) out.push({ b: 'h', level: Number(tag[1]), c: children });
        return;
      }
      if (tag === 'p') {
        flush();
        const children = inlineNodes(el);
        if (hasContent(children)) out.push({ b: 'p', c: children });
        return;
      }
      if (tag === 'pre') {
        flush();
        const code = el.querySelector('code');
        const signature = `${code ? code.getAttribute('class') || '' : ''} ${el.getAttribute('class') || ''}`;
        const language = /(?:language|lang|highlight)-([\w#+.-]+)/i.exec(signature);
        const value = (code || el).textContent.replace(/^\n+|\s+$/g, '');
        if (value.trim()) out.push({ b: 'code', lang: language ? language[1].toLowerCase() : '', v: value });
        return;
      }
      if (tag === 'ul' || tag === 'ol') {
        flush();
        const items = [...el.children]
          .filter((child) => child.tagName.toLowerCase() === 'li')
          .map((li) => walkBlocks(li))
          .filter((blocks) => blocks.length > 0);
        if (items.length) {
          out.push({ b: 'list', ordered: tag === 'ol', start: Number(el.getAttribute('start')) || 1, items });
        }
        return;
      }
      if (tag === 'blockquote') {
        flush();
        const blocks = walkBlocks(el);
        if (blocks.length) out.push({ b: 'quote', blocks });
        return;
      }
      if (tag === 'figure') {
        flush();
        const img = el.querySelector('img');
        const src = img ? imageSrc(img) : null;
        if (src) {
          const caption = el.querySelector('figcaption');
          out.push({
            b: 'img',
            src,
            alt: (img.getAttribute('alt') || '').trim(),
            title: img.getAttribute('title') || undefined,
            caption: caption ? inlineNodes(caption) : null,
          });
        } else {
          for (const block of walkBlocks(el)) out.push(block);
        }
        return;
      }
      if (tag === 'img') {
        flush();
        const src = imageSrc(el);
        if (src) {
          out.push({ b: 'img', src, alt: (el.getAttribute('alt') || '').trim(), title: el.getAttribute('title') || undefined });
        }
        return;
      }
      if (tag === 'table') {
        flush();
        const block = tableBlock(el);
        if (block) out.push(block);
        return;
      }
      if (tag === 'hr') {
        flush();
        out.push({ b: 'hr' });
        return;
      }
      if (tag === 'dl') {
        flush();
        for (const child of el.children) {
          const childTag = child.tagName.toLowerCase();
          if (childTag !== 'dt' && childTag !== 'dd') continue;
          const children = inlineNodes(child);
          if (!hasContent(children)) continue;
          out.push({ b: 'p', c: childTag === 'dt' ? [{ t: 'strong', c: children }] : children });
        }
        return;
      }
      if (TRANSPARENT.has(tag)) {
        flush();
        for (const child of el.childNodes) visit(child);
        flush();
        return;
      }
      const inline = inlineNodes(el);
      if (hasContent(inline)) pending.push(...inline);
    };

    for (const child of root.childNodes) visit(child);
    flush();
    return out;
  };

  const CONTAINER_SELECTORS = [
    'article',
    'main article',
    '[itemprop="articleBody"]',
    '.post-content',
    '.entry-content',
    '.article-content',
    '.article-body',
    '.post-body',
    '.entry-body',
    '.content-body',
    '.story-body',
    '.c-article-body',
    '.markdown-body',
    '.prose',
    'main',
    '[role="main"]',
  ];

  const removeJunk = (root) => {
    const doomed = [];
    root
      .querySelectorAll('script,style,noscript,template,nav,footer,aside,form,button,dialog,[hidden],[aria-hidden="true"]')
      .forEach((el) => doomed.push(el));
    for (const el of root.querySelectorAll('*')) {
      const signature = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`.trim();
      if (signature && JUNK.test(signature)) doomed.push(el);
    }
    for (const el of doomed) el.remove();
  };

  const scoreOf = (el) => {
    const inner = text(el);
    if (inner.length < 200) return -1;
    let linkLength = 0;
    el.querySelectorAll('a').forEach((anchor) => {
      linkLength += (anchor.innerText || '').length;
    });
    const density = Math.min(linkLength / Math.max(inner.length, 1), 0.9);
    return inner.length * (1 - density) + el.querySelectorAll('p, li, pre, blockquote, h2, h3').length * 30;
  };

  let container = null;
  let bestScore = -1;
  const seen = new Set();
  for (const selector of CONTAINER_SELECTORS) {
    for (const candidate of document.querySelectorAll(selector)) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const style = window.getComputedStyle(candidate);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const score = scoreOf(candidate);
      if (score > bestScore) {
        bestScore = score;
        container = candidate;
      }
    }
  }
  if (!container) container = document.querySelector('article') || document.querySelector('main') || document.body;
  removeJunk(container);

  const metaContent = (selector) => {
    const el = document.querySelector(selector);
    return el ? (el.getAttribute('content') || '').trim() : '';
  };
  const stripSiteSuffix = (value, siteName) => {
    const original = String(value || '').trim();
    if (!original || !siteName) return original;
    const separators = ['|', '-', '–', '—', ':'];
    if (!original.toLowerCase().endsWith(String(siteName).toLowerCase())) return original;
    const head = original.slice(0, original.length - String(siteName).length).replace(/\s+$/, '');
    if (!separators.includes(head.slice(-1))) return original;
    return head.slice(0, -1).trim() || original;
  };

  const siteName = metaContent('meta[property="og:site_name"]');
  const documentTitle = (document.title || '').trim();
  let effectiveSite = siteName;
  if (!effectiveSite && documentTitle) {
    const suffix = /[|\u2013\u2014-]\s*([^|\u2013\u2014-]{2,40})\s*$/.exec(documentTitle);
    if (suffix) effectiveSite = suffix[1].trim();
  }

  const h1 =
    container.querySelector('h1') ||
    document.querySelector('article h1') ||
    document.querySelector('main h1') ||
    document.querySelector('h1');
  const metaTitle =
    metaContent('meta[property="og:title"]') || metaContent('meta[name="twitter:title"]') || '';
  const title = stripSiteSuffix((h1 ? text(h1) : '') || metaTitle || documentTitle, effectiveSite);

  const timeElement =
    document.querySelector('time[datetime]') || document.querySelector('article time') || document.querySelector('time');
  const published =
    metaContent('meta[property="article:published_time"]') ||
    metaContent('meta[name="article:published_time"]') ||
    metaContent('meta[itemprop="datePublished"]') ||
    metaContent('meta[name="pubdate"]') ||
    metaContent('meta[name="date"]') ||
    (timeElement ? (timeElement.getAttribute('datetime') || timeElement.textContent || '').trim() : '');
  const canonicalEl = document.querySelector('link[rel="canonical"]');

  let blocks = walkBlocks(container);

  // Drop a leading H1 that merely repeats the document title.
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (
    blocks.length &&
    blocks[0].b === 'h' &&
    blocks[0].level === 1 &&
    normalize(plainText(blocks[0].c)) === normalize(title)
  ) {
    blocks.shift();
  }
  blocks = blocks.filter((block) => {
    if (block.b === 'p' || block.b === 'h') {
      if (!hasContent(block.c)) return false;
      // Drop "12 min read" / category+reading-time metadata lines.
      const plain = plainText(block.c);
      if (plain.length < 100 && /\b\d+\s*min(?:ute)?\s*read\b/i.test(plain)) return false;
      return true;
    }
    if (block.b === 'code') return Boolean(String(block.v || '').trim());
    return true;
  });
  while (blocks.length && blocks[0].b === 'hr') blocks.shift();
  while (blocks.length && blocks[blocks.length - 1].b === 'hr') blocks.pop();

  if (!blocks.length) {
    const fallback = text(container);
    if (fallback) blocks = [{ b: 'p', c: [{ t: 'text', v: fallback }] }];
  }

  return {
    blocks,
    meta: {
      title,
      description: metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]'),
      author: metaContent('meta[name="author"]') || metaContent('meta[property="article:author"]'),
      publishedAt: published,
      canonical: canonicalEl ? canonicalEl.href : '',
      siteName: effectiveSite,
      lang: document.documentElement.getAttribute('lang') || '',
      image: absolutize(metaContent('meta[property="og:image"]')) || '',
    },
  };
}

/** Capture one page as Markdown (`--md`). */
export async function captureMarkdown(browser, url, opts) {
  const page = await createPage(browser, opts);
  try {
    if (!opts.loadMedia) await blockHeavyResources(page);
    const response = await openPage(page, url, opts, { idleTime: 350, idleTimeout: 5000 });
    const payload = await page.evaluate(extractInPage);
    const blocks = payload.blocks || [];
    const words = countWords(renderBlocks(blocks));

    const fields = {
      title: payload.meta.title || '',
      source: url,
      canonical: payload.meta.canonical && payload.meta.canonical !== url ? payload.meta.canonical : '',
      author: payload.meta.author || '',
      published: payload.meta.publishedAt || '',
      description: payload.meta.description || '',
      site: payload.meta.siteName || '',
      lang: payload.meta.lang || '',
      archived: new Date().toISOString(),
      words,
    };

    return {
      content: renderMarkdownDocument({ meta: fields, blocks }),
      meta: { ...payload.meta, wordCount: words },
      status: response ? response.status() : 0,
      stats: {
        words,
        blocks: blocks.length,
        headings: blocks.filter((block) => block.b === 'h').length,
        images: (renderBlocks(blocks).match(/!\[/g) || []).length,
      },
    };
  } finally {
    await page.close().catch(() => {});
  }
}
