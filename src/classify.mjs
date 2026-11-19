/**
 * Heuristics that decide whether a URL looks like a blog post (as opposed to a
 * listing page, a marketing page, an asset, or a paginated archive URL).
 *
 * The classifier is deliberately explainable: every score contribution is
 * recorded in `reasons` so `--verbose` output tells you *why* a link was
 * picked up or skipped.
 */

export const SECTION_WEIGHTS = {
  blog: 2.5,
  blogs: 2.5,
  post: 2.5,
  posts: 2.5,
  article: 2.5,
  articles: 2.5,
  news: 2.5,
  insights: 2.5,
  stories: 2.5,
  journal: 2.5,
  writing: 2.5,
  notes: 1.5,
  resources: 1.5,
  guides: 1.5,
  learn: 1.5,
  library: 1.5,
};

const LISTING_SECTIONS = new Set(Object.keys(SECTION_WEIGHTS));

const ASSET_EXTENSIONS =
  /\.(?:avif|bmp|css|csv|eot|gif|gz|ico|jpe?g|js|json|m4a|m4v|map|mjs|mov|mp3|mp4|mpeg|ogg|ogv|otf|pdf|png|rar|rss|svg|tar|tgz|tiff?|ttf|txt|wav|webm|webp|woff2?|xlsx?|xml|zip)$/i;

const HARD_EXCLUDE = [
  /\/wp-(?:admin|json|content|includes|login\.php)/i,
  /\/(?:feed|rss|atom)(?:\/|$)/i,
  /\/(?:search|cart|checkout|account|login|signin|sign-in|signup|register|subscribe|unsubscribe)(?:\/|$|\?)/i,
  /[?&](?:replytocom|add-to-cart|preview=true|action=|s=)/i,
  /\/(?:privacy|terms|cookies?|legal|imprint|disclaimer|contact|about|faq|support)(?:\/|$)/i,
  /\/(?:category|categories|tag|tags|author|authors|topics?|archives?)(?:\/|$)/i,
  /\/page\/\d+\/?$/i,
  /[?&](?:paged|page|pg|offset|start)=\d+/i,
  /\/(?:sitemap|robots)[^/]*$/i,
  /\/(?:cdn-cgi|assets?|static|images?|img|fonts?)\//i,
];

const DATE_IN_PATH =
  /(?:^|\/)(?:19|20)\d{2}(?:[-_/](?:0?[1-9]|1[0-2])(?:[-_/](?:0?[1-9]|[12]\d|3[01]))?)(?:[-_/]|$)/;

const PAGINATION_PATH = /\/page\/\d+\/?$/i;
const PAGINATION_QUERY = /[?&](?:paged|page|pg|offset)=\d+/i;

function safeUrl(input, base = 'https://example.invalid') {
  try {
    return new URL(input, base);
  } catch {
    return null;
  }
}

function stripExtension(segment) {
  return segment.replace(/\.(?:html?|php|aspx?|md)$/i, '');
}

function pathSegments(pathname) {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

export function isAssetUrl(input) {
  const url = input instanceof URL ? input : safeUrl(input);
  if (!url) return false;
  return ASSET_EXTENSIONS.test(url.pathname);
}

/** Root, `/page/2`, `/blog`, `/blog/category/x` ... are listings, not posts. */
export function isListingUrl(input) {
  const url = input instanceof URL ? input : safeUrl(input);
  if (!url) return true;

  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return true;
  if (PAGINATION_PATH.test(path)) return true;
  if (PAGINATION_QUERY.test(url.search)) return true;

  const segments = pathSegments(path);
  if (segments.length === 1 && LISTING_SECTIONS.has(segments[0])) return true;
  if (
    segments.length === 2 &&
    LISTING_SECTIONS.has(segments[0]) &&
    ['page', 'category', 'categories', 'tag', 'tags', 'author', 'authors', 'topic', 'topics'].includes(segments[1])
  ) {
    return true;
  }
  if (segments.length === 3 && segments[0] === 'category') return true;

  return false;
}

/**
 * @param {string|URL} input
 * @param {string} linkText anchor text, used as a weak signal
 * @returns {{isPost: boolean, score: number, reasons: string[]}}
 */
export function classifyPost(input, linkText = '') {
  const url = input instanceof URL ? input : safeUrl(input);
  if (!url) return { isPost: false, score: -100, reasons: ['invalid url'] };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { isPost: false, score: -100, reasons: ['non-http protocol'] };
  }

  const path = decodeURIComponent(url.pathname);
  const reasons = [];
  let score = 0;

  if (ASSET_EXTENSIONS.test(path)) return { isPost: false, score: -100, reasons: ['asset file'] };

  // WordPress / classic CMS single-post permalinks (?p=123, ?page_id=456).
  if (/[?&](?:p|page_id|post|story)=\d+/i.test(url.search)) {
    return { isPost: true, score: 5, reasons: ['numeric post id query (?p=)'] };
  }

  const haystack = `${path}${url.search}`;
  for (const pattern of HARD_EXCLUDE) {
    if (pattern.test(haystack)) {
      return { isPost: false, score: -100, reasons: [`excluded by ${pattern}`] };
    }
  }

  if (isListingUrl(url)) return { isPost: false, score: -100, reasons: ['listing page'] };

  const segments = pathSegments(path);
  if (segments.length === 0) return { isPost: false, score: -100, reasons: ['empty path'] };

  const section = segments.find((segment) => LISTING_SECTIONS.has(segment));
  if (section) {
    score += SECTION_WEIGHTS[section];
    reasons.push(`section:${section} (+${SECTION_WEIGHTS[section]})`);
  }

  if (DATE_IN_PATH.test(path)) {
    score += 2.5;
    reasons.push('date in path (+2.5)');
  }

  const last = stripExtension(segments.at(-1) || '');
  const words = last.split(/[-_+]+/).filter(Boolean);

  if (words.length >= 4) {
    score += 2;
    reasons.push(`slug has ${words.length} words (+2)`);
  } else if (words.length === 3) {
    score += 1.5;
    reasons.push('slug has 3 words (+1.5)');
  } else if (words.length === 2) {
    score += 0.5;
    reasons.push('slug has 2 words (+0.5)');
  } else if (last.length < 20) {
    score -= 1.5;
    reasons.push('single short segment (-1.5)');
  }

  if (last.length >= 35 && words.length >= 2) {
    score += 0.5;
    reasons.push('long slug (+0.5)');
  }

  if (segments.length === 1 && words.length >= 3) {
    score += 1.5;
    reasons.push('top-level slug (+1.5)');
  } else if (segments.length <= 3 && words.length >= 4) {
    score += 1;
    reasons.push('deep descriptive slug (+1)');
  }

  if (/-(\d{3,})(?:\.html?)?$/i.test(last)) {
    score += 0.5;
    reasons.push('numeric id suffix (+0.5)');
  }

  const text = String(linkText || '').replace(/\s+/g, ' ').trim();
  const textWords = text.split(' ').filter(Boolean).length;
  if (textWords >= 5 && text.length >= 30) {
    score += 1;
    reasons.push('descriptive anchor text (+1)');
  }
  if (/\b\d+\s*min(?:ute)?\s*read\b/i.test(text)) {
    score += 0.5;
    reasons.push('"min read" anchor text (+0.5)');
  }
  if (/^(?:read more|read the full|learn more|continue reading|click here|→|»)/i.test(text) && textWords <= 4) {
    score -= 0.5;
    reasons.push('generic anchor text (-0.5)');
  }

  return { isPost: score >= 3, score, reasons };
}

/** Strip `/page/N` and a trailing slash so sibling pages share a section prefix. */
export function sectionBase(pathname) {
  return String(pathname || '/')
    .replace(/\/page\/\d+\/?$/i, '')
    .replace(/\/+$/, '');
}

/** Detect pagination links that belong to the same listing section. */
export function looksLikePagination(rawUrl, fromUrl, linkText = '') {
  const target = safeUrl(rawUrl);
  const from = safeUrl(fromUrl);
  if (!target || !from) return false;
  if (target.origin !== from.origin) return false;

  const targetBase = sectionBase(target.pathname);
  const fromBase = sectionBase(from.pathname);
  const sameSection = targetBase === fromBase;
  const targetPath = target.pathname.replace(/\/+$/, '') || '/';
  const fromPath = from.pathname.replace(/\/+$/, '') || '/';

  const byPath = PAGINATION_PATH.test(target.pathname) && sameSection;
  const byQuery =
    PAGINATION_QUERY.test(target.search) &&
    (targetPath === fromPath || sameSection || targetBase.startsWith(fromBase));

  if (byPath || byQuery) return true;

  const label = String(linkText || '').replace(/\s+/g, ' ').trim();
  const nexty =
    /^(?:next|next page|older|older posts|older entries|previous|prev|previous page|more posts|»|›|→|‹|«)$/i.test(label) ||
    (/^(?:next|older|previous)\b/i.test(label) && label.length <= 24);

  return nexty && (PAGINATION_PATH.test(target.pathname) || PAGINATION_QUERY.test(target.search));
}
