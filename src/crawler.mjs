import { createPage, openPage } from './browser.mjs';
import { classifyPost, isAssetUrl, looksLikePagination } from './classify.mjs';
import { normalizeUrl, sameSite, urlKey } from './util.mjs';
import { robotsAllows } from './robots.mjs';

async function collectLinks(page) {
  return page.evaluate(() => {
    const links = [];
    const seen = new Set();
    const push = (href, text, rel) => {
      if (!href || seen.has(href)) return;
      seen.add(href);
      links.push({ href, text, rel });
    };

    for (const anchor of document.querySelectorAll('a[href]')) {
      const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
      const label = text || anchor.getAttribute('aria-label') || anchor.getAttribute('title') || '';
      push(anchor.href, label, anchor.getAttribute('rel') || '');
    }
    for (const link of document.querySelectorAll('link[rel="next"]')) {
      push(link.href, 'next', 'next');
    }
    return links;
  });
}

function mergeCandidate(map, record) {
  const existing = map.get(record.url);
  if (!existing) {
    map.set(record.url, record);
    return;
  }
  existing.hits += record.hits || 1;
  if (record.text && record.text.length > (existing.text || '').length) existing.text = record.text;
  if (record.score > existing.score) existing.score = record.score;
  for (const reason of record.reasons || []) {
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
  }
  if (record.forced) existing.forced = true;
}

/**
 * Crawl the seed page (and its blog pagination) and return the post URLs it
 * links to, scored by `classifyPost`.
 */
export async function crawlListing({ browser, seedUrl, opts, robots, log }) {
  const candidates = new Map();
  const listings = [];
  const visited = new Set();
  const queue = [seedUrl];
  const page = await createPage(browser, opts);

  try {
    while (queue.length && listings.length < opts.maxPages) {
      const current = queue.shift();
      const key = urlKey(current);
      if (!key || visited.has(key)) continue;
      visited.add(key);

      if (!opts.ignoreRobots && !robotsAllows(robots, key, opts.userAgent)) {
        log.detail(`robots.txt disallows ${key}`);
        continue;
      }

      log.detail(`listing ${listings.length + 1}: ${key}`);
      try {
        await openPage(page, key, opts);
      } catch (error) {
        log.warn(`could not load ${key}: ${error.message}`);
        continue;
      }

      const links = await collectLinks(page);
      listings.push({ url: key, links: links.length });
      log.detail(`  ${links.length} links on page`);

      for (const link of links) {
        const target = normalizeUrl(link.href);
        if (!target) continue;
        if (isAssetUrl(target)) continue;
        if (!opts.allowExternal && !sameSite(target, seedUrl)) continue;
        if (opts.include && !opts.include.test(target.href)) continue;
        if (opts.exclude && opts.exclude.test(target.href)) continue;

        // An explicit --include match bypasses the score threshold.
        const forced = Boolean(opts.include);
        const verdict = classifyPost(target.href, link.text);
        if (!forced && verdict.score < opts.minScore) continue;
        if (!forced && verdict.score <= -100) continue;

        mergeCandidate(candidates, {
          url: target.href,
          text: link.text,
          score: verdict.score,
          reasons: verdict.reasons,
          hits: 1,
          forced,
          discoveredOn: key,
        });
      }

      if (!opts.followPagination) continue;
      for (const link of links) {
        if (!looksLikePagination(link.href, key, link.text)) continue;
        if (!opts.allowExternal && !sameSite(link.href, seedUrl)) continue;
        const next = normalizeUrl(link.href);
        if (!next || visited.has(next.href)) continue;
        if (!opts.ignoreRobots && !robotsAllows(robots, next.href, opts.userAgent)) continue;
        queue.push(next.href);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  return { candidates: [...candidates.values()], listings };
}

/** Fold sitemap results into the crawl results without duplicating URLs. */
export function mergeCandidates(base, extra) {
  const merged = new Map();
  for (const record of [...base, ...extra]) {
    if (!merged.has(record.url)) {
      merged.set(record.url, { ...record, reasons: [...(record.reasons || [])] });
      continue;
    }
    mergeCandidate(merged, record);
  }
  return [...merged.values()];
}
