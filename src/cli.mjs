import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_USER_AGENT, launchBrowser } from './browser.mjs';
import { captureMhtml, capturePage } from './archive.mjs';
import { crawlListing, mergeCandidates } from './crawler.mjs';
import { discoverFromSitemaps } from './sitemap.mjs';
import { loadRobots } from './robots.mjs';
import { buildManifest, writeOutputs } from './report.mjs';
import {
  createLogger,
  hashShort,
  humanBytes,
  mapLimit,
  normalizeUrl,
  siteOf,
  sleep,
  slugify,
} from './util.mjs';

const VERSION = '1.0.0';
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CLI_OPTIONS = {
  out: { type: 'string', short: 'o' },
  'max-posts': { type: 'string', short: 'n' },
  'max-pages': { type: 'string' },
  concurrency: { type: 'string', short: 'c' },
  delay: { type: 'string' },
  timeout: { type: 'string' },
  'min-score': { type: 'string' },
  'max-asset-mb': { type: 'string' },
  'max-sitemaps': { type: 'string' },
  include: { type: 'string' },
  exclude: { type: 'string' },
  format: { type: 'string' },
  'user-agent': { type: 'string' },
  'no-assets': { type: 'boolean' },
  'keep-scripts': { type: 'boolean' },
  'keep-clutter': { type: 'boolean' },
  'no-banner': { type: 'boolean' },
  'no-pagination': { type: 'boolean' },
  'ignore-robots': { type: 'boolean' },
  'allow-external': { type: 'boolean' },
  sitemap: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  headful: { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v' },
  version: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const HELP = `
blog-post-archiver ${VERSION}
Crawl a blog page and download every blog post it links to as a single,
self-contained HTML file (CSS inlined, images/fonts embedded, JS stripped).

USAGE
  node bin/blog-archiver.mjs <url> [options]
  npm start -- <url> [options]

EXAMPLES
  # Crawl a blog index, save up to 25 posts
  node bin/blog-archiver.mjs https://example.com/blog

  # Save 10 posts into ./archive, following pagination, all posts from sitemaps
  node bin/blog-archiver.mjs https://example.com/blog -n 10 -o ./archive --sitemap

  # See what would be downloaded without saving anything
  node bin/blog-archiver.mjs https://example.com/blog --dry-run -v

  # Slow, polite, 1-at-a-time crawl of a big site
  node bin/blog-archiver.mjs https://example.com/blog -n 200 -c 1 --delay 1500

OPTIONS
  -o, --out <dir>         output directory (default: <this folder>/downloads/<site>)
  -n, --max-posts <n>     maximum number of posts to download (default: 25)
      --max-pages <n>     listing pages to crawl for discovery (default: 10)
  -c, --concurrency <n>   parallel post downloads (default: 2)
      --delay <ms>        delay before each post request (default: 600)
      --timeout <ms>      navigation timeout (default: 45000)
      --min-score <n>     blog-post classifier threshold (default: 3)
      --max-asset-mb <n>  largest asset to inline as data URI (default: 8)
      --max-sitemaps <n>  sitemap files to read with --sitemap (default: 50)
      --include <regex>   only URLs matching this regex (bypasses scoring)
      --exclude <regex>   skip URLs matching this regex
      --sitemap           also discover posts from sitemap.xml
      --format <html|mhtml>  output format (default: html)
      --no-assets         keep image/font URLs remote instead of inlining
      --keep-scripts      do not strip <script> tags
      --keep-clutter      keep cookie/consent/popup overlays
      --no-banner         do not add the "archived from" banner
      --no-pagination     stay on the seed page only
      --ignore-robots     ignore robots.txt
      --allow-external    allow posts on other domains
      --dry-run           list detected posts, do not download
      --headful           show the browser window
  -v, --verbose           print discovery details
  -h, --help              show this help
      --version           print the version

OUTPUT
  <out>/<slug>-<hash>.html   one self-contained file per post
  <out>/index.html           local index page linking every post
  <out>/manifest.json        metadata: title, author, date, size, failures
  <out>/candidates.json      written by --dry-run

NOTES
  Only pages that look like blog posts are downloaded (scored heuristics on
  URL shape + anchor text). robots.txt is respected by default. Please respect
  each site's terms of service and copyright when archiving.
`.trim();

function printHelp() {
  console.log(HELP);
}

function numberOption(values, name, fallback, { min = 0, integer = false } = {}) {
  const raw = values[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw new Error(`--${name} must be ${integer ? 'an integer' : 'a number'} >= ${min}`);
  }
  return value;
}

function fileNameFor(candidate, format) {
  const url = new URL(candidate.url);
  const segment = decodeURIComponent(url.pathname).replace(/\/+$/, '');
  const slug = slugify(segment || url.hostname, 70);
  const extension = format === 'mhtml' ? 'mhtml' : 'html';
  return `${slug}-${hashShort(candidate.url)}.${extension}`;
}

function printCandidates(candidates, log) {
  if (!candidates.length) {
    log.warn('no blog posts detected on the seed page');
    return;
  }
  log.info('detected posts:');
  for (const candidate of candidates) {
    const flags = candidate.forced ? ' [include]' : '';
    log.info(`  ${candidate.score.toFixed(1).padStart(5)}  ${candidate.url}${flags}`);
    log.detail(`         ${candidate.reasons.join(', ')}`);
  }
}

export async function run(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: CLI_OPTIONS });
  } catch (error) {
    console.error(`error: ${error.message}\n`);
    printHelp();
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (values.help) {
    printHelp();
    return 0;
  }
  if (!positionals.length) {
    console.error('error: missing <url>\n');
    printHelp();
    return 2;
  }

  const seed = normalizeUrl(positionals[0]);
  if (!seed) {
    console.error(`error: "${positionals[0]}" is not a valid http(s) URL`);
    return 2;
  }

  const format = String(values.format || 'html').toLowerCase();
  if (format !== 'html' && format !== 'mhtml') {
    console.error('error: --format must be "html" or "mhtml"');
    return 2;
  }

  let include = null;
  let exclude = null;
  try {
    if (values.include) include = new RegExp(values.include, 'i');
    if (values.exclude) exclude = new RegExp(values.exclude, 'i');
  } catch (error) {
    console.error(`error: invalid regex: ${error.message}`);
    return 2;
  }

  const log = createLogger({ verbose: Boolean(values.verbose) });

  let config;
  try {
    config = {
      seedUrl: seed.href,
      format,
      maxPosts: numberOption(values, 'max-posts', 25, { min: 1, integer: true }),
      maxPages: numberOption(values, 'max-pages', 10, { min: 1, integer: true }),
      concurrency: numberOption(values, 'concurrency', 2, { min: 1, integer: true }),
      delay: numberOption(values, 'delay', 600, { min: 0 }),
      timeout: numberOption(values, 'timeout', 45000, { min: 1000 }),
      minScore: numberOption(values, 'min-score', 3),
      maxAssetMb: numberOption(values, 'max-asset-mb', 8, { min: 0 }),
      maxSitemaps: numberOption(values, 'max-sitemaps', 50, { min: 1, integer: true }),
      include,
      exclude,
      keepScripts: Boolean(values['keep-scripts']),
      clean: !values['keep-clutter'],
      banner: !values['no-banner'],
      followPagination: !values['no-pagination'],
      ignoreRobots: Boolean(values['ignore-robots']),
      allowExternal: Boolean(values['allow-external']),
      sitemap: Boolean(values.sitemap),
      downloadAssets: !values['no-assets'],
      dryRun: Boolean(values['dry-run']),
      headful: Boolean(values.headful),
      userAgent: values['user-agent'] || DEFAULT_USER_AGENT,
      verbose: Boolean(values.verbose),
      outDir: values.out
        ? path.resolve(process.cwd(), values.out)
        : path.join(PACKAGE_DIR, 'downloads', siteOf(seed.hostname)),
    };
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }

  log.info(`blog-post-archiver v${VERSION}`);
  log.info(`seed:   ${config.seedUrl}`);
  log.info(`output: ${config.outDir}`);

  const robots = config.ignoreRobots
    ? { groups: [], sitemaps: [], loaded: false }
    : await loadRobots(seed.origin, config.userAgent, { timeout: Math.min(config.timeout, 15000) });
  log.detail(
    robots.loaded
      ? `robots.txt: ${robots.groups.length} group(s), ${robots.sitemaps.length} sitemap(s)`
      : 'robots.txt: not available (crawl allowed)',
  );

  const browser = await launchBrowser({ headful: config.headful });
  const startedAt = new Date().toISOString();
  const posts = [];
  const failures = [];

  try {
    const discovery = await crawlListing({ browser, seedUrl: config.seedUrl, opts: config, robots, log });
    let candidates = discovery.candidates;

    if (config.sitemap) {
      const fromSitemaps = await discoverFromSitemaps({ seedUrl: config.seedUrl, robots, opts: config, log });
      candidates = mergeCandidates(candidates, fromSitemaps);
    }

    candidates.sort(
      (a, b) => Number(b.forced) - Number(a.forced) || b.score - a.score || a.url.localeCompare(b.url),
    );
    const selected = candidates.slice(0, config.maxPosts);

    log.info(`listing pages crawled: ${discovery.listings.length}`);
    if (config.include) {
      const kept = candidates.filter((candidate) => config.include.test(candidate.url)).length;
      log.detail(`include filter matched ${kept} candidate(s)`);
    }

    if (config.dryRun) {
      printCandidates(selected, log);
      await fs.mkdir(config.outDir, { recursive: true });
      const dryRunPath = path.join(config.outDir, 'candidates.json');
      await fs.writeFile(dryRunPath, `${JSON.stringify(candidates, null, 2)}\n`);
      log.info(`dry run: ${candidates.length} candidate(s) → ${dryRunPath}`);
      return 0;
    }

    if (!selected.length) {
      log.warn('no blog posts detected — try --min-score 2, --sitemap, or --include <regex>');
      return 1;
    }

    log.info(`downloading ${selected.length} post(s) with concurrency ${config.concurrency}`);
    await fs.mkdir(config.outDir, { recursive: true });

    const results = await mapLimit(selected, config.concurrency, async (candidate, index) => {
      const label = `[${index + 1}/${selected.length}]`;
      if (config.delay) await sleep(config.delay);
      log.info(`${label} ${candidate.url}`);
      try {
        const captured =
          config.format === 'mhtml'
            ? await captureMhtml(browser, candidate.url, config)
            : await capturePage(browser, candidate.url, config);

        const file = fileNameFor(candidate, config.format);
        await fs.writeFile(path.join(config.outDir, file), captured.html);
        const bytes = Buffer.byteLength(captured.html);
        log.info(
          `${label} saved ${file} (${humanBytes(bytes)}, ${captured.stats.inlined ?? 0} asset(s) inlined)`,
        );
        return { ok: true, candidate, file, bytes, meta: captured.meta, stats: captured.stats, status: captured.status };
      } catch (error) {
        log.error(`${label} failed: ${error.message}`);
        return { ok: false, candidate, error: error.message };
      }
    });

    for (const result of results) {
      if (!result) continue;
      if (result.ok) {
        posts.push({
          url: result.candidate.url,
          title: result.meta.title || result.candidate.text || result.candidate.url,
          description: result.meta.description || '',
          author: result.meta.author || '',
          publishedAt: result.meta.publishedAt || '',
          canonical: result.meta.canonical || result.candidate.url,
          siteName: result.meta.siteName || '',
          lang: result.meta.lang || '',
          wordCount: result.meta.wordCount || 0,
          file: result.file,
          format: config.format,
          bytes: result.bytes,
          httpStatus: result.status,
          stats: result.stats,
          fetchedAt: new Date().toISOString(),
        });
      } else {
        failures.push({ url: result.candidate.url, error: result.error });
      }
    }

    const timestamp = (value) => {
      const parsed = Date.parse(value || '');
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    posts.sort((a, b) => timestamp(b.publishedAt) - timestamp(a.publishedAt) || a.title.localeCompare(b.title));

    const manifest = buildManifest({
      seed: config.seedUrl,
      startedAt,
      finishedAt: new Date().toISOString(),
      posts,
      failures,
      candidates: candidates.length,
      listings: discovery.listings,
      options: {
        format: config.format,
        maxPosts: config.maxPosts,
        maxPages: config.maxPages,
        minScore: config.minScore,
        sitemap: config.sitemap,
        keepScripts: config.keepScripts,
        clean: config.clean,
        downloadAssets: config.downloadAssets,
        maxAssetMb: config.maxAssetMb,
      },
    });

    const { indexPath } = await writeOutputs(config.outDir, manifest);

    log.info(`done: ${posts.length} saved, ${failures.length} failed`);
    log.info(`browse the archive: ${indexPath}`);
    return posts.length ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
  }
}
