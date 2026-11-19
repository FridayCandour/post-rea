import { createPage, openPage } from './browser.mjs';
import { classifyPost, isAssetUrl, isCrawlablePage, isListingUrl, looksLikePagination } from './classify.mjs';
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

const HUB_SEGMENTS =
  /(?:^|\/)(?:blog|blogs|posts?|articles?|news|insights|stories|journal|writing|guides|learn|library|resources|categories|category|tags?|topics?|archives?)(?:\/|$)/i;

/**
 * True when `childUrl` is a sibling-depth page inside the same top-level
 * section as a hub page that links to it, e.g.
 *   /resources/categories/tools  →  /resources/tools/fcc-numbering
 *   /resources/categories/legal  →  /resources/legal/gdpr-checklist
 * Such pointers are almost always content pages even when the slug is too
 * short for the URL-only heuristics. Self-links, marketing pages and pages that
 * the classifier hard-rejects (category/tag/auth URLs) never qualify.
 */
export function isLeafUnderHub(parentUrl, childUrl) {
  try {
    const parentPath = new URL(parentUrl).pathname.replace(/\/+$/, '') || '/';
    const childPath = new URL(childUrl).pathname.replace(/\/+$/, '') || '/';
    if (parentPath === childPath) return false;

    const parentParts = parentPath.split('/').filter(Boolean);
    const childParts = childPath.split('/').filter(Boolean);
    if (!parentParts.length || childParts.length !== parentParts.length) return false;

    const parentIsHub = HUB_SEGMENTS.test(parentPath) || /\/categories?(\/|$)/i.test(parentPath);
    return parentIsHub && childParts[0] === parentParts[0];
  } catch {
    return false;
  }
}

/**
 * Breadth-first, depth-limited crawl.
 *
 * The seed page is loaded, every navigation link on it (listings, category /
 * archive hubs, pagination, landing pages) is queued, and the process repeats
 * up to `--depth` hops. Every URL that looks like a post is recorded and never
 * crawled through.
 *
 * Queue order is prioritised: pages inside the seed's own section and hub-like
 * pages are visited first, so a small `--max-pages` budget is spent where the
 * post links actually live instead of on marketing/nav pages.
 */
export async function crawlSite({ browser, seedUrl, opts, robots, log }) {
  const candidates = new Map();
  const pages = [];
  const visited = new Set();
  const page = await createPage(browser, opts);

  const maxDepth = Math.max(0, Number(opts.depth ?? 2));
  const maxPages = Math.max(1, Number(opts.maxPages) || 50);
  const seedHost = new URL(seedUrl).hostname.replace(/^www\./, '');
  const seedPath = new URL(seedUrl).pathname.replace(/\/+$/, '');

  const priorityOf = (target) => {
    let path;
    try {
      path = new URL(target).pathname.replace(/\/+$/, '') || '/';
    } catch {
      return 0;
    }
    let priority = 0;
    if (seedPath && (path === seedPath || path.startsWith(`${seedPath}/`))) priority -= 3;
    if (HUB_SEGMENTS.test(path)) priority -= 2;
    if (/\/page\/\d+$/i.test(path)) priority -= 1;
    return priority;
  };

  const queue = [];
  const enqueue = (item) => {
    const priority = priorityOf(item.url);
    let index = queue.length;
    for (let i = 0; i < queue.length; i += 1) {
      const queued = queue[i];
      const queuedPriority = priorityOf(queued.url);
      if (queuedPriority > priority || (queuedPriority === priority && queued.depth > item.depth)) {
        index = i;
        break;
      }
    }
    queue.splice(index, 0, item);
  };
  enqueue({ url: seedUrl, depth: 0 });

  /** Pages we are willing to download as posts (whole site by default). */
  const postInScope = (target) => opts.allowExternal || sameSite(target, seedUrl);

  /** Pages we are willing to load while looking for posts. */
  const crawlInScope = (target) => {
    if (opts.allowExternal) return true;
    if (opts.crawlSubdomains) return sameSite(target, seedUrl);
    try {
      return new URL(target).hostname.replace(/^www\./, '') === seedHost;
    } catch {
      return false;
    }
  };

  try {
    while (queue.length && pages.length < maxPages) {
      const { url, depth } = queue.shift();
      const key = urlKey(url);
      if (!key || visited.has(key)) continue;
      visited.add(key);

      if (!opts.ignoreRobots && !robotsAllows(robots, key, opts.userAgent)) {
        log.detail(`robots.txt disallows ${key}`);
        continue;
      }

      log.detail(`crawl d${depth} (${pages.length + 1}/${maxPages}): ${key}`);
      try {
        await openPage(page, key, opts, { idleTime: 350, idleTimeout: 3000 });
      } catch (error) {
        log.warn(`could not load ${key}: ${error.message}`);
        continue;
      }

      const links = await collectLinks(page);
      pages.push({ url: key, depth, links: links.length });
      log.detail(`  ${links.length} links on page`);

      for (const link of links) {
        const target = normalizeUrl(link.href);
        if (!target) continue;
        if (isAssetUrl(target)) continue;
        if (opts.exclude && opts.exclude.test(target.href)) continue;

        const verdict = classifyPost(target.href, link.text);
        const isPaginationLink = looksLikePagination(target.href, key, link.text);
        if (isPaginationLink && !opts.followPagination) continue;

        const isHub = isListingUrl(target) || isPaginationLink;
        const matchesInclude = !opts.include || opts.include.test(target.href);

        let score = verdict.score;
        const reasons = [...verdict.reasons];
        if (!isHub && score > -100 && score < opts.minScore && isLeafUnderHub(key, target.href)) {
          score = opts.minScore;
          reasons.push('leaf page under a hub (+boost)');
        }

        let accepted = false;
        if (matchesInclude && postInScope(target)) {
          if (isHub) accepted = false;
          else if (opts.include) accepted = true; // explicit filter bypasses scoring
          else accepted = score >= opts.minScore;
        }

        if (accepted) {
          mergeCandidate(candidates, {
            url: target.href,
            text: link.text,
            score,
            reasons,
            hits: 1,
            forced: Boolean(opts.include),
            depth,
            discoveredOn: key,
          });
          continue;
        }

        // Not a post → navigation page: recurse one level deeper.
        if (!crawlInScope(target)) continue;
        if (!isCrawlablePage(target)) continue;
        if (visited.has(target.href)) continue;

        const nextDepth = isPaginationLink ? depth : depth + 1;
        if (nextDepth > maxDepth) continue;
        if (!opts.ignoreRobots && !robotsAllows(robots, target.href, opts.userAgent)) continue;

        enqueue({ url: target.href, depth: nextDepth });
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  if (queue.length) {
    log.warn(
      `${queue.length} page(s) left unvisited because of --max-pages ${maxPages}; raise it (or --depth) to crawl further`,
    );
  }

  return { candidates: [...candidates.values()], pages };
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
