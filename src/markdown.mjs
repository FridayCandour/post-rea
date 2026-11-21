/**
 * Markdown rendering for `--md`.
 *
 * `extractArticle` (see extract.mjs) returns a structured block tree from the
 * live DOM; this module turns that tree into GitHub-flavored Markdown. Keeping
 * the renderer pure means it can be unit-tested without a browser.
 */

const INLINE_ESCAPE = /([\\`*_])/g;

function escapeInline(value) {
  return String(value ?? '').replace(INLINE_ESCAPE, '\\$1');
}

function mergeText(nodes) {
  const merged = [];
  for (const node of nodes) {
    if (!node) continue;
    const last = merged[merged.length - 1];
    if (node.t === 'text' && last && last.t === 'text') {
      last.v += node.v;
      continue;
    }
    if (node.t === 'text' && !node.v) continue;
    merged.push(node);
  }
  return merged;
}

/**
 * Wrap rendered inline content while keeping the whitespace that lived inside
 * the original element (`<a> text</a>` must not glue itself to the next word).
 */
function wrapInline(inner, open, close = open) {
  const value = String(inner ?? '');
  const core = value.trim();
  if (!core) return value;
  const lead = /^\s/.test(value) ? ' ' : '';
  const trail = /\s$/.test(value) ? ' ' : '';
  return `${lead}${open}${core}${close}${trail}`;
}

function renderInlineCode(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}

function renderLink(node) {
  const href = String(node.href || '');
  const rendered = renderInline(node.c || []);
  if (!/^https?:/i.test(href)) return rendered || escapeInline(href);
  const safeHref = href.replace(/\)/g, '%29').replace(/\s/g, '%20');
  const title = node.title ? ` "${String(node.title).replace(/"/g, '\\"')}"` : '';
  return wrapInline(rendered || escapeInline(href), `[`, `](${safeHref}${title})`);
}

export function renderInline(nodes) {
  return mergeText(nodes || []).map(renderInlineNode).join('');
}

function renderInlineNode(node) {
  switch (node.t) {
    case 'text':
      return escapeInline(node.v);
    case 'br':
      return '  \n';
    case 'strong':
      return wrapInline(renderInline(node.c), '**');
    case 'em':
      return wrapInline(renderInline(node.c), '*');
    case 'del':
      return wrapInline(renderInline(node.c), '~~');
    case 'code': {
      const raw = String(node.v ?? '');
      const lead = /^\s/.test(raw) ? ' ' : '';
      const trail = /\s$/.test(raw) ? ' ' : '';
      return `${lead}${renderInlineCode(raw)}${trail}`;
    }
    case 'a':
      return renderLink(node);
    case 'img': {
      const alt = String(node.alt || '').replace(/[[\]]/g, '');
      const title = node.title ? ` "${String(node.title).replace(/"/g, '\\"')}"` : '';
      return `![${alt}](${node.src}${title})`;
    }
    default:
      return node.c ? renderInline(node.c) : '';
  }
}

function fenceFor(content) {
  const longest = Math.max(0, ...(String(content).match(/`{3,}/g) || []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function renderCode(block) {
  const code = String(block.v ?? '').replace(/^\n+|\s+$/g, '');
  if (!code.trim()) return '';
  const fence = fenceFor(code);
  return `${fence}${block.lang || ''}\n${code}\n${fence}`;
}

function renderList(block) {
  const lines = [];
  (block.items || []).forEach((itemBlocks, index) => {
    const body = (itemBlocks || [])
      .map(renderBlock)
      .map((chunk) => String(chunk || '').trim())
      .filter(Boolean)
      .join('\n');
    if (!body) return;
    const marker = block.ordered ? `${(Number(block.start) || 1) + index}. ` : '- ';
    const padding = ' '.repeat(marker.length);
    const bodyLines = body.split('\n');
    lines.push(marker + bodyLines[0]);
    for (let i = 1; i < bodyLines.length; i += 1) {
      lines.push(bodyLines[i] ? padding + bodyLines[i] : '');
    }
  });
  return lines.join('\n');
}

function renderTable(block) {
  const rows = (block.rows || [])
    .map((row) => row.map((cell) => renderInline(cell).replace(/\n/g, ' ').replace(/\|/g, '\\|').trim()))
    .filter((row) => row.some(Boolean));
  if (!rows.length) return '';

  const width = Math.max(...rows.map((row) => row.length));
  const cells = rows.map((row) => Array.from({ length: width }, (_, i) => row[i] || ''));
  const header = cells[0];
  const output = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of cells.slice(1)) output.push(`| ${row.join(' | ')} |`);
  return output.join('\n');
}

function renderQuote(block) {
  const inner = renderBlocks(block.blocks).trim();
  if (!inner) return '';
  return inner
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

function renderImage(block) {
  const alt = String(block.alt || '').replace(/[[\]]/g, '');
  const title = block.title ? ` "${String(block.title).replace(/"/g, '\\"')}"` : '';
  const image = `![${alt}](${block.src}${title})`;
  const caption = renderInline(block.caption || []).trim();
  // Figures often repeat the alt text in the caption; print it only when it adds information.
  const redundant = caption === alt.trim() || caption === alt.replace(/[\\*_`]/g, '').trim();
  return caption && !redundant ? `${image}\n\n*${caption}*` : image;
}

function renderBlock(block) {
  switch (block.b) {
    case 'h':
      return `${'#'.repeat(Math.min(Math.max(Number(block.level) || 2, 1), 6))} ${renderInline(block.c).trim()}`;
    case 'p':
      return renderInline(block.c).trim();
    case 'code':
      return renderCode(block);
    case 'quote':
      return renderQuote(block);
    case 'list':
      return renderList(block);
    case 'table':
      return renderTable(block);
    case 'img':
      return block.src ? renderImage(block) : '';
    case 'hr':
      return '---';
    default:
      return block.blocks ? renderBlocks(block.blocks) : '';
  }
}

export function renderBlocks(blocks) {
  return (blocks || [])
    .map(renderBlock)
    .map((chunk) => String(chunk || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** YAML front matter. Values are JSON-quoted, which is valid YAML. */
export function renderFrontMatter(fields) {
  const entries = Object.entries(fields).filter(([, value]) => value !== '' && value !== null && value !== undefined);
  if (!entries.length) return '';
  const lines = entries.map(([key, value]) =>
    typeof value === 'number' && Number.isFinite(value) ? `${key}: ${value}` : `${key}: ${JSON.stringify(String(value))}`,
  );
  return ['---', ...lines, '---'].join('\n');
}

/** Build the final `.md` document: front matter, H1 title, article body. */
export function renderMarkdownDocument({ meta = {}, blocks = [] }) {
  const body = renderBlocks(blocks);
  const title = String(meta.title || '').trim();
  const heading = title ? `# ${escapeInline(title)}` : '';
  return `${[renderFrontMatter(meta), heading, body].filter(Boolean).join('\n\n').trim()}\n`;
}

export function countWords(markdown) {
  const body = String(markdown || '').replace(/^---[\s\S]*?---\n/, '');
  return body.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

export { escapeInline };
