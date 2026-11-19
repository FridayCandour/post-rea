import { classifyPost } from './classify.mjs';
import { normalizeUrl, sameSite } from './util.mjs';

const LOC_PATTERN = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

function decodeXml(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function fetchText(url, userAgent, timeout) {
  const response = await fetch(url, {
    headers: { 'user-agent': userAgent, accept: 'application/xml,text/xml,*/*' },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  });
  if (!response.ok) return null;
  return response.text();
}

/**
 * Optional extra discovery: read sitemaps (announced in robots.txt or at the
 * usual WordPress paths) and keep whichever URLs look like blog posts.
 * This is how you get *every* post on a blog whose index only shows 10.
 */
export async function discoverFromSitemaps({ seedUrl, robots, opts, log }) {
  const seed = new URL(seedUrl);
  const queue = [];
  const seen = new Set();
  const candidates = [];

  for (const sitemap of robots?.sitemaps || []) queue.push(sitemap);
  queue.push(new URL('/sitemap.xml', seed.origin).href);
  queue.push(new URL('/sitemap_index.xml', seed.origin).href);
  queue.push(new URL('/wp-sitemap.xml', seed.origin).href);

  let files = 0;
  const maxFiles = Math.max(1, Number(opts.maxSitemaps) || 50);

  while (queue.length && files < maxFiles) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || seen.has(sitemapUrl)) continue;
    seen.add(sitemapUrl);
    files += 1;

    let xml = null;
    try {
      xml = await fetchText(sitemapUrl, opts.userAgent, opts.timeout);
    } catch {
      xml = null;
    }
    if (!xml) continue;

    const isIndex = /<sitemapindex/i.test(xml);
    for (const match of xml.matchAll(LOC_PATTERN)) {
      const location = decodeXml(match[1]);
      if (isIndex) {
        queue.push(location);
        continue;
      }

      const url = normalizeUrl(location);
      if (!url) continue;
      if (!opts.allowExternal && !sameSite(url, seedUrl)) continue;
      if (opts.exclude && opts.exclude.test(url.href)) continue;
      if (opts.include && !opts.include.test(url.href)) continue;

      const verdict = classifyPost(url.href);
      if (verdict.score <= -100) continue;
      if (verdict.score < opts.minScore) continue;

      candidates.push({
        url: url.href,
        text: '',
        score: verdict.score,
        reasons: [...verdict.reasons, 'from sitemap'],
        hits: 1,
        forced: false,
        discoveredOn: sitemapUrl,
      });
    }
  }

  log.detail(`sitemaps: scanned ${files} file(s), found ${candidates.length} post candidate(s)`);
  return candidates;
}
