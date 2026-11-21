import { autoscroll, blockHeavyResources, createPage, DEFAULT_USER_AGENT, openPage } from './browser.mjs';
import {
  AssetRegistry,
  assetToken,
  createAssetFetcher,
  fetchStylesheet,
  mimeFor,
  processCss,
  toDataUri,
} from './assets.mjs';
import { mapLimit, sleep } from './util.mjs';

const CLEAN_SELECTORS = [
  '#onetrust-banner-sdk',
  '#onetrust-consent-sdk',
  '#CybotCookiebotDialog',
  '#cookie-law-info-bar',
  '.cc-window',
  '.cookie-banner',
  '.cookie-consent',
  '.cookie-notice',
  '[id*="cookie-banner" i]',
  '[id*="cookie-consent" i]',
  '[class*="cookie-banner" i]',
  '[class*="cookie-consent" i]',
  '[class*="consent-banner" i]',
  '[class*="gdpr-banner" i]',
  '[aria-label*="cookie" i]',
  '[class*="newsletter-popup" i]',
  '[class*="subscribe-popup" i]',
  '[class*="exit-intent" i]',
];

/**
 * Runs inside the page. It never performs network I/O: it rewrites every
 * asset reference to a token and returns the token table so Node can inline
 * the resources afterwards.
 */
function prepareDocument({ keepScripts, clean, bannerMessage, cleanSelectors }) {
  const TOKEN = (kind, index) => `__ARCHIVE_${kind}_${index}__`;
  const baseHref = document.baseURI;
  const assets = [];
  const assetIndex = new Map();
  let assetSeq = 0;

  const absolutize = (raw) => {
    if (raw === null || raw === undefined) return null;
    const value = String(raw).trim();
    if (!value) return null;
    if (/^(?:data:|blob:|about:|javascript:|mailto:|tel:|#)/i.test(value)) return null;
    if (value.startsWith('__ARCHIVE_')) return null;
    try {
      const absolute = new URL(value, baseHref).href;
      return /^https?:/i.test(absolute) ? absolute : null;
    } catch {
      return null;
    }
  };

  const assetRef = (raw) => {
    const absolute = absolutize(raw);
    if (!absolute) return null;
    if (assetIndex.has(absolute)) return TOKEN('ASSET', assetIndex.get(absolute));
    const index = assetSeq;
    assetSeq += 1;
    assetIndex.set(absolute, index);
    assets.push([index, absolute]);
    return TOKEN('ASSET', index);
  };

  const setAssetAttr = (element, attribute, raw) => {
    if (raw === null || raw === undefined || raw === '') return;
    const value = String(raw).trim();
    if (/^(?:data:|blob:)/i.test(value)) {
      if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
      return;
    }
    const token = assetRef(value);
    if (token) {
      element.setAttribute(attribute, token);
      return;
    }
    const absolute = absolutize(value);
    if (absolute) element.setAttribute(attribute, absolute);
  };

  const splitSrcset = (value) => {
    const source = String(value || '');
    const result = [];
    let cursor = 0;
    while (cursor < source.length) {
      while (cursor < source.length && /[\s,]/.test(source[cursor])) cursor += 1;
      if (cursor >= source.length) break;
      const start = cursor;
      while (cursor < source.length && !/\s/.test(source[cursor])) cursor += 1;
      const url = source.slice(start, cursor);
      while (cursor < source.length && source[cursor] === ',') cursor += 1;
      const descriptorStart = cursor;
      while (cursor < source.length && source[cursor] !== ',') cursor += 1;
      result.push([url, source.slice(descriptorStart, cursor).trim()]);
      cursor += 1;
    }
    return result;
  };

  const rewriteSrcset = (value) =>
    splitSrcset(value)
      .map(([url, descriptor]) => {
        const token = assetRef(url);
        const resolved = token || absolutize(url) || url;
        return descriptor ? `${resolved} ${descriptor}` : resolved;
      })
      .join(', ');

  /** Highest-resolution srcset candidate, used when the browser never loaded the image. */
  const bestSrcsetCandidate = (value) => {
    const candidates = splitSrcset(value).map(([url, descriptor]) => {
      const match = /([\d.]+)\s*([wx])/i.exec(descriptor || '');
      const weight = match ? Number(match[1]) * (match[2].toLowerCase() === 'x' ? 1000 : 1) : 0;
      return { url, weight };
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.weight - a.weight);
    return candidates[0].url;
  };

  const doc = document;
  let removedScriptCount = 0;

  // 1. Materialise lazy-loaded sources before we look at them.
  doc.querySelectorAll('img, source, video, audio, iframe, embed, object').forEach((el) => {
    const lazySrc =
      el.getAttribute('data-src') ||
      el.getAttribute('data-lazy-src') ||
      el.getAttribute('data-original') ||
      el.getAttribute('data-echo') ||
      el.getAttribute('data-url');
    const current = el.getAttribute('src');
    if (lazySrc && (!current || /^data:/i.test(current))) el.setAttribute('src', lazySrc);

    const lazySrcset = el.getAttribute('data-srcset') || el.getAttribute('data-lazy-srcset');
    if (lazySrcset && !el.getAttribute('srcset')) el.setAttribute('srcset', lazySrcset);
    el.removeAttribute('loading');
  });

  // 2. Images / media: capture currentSrc BEFORE stylesheets are detached so
  //    responsive image choice stays what the visitor actually saw.
  doc.querySelectorAll('img').forEach((img) => {
    let chosen = img.currentSrc || img.getAttribute('src');
    if (!chosen && img.getAttribute('srcset')) {
      chosen = bestSrcsetCandidate(img.getAttribute('srcset'));
    }
    setAssetAttr(img, 'src', chosen);
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
  });

  doc.querySelectorAll('source[srcset]').forEach((source) => {
    source.setAttribute('srcset', rewriteSrcset(source.getAttribute('srcset')));
  });
  doc.querySelectorAll('source[src]').forEach((source) => {
    setAssetAttr(source, 'src', source.getAttribute('src'));
  });
  doc.querySelectorAll('video[poster]').forEach((video) => {
    setAssetAttr(video, 'poster', video.getAttribute('poster'));
  });
  doc.querySelectorAll('video[src], audio[src]').forEach((media) => {
    setAssetAttr(media, 'src', media.getAttribute('src'));
  });
  doc.querySelectorAll('input[type="image"][src]').forEach((input) => {
    setAssetAttr(input, 'src', input.getAttribute('src'));
  });
  doc.querySelectorAll('object[data]').forEach((object) => {
    setAssetAttr(object, 'data', object.getAttribute('data'));
  });
  doc.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]').forEach((link) => {
    setAssetAttr(link, 'href', link.getAttribute('href'));
  });

  // 3. Absolute links so the offline copy still navigates correctly.
  doc.querySelectorAll('a[href]').forEach((anchor) => {
    const raw = anchor.getAttribute('href');
    if (!raw || raw.startsWith('#') || /^(?:mailto:|tel:|javascript:)/i.test(raw)) return;
    const absolute = absolutize(raw);
    if (absolute) anchor.setAttribute('href', absolute);
  });
  doc
    .querySelectorAll('link[rel="canonical"], link[rel="alternate"], link[rel="amphtml"], form[action]')
    .forEach((el) => {
      const attribute = el.tagName.toLowerCase() === 'form' ? 'action' : 'href';
      const raw = el.getAttribute(attribute);
      const absolute = absolutize(raw);
      if (absolute) el.setAttribute(attribute, absolute);
    });

  // 4. Drop anything CSP related, preloads and executable scripts.
  doc.querySelectorAll('meta[http-equiv]').forEach((meta) => {
    if (/content-security-policy/i.test(meta.getAttribute('http-equiv') || '')) meta.remove();
  });
  doc.querySelectorAll('link[rel]').forEach((link) => {
    const rel = (link.getAttribute('rel') || '').toLowerCase();
    if (/\b(preload|prefetch|preconnect|dns-prefetch|modulepreload|manifest|prerender)\b/.test(rel)) link.remove();
  });
  if (!keepScripts) {
    let removedScripts = 0;
    doc.querySelectorAll('script').forEach((script) => {
      const type = (script.getAttribute('type') || '').toLowerCase();
      if (type.includes('ld+json') || type.includes('application/json')) return;
      script.remove();
      removedScripts += 1;
    });
    doc.querySelectorAll('noscript').forEach((noscript) => noscript.remove());
    removedScriptCount = removedScripts;
  }

  // 5. External stylesheets become <style> placeholders filled in by Node.
  const stylesheets = [];
  doc.querySelectorAll('link[rel~="stylesheet"]').forEach((link) => {
    const href = link.href;
    if (!href) {
      link.remove();
      return;
    }
    const index = stylesheets.length;
    stylesheets.push({ index, href, media: link.getAttribute('media') || '' });
    const style = doc.createElement('style');
    style.setAttribute('data-archive-css', String(index));
    if (link.getAttribute('media')) style.setAttribute('media', link.getAttribute('media'));
    style.textContent = TOKEN('CSS', index);
    link.replaceWith(style);
  });

  // 6. Inline <style> blocks: hand the CSS to Node (it may contain url()s).
  const inlineStyles = [];
  doc.querySelectorAll('style').forEach((style) => {
    if (style.hasAttribute('data-archive-css')) return;
    const css = style.textContent || '';
    if (!css.trim()) return;
    if (!/url\(|@import/i.test(css)) return;
    const index = inlineStyles.length;
    inlineStyles.push({ index, css });
    style.textContent = TOKEN('INLINE_CSS', index);
  });

  // 7. Inline style attributes that reference background images etc.
  const styleAttrs = [];
  doc.querySelectorAll('[style]').forEach((element) => {
    const css = element.getAttribute('style') || '';
    if (!/url\(/i.test(css)) return;
    const index = styleAttrs.length;
    styleAttrs.push({ index, css });
    element.setAttribute('style', TOKEN('STYLE_ATTR', index));
  });

  // 8. Optional clean-up of cookie/consent/popup chrome.
  if (clean) {
    for (const selector of cleanSelectors || []) {
      try {
        doc.querySelectorAll(selector).forEach((el) => el.remove());
      } catch {
        /* invalid selector on very old engines */
      }
    }
  }

  // 9. Provenance + basic document hygiene.
  const head = doc.head || doc.querySelector('head') || doc.documentElement;
  const ensureMeta = (name, content, prepend = false) => {
    if (!content) return;
    if (head.querySelector(`meta[name="${name}"]`)) return;
    const meta = doc.createElement('meta');
    meta.setAttribute('name', name);
    meta.setAttribute('content', content);
    if (prepend) head.insertBefore(meta, head.firstChild);
    else head.appendChild(meta);
  };
  // Kept first in <head> so archive tooling can read the source URL cheaply.
  ensureMeta('archived-from', location.href, true);
  ensureMeta('archived-at', new Date().toISOString());
  ensureMeta('archived-by', 'blog-post-archiver');

  if (!head.querySelector('meta[charset]')) {
    const charset = doc.createElement('meta');
    charset.setAttribute('charset', 'utf-8');
    head.insertBefore(charset, head.firstChild);
  }
  if (!head.querySelector('meta[name="viewport"]')) {
    const viewport = doc.createElement('meta');
    viewport.setAttribute('name', 'viewport');
    viewport.setAttribute('content', 'width=device-width, initial-scale=1');
    head.appendChild(viewport);
  }

  if (bannerMessage && doc.body) {
    const banner = doc.createElement('div');
    banner.setAttribute('data-archive-banner', '');
    banner.textContent = bannerMessage;
    banner.setAttribute(
      'style',
      'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:6px 12px;' +
        'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
        'color:#fff;background:rgba(17,24,39,.92);text-align:center;pointer-events:none;',
    );
    doc.body.insertBefore(banner, doc.body.firstChild);
  }

  const doctypeNode = doc.doctype;
  let doctype = '<!DOCTYPE html>';
  if (doctypeNode) {
    doctype = `<!DOCTYPE ${doctypeNode.name}`;
    if (doctypeNode.publicId) doctype += ` PUBLIC "${doctypeNode.publicId}"`;
    if (doctypeNode.systemId) doctype += ` "${doctypeNode.systemId}"`;
    doctype += '>';
  }

  const html = `${doctype}\n${doc.documentElement.outerHTML}`;

  return {
    html,
    assets,
    stylesheets,
    inlineStyles,
    styleAttrs,
    baseHref,
    stats: {
      scriptsRemoved: removedScriptCount,
      stylesheets: stylesheets.length,
      assets: assets.length,
    },
  };
}

/** Read the metadata a blog post usually exposes, for the manifest/index. */
async function readMetadata(page) {
  return page.evaluate(() => {
    const meta = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return '';
      return (element.getAttribute('content') || element.textContent || '').trim();
    };
    const bodyText = (document.body && document.body.innerText) || '';
    const timeElement = document.querySelector('time[datetime]') || document.querySelector('article time') || document.querySelector('time');
    const timeValue = timeElement
      ? (timeElement.getAttribute('datetime') || timeElement.getAttribute('content') || timeElement.textContent || '').trim()
      : '';
    const published =
      meta('meta[property="article:published_time"]') ||
      meta('meta[name="article:published_time"]') ||
      meta('meta[itemprop="datePublished"]') ||
      meta('meta[name="pubdate"]') ||
      meta('meta[name="date"]') ||
      timeValue;

    return {
      title:
        meta('meta[property="og:title"]') ||
        meta('meta[name="twitter:title"]') ||
        (document.title || '').trim(),
      description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
      author: meta('meta[name="author"]') || meta('meta[property="article:author"]') || meta('[rel="author"]'),
      publishedAt: published,
      canonical: (document.querySelector('link[rel="canonical"]') || {}).href || location.href,
      siteName: meta('meta[property="og:site_name"]'),
      image: meta('meta[property="og:image"]'),
      lang: document.documentElement.getAttribute('lang') || '',
      wordCount: bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0,
    };
  });
}

/**
 * Load a page, freeze it into a self-contained document, and return the final
 * HTML together with post metadata.
 */
export async function capturePage(browser, url, opts) {
  const page = await createPage(browser, opts);
  try {
    // The browser does not need images/fonts/media: we fetch those ourselves.
    if (!opts.loadMedia) await blockHeavyResources(page);
    const response = await openPage(page, url, opts, { idleTime: 350, idleTimeout: 5000 });
    const status = response ? response.status() : 0;
    await autoscroll(page);

    const meta = await readMetadata(page);
    const payload = await page.evaluate(prepareDocument, {
      keepScripts: Boolean(opts.keepScripts),
      clean: Boolean(opts.clean),
      cleanSelectors: CLEAN_SELECTORS,
      bannerMessage: opts.banner
        ? `Archived from ${url} on ${new Date().toISOString().slice(0, 10)}`
        : '',
    });

    const assembled = await assembleHtml({ ...payload, pageUrl: url }, opts);
    return { html: assembled.html, meta, status, stats: assembled.stats };
  } finally {
    await page.close().catch(() => {});
  }
}

/** MHTML fallback: Chrome's own single-file snapshot (styles + images embedded). */
export async function captureMhtml(browser, url, opts) {
  const page = await createPage(browser, opts);
  try {
    await openPage(page, url, opts);
    await autoscroll(page);
    const meta = await readMetadata(page);
    const client = await page.createCDPSession();
    const { data } = await client.send('Page.captureSnapshot', { format: 'mhtml' });
    await client.detach().catch(() => {});
    return { html: data, meta, status: 0, stats: { mhtml: true } };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Replace page tokens with inlined CSS and data-URI assets. */
export async function assembleHtml(payload, opts) {
  const registry = new AssetRegistry(payload.assets);
  const fetchAsset = createAssetFetcher({
    userAgent: opts.userAgent || DEFAULT_USER_AGENT,
    timeout: opts.timeout,
    referer: payload.pageUrl,
    cache: opts.assetCache,
  });
  const ctx = { registry, fetchAsset, seen: new Set() };
  const replacements = new Map();

  const stylesheetCss = await mapLimit(payload.stylesheets, 4, async (sheet) => ({
    index: sheet.index,
    css: await fetchStylesheet(sheet.href, ctx),
  }));
  for (const sheet of stylesheetCss) {
    replacements.set(`__ARCHIVE_CSS_${sheet.index}__`, sheet.css);
  }

  for (const item of payload.inlineStyles) {
    replacements.set(`__ARCHIVE_INLINE_CSS_${item.index}__`, await processCss(item.css, payload.baseHref, ctx));
  }

  for (const item of payload.styleAttrs) {
    const css = await processCss(item.css, payload.baseHref, ctx);
    // The CSS ends up inside a double-quoted attribute, so quotes must be entities.
    replacements.set(`__ARCHIVE_STYLE_ATTR_${item.index}__`, css.replace(/"/g, '&quot;'));
  }

  const maxBytes = Math.max(0, Number(opts.maxAssetMb ?? 8)) * 1024 * 1024;
  const counters = { inlined: 0, skipped: 0, failed: 0, deferred: 0 };

  if (opts.downloadAssets === false) {
    for (const [index, assetUrl] of registry.entries()) {
      replacements.set(`__ARCHIVE_ASSET_${index}__`, assetUrl);
      counters.deferred += 1;
    }
  } else {
    await mapLimit(registry.entries(), 10, async ([index, assetUrl]) => {
      const token = `__ARCHIVE_ASSET_${index}__`;
      const asset = await fetchAsset(assetUrl);
      if (!asset.ok || !asset.body) {
        counters.failed += 1;
        replacements.set(token, assetUrl);
        return;
      }
      if (asset.size > maxBytes) {
        counters.skipped += 1;
        replacements.set(token, asset.url || assetUrl);
        return;
      }
      counters.inlined += 1;
      replacements.set(token, toDataUri(asset.body, mimeFor(asset.url || assetUrl, asset.contentType)));
    });
  }

  // Two passes: stylesheet/CSS placeholders first (they introduce new asset
  // tokens), then the asset tokens themselves. Splitting by token would copy
  // the document once per token; two regex passes copy it twice.
  let html = payload.html.replace(/__ARCHIVE_(?:CSS|INLINE_CSS|STYLE_ATTR)_\d+__/g, (token) => {
    const value = replacements.get(token);
    return value !== undefined ? value : token;
  });

  html = html.replace(/__ARCHIVE_ASSET_(\d+)__/g, (token, index) => {
    const value = replacements.get(token);
    if (value !== undefined) return value;
    return registry.byIndex.get(Number(index)) || token;
  });

  return {
    html,
    stats: {
      ...counters,
      scriptsRemoved: payload.stats?.scriptsRemoved ?? 0,
      stylesheets: payload.stylesheets.length,
      inlineStyles: payload.inlineStyles.length,
      assets: registry.entries().length,
    },
  };
}
