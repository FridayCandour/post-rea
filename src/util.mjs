import { createHash } from 'node:crypto';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TRACKING_PARAMS = [
  /^utm_/i,
  /^ga_/i,
  /^gclid$/i,
  /^fbclid$/i,
  /^dclid$/i,
  /^msclkid$/i,
  /^mc_(?:cid|eid)$/i,
  /^igshid$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^ref_url$/i,
  /^source$/i,
  /^_hs(?:enc|mi)$/i,
  /^(?:yclid|twclid|srsltid|vero_id|oly_enc_id|oly_anon_id|rb_clickid|wickedid|mkt_tok)$/i,
];

/**
 * Parse, canonicalise and strip tracking noise from a URL.
 * Returns a URL object, or null when the value is not a usable http(s) URL.
 */
export function normalizeUrl(raw, base) {
  let url;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  url.username = '';
  url.password = '';

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((pattern) => pattern.test(key))) url.searchParams.delete(key);
  }
  url.searchParams.sort();

  url.pathname = url.pathname
    .replace(/\/{2,}/g, '/')
    .replace(/\/index\.(?:html?|php|aspx?)$/i, '/');
  if (!url.pathname) url.pathname = '/';

  return url;
}

/** Stable string key for de-duplication. */
export function urlKey(raw, base) {
  const url = normalizeUrl(raw, base);
  return url ? url.href : null;
}

const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'co.za', 'org.za', 'net.za', 'co.nz', 'net.nz', 'org.nz',
  'com.au', 'net.au', 'org.au', 'edu.au', 'co.in', 'net.in', 'org.in',
  'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.mx', 'com.ar', 'com.co',
  'com.sg', 'com.my', 'com.tr', 'com.ua', 'com.pk', 'com.ng', 'com.gh',
  'com.ke', 'co.ke', 'com.eg', 'com.sa', 'com.ph', 'co.id', 'co.il',
  'co.kr', 'com.tw', 'com.hk', 'com.cn', 'co.th', 'com.vn',
]);

const MULTI_LABEL_HOSTS = new Set([
  'github.io', 'gitlab.io', 'netlify.app', 'vercel.app', 'pages.dev',
  'workers.dev', 'web.app', 'firebaseapp.com', 'herokuapp.com',
  'azurewebsites.net', 'blogspot.com', 'substack.com', 'ghost.io',
  'wordpress.com', 'notion.site', 'surge.sh', 'fly.dev', 'onrender.com',
  'readthedocs.io', 'tumblr.com', 'wixsite.com', 'squarespace.com',
  'hashnode.dev', 'bearblog.dev', 'neocities.org',
]);

/** Registrable site for a hostname (handles blog.example.com and user.github.io). */
export function siteOf(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  if (!host || !host.includes('.')) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  const lastThree = parts.slice(-3).join('.');
  if (TWO_LEVEL_SUFFIXES.has(lastTwo)) return lastThree;
  for (const suffix of MULTI_LABEL_HOSTS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return parts.slice(-3).join('.');
  }
  return lastTwo;
}

export function sameSite(a, b) {
  try {
    const hostA = typeof a === 'string' ? new URL(a).hostname : a.hostname;
    const hostB = typeof b === 'string' ? new URL(b).hostname : b.hostname;
    return siteOf(hostA) === siteOf(hostB);
  } catch {
    return false;
  }
}

export function slugify(value, maxLength = 80) {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'page';
}

export function hashShort(value, length = 6) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, length);
}

export function humanBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function dateStamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/** Run `worker` over `items` with a bounded number of parallel tasks. */
export async function mapLimit(items, limit, worker) {
  const list = [...items];
  const results = new Array(list.length);
  const size = Math.max(1, Math.min(Math.floor(limit) || 1, list.length || 1));
  let cursor = 0;

  const runners = Array.from({ length: size }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(list[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const timeStamp = () => new Date().toISOString().slice(11, 19);

export function createLogger({ verbose = false } = {}) {
  return {
    info: (...args) => console.log(`[${timeStamp()}]`, ...args),
    detail: (...args) => {
      if (verbose) console.log(`[${timeStamp()}]`, ...args);
    },
    warn: (...args) => console.warn(`[${timeStamp()}] warn:`, ...args),
    error: (...args) => console.error(`[${timeStamp()}] error:`, ...args),
  };
}
