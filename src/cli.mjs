import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_USER_AGENT, launchBrowser } from './browser.mjs';
import { captureMhtml, capturePage } from './archive.mjs';
import { crawlSite, mergeCandidates } from './crawler.mjs';
import { discoverFromSitemaps } from './sitemap.mjs';
import { loadRobots } from './robots.mjs';
import { buildManifest, writeOutputs } from './report.mjs';
import { AssetCache } from './assets.mjs';
import {
  createLogger,
  humanBytes,
  mapLimit,
  normalizeUrl,
  siteOf,
  sleep,
} from './util.mjs';
import {
  archivePathFor,
  legacyFileNameFor,
  migrateFlatArchive,
  migrateLegacyFile,
  statArchive,
  walkArchives,
} from './paths.mjs';

const VERSION = '1.0.0';
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CLI_OPTIONS = {
  out: { type: 'string', short: 'o' },
  'max-posts': { type: 'string', short: 'n' },
  'max-pages': { type: 'string' },
  depth: { type: 'string', short: 'd' },
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
  'crawl-subdomains': { type: 'boolean' },
  sitemap: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  'load-media': { type: 'boolean' },
  force: { type: 'boolean' },
  flat: { type: 'boolean' },
  headful: { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v' },
  version: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const HELP = `
blog-post-archiver ${VERSION}
Recursively crawl a blog/resources page (following category and archive hubs up
to --depth hops) and download every blog post it can reach as a single,
self-contained HTML file (CSS inlined, images/fonts embedded, JS stripped).

USAGE
  node bin/blog-archiver.mjs <url> [options]
  npm start -- <url> [options]

EXAMPLES
  # Crawl a blog index recursively (seed → hubs → posts)
  node bin/blog-archiver.mjs https://example.com/blog

  # Deeper resources site: 3 hops, 150 pages of discovery, up to 500 posts
  node bin/blog-archiver.mjs https://example.com/resources -d 3 --max-pages 150 -n 500

  # Save 10 posts into ./archive, following pagination, all posts from sitemaps
  node bin/blog-archiver.mjs https://example.com/blog -n 10 -o ./archive --sitemap

  # See what would be downloaded without saving anything
  node bin/blog-archiver.mjs https://example.com/blog --dry-run -v

  # Slow, polite, 1-at-a-time crawl of a big site
  node bin/blog-archiver.mjs https://example.com/blog -n 200 -c 1 --delay 1500

OPTIONS
  -o, --out <dir>         output directory (default: <this folder>/downloads/<site>)
  -n, --max-posts <n>     maximum number of posts to download (default: 25)
      --max-pages <n>     pages to load while discovering posts (default: 50)
  -d, --depth <n>         how many link hops to follow from the seed (default: 2)
      --crawl-subdomains  let the crawl walk into sibling subdomains
  -c, --concurrency <n>   parallel post downloads (default: 4)
      --delay <ms>        delay before each post request (default: 250)
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
      --load-media        let the browser download images/fonts (slower)
      --force             re-download posts already present in the output dir
      --flat              flat file names instead of URL-shaped folders
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
  Existing posts in <out>/ are skipped on the next run (use --force to rebuild
  them), so an interrupted archive can simply be run again. The browser never
  downloads images, fonts or media — the archiver fetches those itself — which
  makes captures roughly 3x faster.
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

function printCandidates(candidates, log, pathFor) {
  if (!candidates.length) {
    log.warn('no blog posts detected on the seed page');
    return;
  }
  log.info('detected posts:');
  for (const candidate of candidates) {
    const flags = candidate.forced ? ' [include]' : '';
    const depth = `d${candidate.depth ?? 0}`;
    log.info(`  ${candidate.score.toFixed(1).padStart(5)}  ${depth}  ${candidate.url}${flags}`);
    const target = pathFor ? ` → ${pathFor(candidate.url)}` : '';
    log.detail(`         ${candidate.reasons.join(', ')}${target}`);
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

  if (positionals.length > 1) {
    log.warn(`ignoring extra arguments: ${positionals.slice(1).join(' ')}`);
  }

  let config;
  try {
    config = {
      seedUrl: seed.href,
      format,
      maxPosts: numberOption(values, 'max-posts', 25, { min: 1, integer: true }),
      maxPages: numberOption(values, 'max-pages', 50, { min: 1, integer: true }),
      depth: numberOption(values, 'depth', 2, { min: 0, integer: true }),
      concurrency: numberOption(values, 'concurrency', 4, { min: 1, integer: true }),
      delay: numberOption(values, 'delay', 250, { min: 0 }),
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
      crawlSubdomains: Boolean(values['crawl-subdomains']),
      sitemap: Boolean(values.sitemap),
      downloadAssets: !values['no-assets'],
      dryRun: Boolean(values['dry-run']),
      loadMedia: Boolean(values['load-media']),
      force: Boolean(values.force),
      flat: Boolean(values.flat),
      seedHost: seed.hostname.replace(/^www\./, ''),
      assetCache: new AssetCache(),
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

  // URL-shaped folders; `--flat` keeps the legacy slug-hash file names.
  const usedPaths = new Map();
  const pathFor = (rawUrl) =>
    config.flat
      ? legacyFileNameFor(rawUrl, config.format)
      : archivePathFor(rawUrl, { format: config.format, seedHost: config.seedHost, used: usedPaths });

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
  let posts = [];
  const failures = [];

  try {
    const discovery = await crawlSite({ browser, seedUrl: config.seedUrl, opts: config, robots, log });
    let candidates = discovery.candidates;

    if (config.sitemap) {
      const fromSitemaps = await discoverFromSitemaps({ seedUrl: config.seedUrl, robots, opts: config, log });
      candidates = mergeCandidates(candidates, fromSitemaps);
    }

    candidates.sort(
      (a, b) =>
        Number(b.forced) - Number(a.forced) ||
        b.score - a.score ||
        (a.depth ?? 0) - (b.depth ?? 0) ||
        a.url.localeCompare(b.url),
    );
    const selected = candidates.slice(0, config.maxPosts);

    log.info(`pages crawled: ${discovery.pages.length} (depth ≤ ${config.depth})`);
    if (discovery.pages.length) {
      const byDepth = new Map();
      for (const page of discovery.pages) byDepth.set(page.depth, (byDepth.get(page.depth) || 0) + 1);
      log.detail(
        `depth breakdown: ${[...byDepth.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([depth, count]) => `d${depth}=${count}`)
          .join(', ')}`,
      );
    }
    log.info(`post candidates: ${candidates.length}`);
    if (config.include) {
      const kept = candidates.filter((candidate) => config.include.test(candidate.url)).length;
      log.detail(`include filter matched ${kept} candidate(s)`);
    }

    if (config.dryRun) {
      printCandidates(selected, log, pathFor);
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

    // Reorganise pages written by older versions (flat files → URL folders).
    if (!config.flat) {
      const moved = await migrateFlatArchive(config.outDir, {
        format: config.format,
        seedHost: config.seedHost,
        used: usedPaths,
      });
      if (moved) log.info(`reorganized ${moved} existing page(s) into URL folders`);
    }

    // Resume: reuse posts already archived by a previous run unless --force.
    const previousPosts = new Map();
    if (!config.force) {
      try {
        const prior = JSON.parse(await fs.readFile(path.join(config.outDir, 'manifest.json'), 'utf8'));
        for (const post of prior.posts || []) {
          if (post && post.url && post.file) previousPosts.set(post.url, post);
        }
      } catch {
        /* first run, nothing to resume */
      }
    }
    if (previousPosts.size) log.detail(`resume: ${previousPosts.size} post(s) already in the archive`);

    // Follow a reorganisation: manifest entries may still point at old flat
    // file names, so re-resolve them against the URL-shaped layout.
    if (!config.flat && previousPosts.size) {
      let remapped = 0;
      for (const post of previousPosts.values()) {
        if (!post.url) continue;
        const target = pathFor(post.url);
        if (target !== post.file && (await statArchive(config.outDir, target))) {
          post.file = target;
          remapped += 1;
        }
      }
      if (remapped) log.detail(`resume: updated ${remapped} manifest path(s) to the folder layout`);
    }
    let cached = 0;
    let downloaded = 0;

    const results = await mapLimit(selected, config.concurrency, async (candidate, index) => {
      const label = `[${index + 1}/${selected.length}]`;
      const file = pathFor(candidate.url);

      if (!config.force) {
        const prior = previousPosts.get(candidate.url);
        let existing = (await statArchive(config.outDir, file)) ? file : null;

        if (!existing && prior?.file && (await statArchive(config.outDir, prior.file))) {
          existing = prior.file;
        }
        if (!existing && !config.flat) {
          const migrated = await migrateLegacyFile(config.outDir, candidate.url, file, config.format);
          if (migrated) {
            log.detail(`${label} reorganized → ${migrated.relative}`);
            existing = migrated.relative;
          }
        }

        if (existing) {
          const stat = await statArchive(config.outDir, existing);
          log.detail(`${label} cached ${existing}`);
          return {
            ok: true,
            cached: true,
            post:
              prior && prior.file === existing
                ? prior
                : {
                    url: candidate.url,
                    title: prior?.title || candidate.text || candidate.url,
                    description: prior?.description || '',
                    publishedAt: prior?.publishedAt || '',
                    file: existing,
                    format: config.format,
                    bytes: stat.size,
                    fetchedAt: stat.mtime.toISOString(),
                    stats: prior?.stats || {},
                  },
          };
        }
      }

      if (config.delay) await sleep(config.delay);
      log.info(`${label} ${candidate.url}`);
      try {
        const captured =
          config.format === 'mhtml'
            ? await captureMhtml(browser, candidate.url, config)
            : await capturePage(browser, candidate.url, config);

        const destination = path.join(config.outDir, file);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, captured.html);
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
      if (result.cached) {
        cached += 1;
        posts.push(result.post);
        continue;
      }
      if (result.ok) {
        downloaded += 1;
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
    // Merge every post already in the archive so a partial/resumed run still
    // produces a complete index: manifest entries first, then any stray files.
    const merged = new Map();
    for (const post of posts) merged.set(post.url || `file:${post.file}`, post);
    for (const prior of previousPosts.values()) {
      if (prior.url && !merged.has(prior.url)) merged.set(prior.url, prior);
    }
    try {
      const knownFiles = new Set([...merged.values()].map((post) => post.file).concat('index.html'));
      for (const relative of await walkArchives(config.outDir)) {
        if (knownFiles.has(relative)) continue;
        const stat = await statArchive(config.outDir, relative);
        if (!stat) continue;
        const parts = relative.split('/');
        const fallbackTitle = parts.length > 1 ? parts[parts.length - 2] : parts[parts.length - 1];
        merged.set(`file:${relative}`, {
          url: '',
          title: String(fallbackTitle).replace(/[-_]+/g, ' '),
          file: relative,
          format: relative.toLowerCase().endsWith('.mhtml') ? 'mhtml' : 'html',
          bytes: stat.size,
          fetchedAt: stat.mtime.toISOString(),
          stats: {},
          recovered: true,
        });
      }
    } catch {
      /* no output dir yet */
    }
    posts = [...merged.values()];

    posts.sort((a, b) => timestamp(b.publishedAt) - timestamp(a.publishedAt) || a.title.localeCompare(b.title));
    const recovered = posts.filter((post) => post.recovered).length;

    const manifest = buildManifest({
      seed: config.seedUrl,
      startedAt,
      finishedAt: new Date().toISOString(),
      posts,
      failures,
      candidates: candidates.length,
      pages: discovery.pages,
      run: { downloaded, cached, recovered },
      options: {
        format: config.format,
        maxPosts: config.maxPosts,
        maxPages: config.maxPages,
        depth: config.depth,
        minScore: config.minScore,
        sitemap: config.sitemap,
        crawlSubdomains: config.crawlSubdomains,
        keepScripts: config.keepScripts,
        clean: config.clean,
        downloadAssets: config.downloadAssets,
        maxAssetMb: config.maxAssetMb,
      },
    });

    const { indexPath } = await writeOutputs(config.outDir, manifest);

    log.info(
      `done: ${downloaded} downloaded, ${cached} cached, ${recovered} recovered from disk, ${failures.length} failed`,
    );
    log.info(`browse the archive: ${indexPath}`);
    return posts.length ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
  }
}
