/**
 * Asset plumbing for single-file HTML snapshots.
 *
 * The page is never asked to download anything: it only rewrites every
 * asset-bearing attribute / CSS url() into a stable token
 * (`__ARCHIVE_ASSET_<n>__`) and hands back the absolute URLs. All network I/O
 * happens here in Node (no CORS limits), and the final HTML is assembled by
 * string substitution of tokens with data URIs (or the original URL when an
 * asset cannot be fetched).
 */

const TOKEN_PREFIX = '__ARCHIVE_';
const NON_HTTP = /^(?:data:|blob:|about:|javascript:|mailto:|tel:|#)/i;

const MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.css': 'text/css',
};

export function absolutizeUrl(raw, base) {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  if (!value || NON_HTTP.test(value) || value.startsWith(TOKEN_PREFIX)) return null;
  try {
    const url = new URL(value, base);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function assetToken(index) {
  return `${TOKEN_PREFIX}ASSET_${index}__`;
}

export class AssetRegistry {
  /** @param {Array<[number, string]>} pairs tokens produced by the page */
  constructor(pairs = []) {
    this.byUrl = new Map();
    this.byIndex = new Map();
    for (const [index, url] of pairs) {
      this.byUrl.set(url, index);
      this.byIndex.set(index, url);
    }
    this.next = this.byIndex.size ? Math.max(...this.byIndex.keys()) + 1 : 0;
  }

  token(raw, base) {
    const absolute = absolutizeUrl(raw, base);
    if (!absolute) return null;
    if (this.byUrl.has(absolute)) return this.byUrl.get(absolute);
    const index = this.next;
    this.next += 1;
    this.byUrl.set(absolute, index);
    this.byIndex.set(index, absolute);
    return index;
  }

  entries() {
    return [...this.byIndex.entries()];
  }
}

const CSS_URL_PATTERN =
  /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)'"\s]*))\s*\)/gi;

/** Replace every url() in a stylesheet with asset tokens. */
export function rewriteCssUrls(css, baseUrl, registry) {
  return String(css ?? '').replace(CSS_URL_PATTERN, (match, doubleQuoted, singleQuoted, bare) => {
    const raw = doubleQuoted ?? singleQuoted ?? bare ?? '';
    const index = registry.token(raw, baseUrl);
    return index === null ? match : `url("${assetToken(index)}")`;
  });
}

const IMPORT_PATTERN =
  /@import\s+(?:url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\s*\)|"([^"]+)"|'([^']+)')\s*([^;]*);/gi;

async function replaceAsync(input, regex, replacer) {
  const matches = [...input.matchAll(regex)];
  if (!matches.length) return input;
  let output = '';
  let cursor = 0;
  for (const match of matches) {
    output += input.slice(cursor, match.index);
    output += await replacer(match);
    cursor = match.index + match[0].length;
  }
  return output + input.slice(cursor);
}

export function createAssetFetcher({ userAgent, referer, timeout = 30000, cache } = {}) {
  const local = new Map();

  return function fetchAsset(url) {
    if (local.has(url)) return local.get(url);
    if (cache && cache.has(url)) {
      const hit = Promise.resolve(cache.get(url));
      local.set(url, hit);
      return hit;
    }
    const task = (async () => {
      try {
        const response = await fetch(url, {
          headers: {
            'user-agent': userAgent || 'Mozilla/5.0',
            accept: '*/*',
            ...(referer ? { referer } : {}),
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(timeout),
        });
        if (!response.ok) return { ok: false, url, status: response.status };
        const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const buffer = Buffer.from(await response.arrayBuffer());
        return {
          ok: true,
          url: response.url || url,
          contentType,
          body: buffer,
          size: buffer.length,
        };
      } catch (error) {
        return { ok: false, url, error: error.message };
      }
    })();
    local.set(url, task);
    if (cache) {
      task.then((result) => {
        if (result && result.ok) cache.set(url, result);
      });
    }
    return task;
  };
}

/**
 * Cross-page asset cache. Every post on a site shares the same stylesheets and
 * web fonts; fetching them once per crawl instead of once per post is the
 * single biggest win on large archives. Large media is not cached so memory
 * stays bounded.
 */
export class AssetCache {
  constructor({ maxBytes = 256 * 1024 * 1024, maxEntryBytes = 512 * 1024 } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntryBytes = maxEntryBytes;
    this.bytes = 0;
    this.map = new Map();
  }

  has(url) {
    return this.map.has(url);
  }

  get(url) {
    return this.map.get(url);
  }

  set(url, result) {
    if (!result || !result.ok || !result.body) return;
    if (result.size > this.maxEntryBytes) return;
    if (this.bytes + result.size > this.maxBytes) return;
    if (this.map.has(url)) return;
    this.map.set(url, result);
    this.bytes += result.size;
  }
}

export function extensionOf(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = /\.[a-z0-9]{1,5}$/i.exec(pathname);
    return match ? match[0].toLowerCase() : '';
  } catch {
    return '';
  }
}

export function mimeFor(url, contentType) {
  const clean = String(contentType || '').toLowerCase();
  if (clean && clean !== 'application/octet-stream' && clean !== 'binary/octet-stream' && !clean.startsWith('text/plain')) {
    return clean;
  }
  return MIME_BY_EXTENSION[extensionOf(url)] || clean || 'application/octet-stream';
}

export function toDataUri(buffer, mime) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/**
 * Resolve @import chains and rewrite every url() into an asset token.
 * Imported stylesheets are inlined so their relative url()s keep working.
 */
export async function processCss(css, baseUrl, ctx, depth = 0) {
  let output = String(css ?? '').replace(/@charset\s+[^;]+;/gi, '');
  if (!output.trim()) return output;

  if (depth < 4) {
    output = await replaceAsync(output, IMPORT_PATTERN, async (match) => {
      const groups = match.slice(1, 7);
      const rawUrl = groups[0] || groups[1] || groups[2] || groups[3] || groups[4] || '';
      const media = (groups[5] || '').trim();
      const absolute = absolutizeUrl(rawUrl, baseUrl);
      if (!absolute || ctx.seen.has(absolute)) return '';
      ctx.seen.add(absolute);

      const asset = await ctx.fetchAsset(absolute);
      if (!asset.ok || !asset.body) return `@import url("${absolute}");`;
      let inner = await processCss(asset.body.toString('utf8'), asset.url || absolute, ctx, depth + 1);
      if (media && media.toLowerCase() !== 'all') inner = `@media ${media} {\n${inner}\n}`;
      return inner;
    });
  }

  return rewriteCssUrls(output, baseUrl, ctx.registry);
}

/** Fetch a stylesheet and return it fully inlined + tokenised. */
export async function fetchStylesheet(href, ctx) {
  const asset = await ctx.fetchAsset(href);
  if (!asset.ok || !asset.body) return `@import url("${href}");`;
  return processCss(asset.body.toString('utf8'), asset.url || href, ctx);
}
