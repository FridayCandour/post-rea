# post-rea

Point it at a blog page → it **recursively crawls** that page (and its category /
archive / pagination hubs) → it saves **each post as one self-contained `.html`
file** that looks exactly like the original when opened offline.

- **Recursive crawl** (breadth-first, `--depth` hops, `--max-pages` budget):
  follows listings, category/tag hubs, archives and pagination, so posts buried
  two or three clicks deep are found — not just the links on the seed page.
- **Detects posts** with explainable URL/anchor heuristics (skips categories,
  tags, authors, feeds, assets, pricing/about pages…) plus a "leaf under hub"
  rule for resources sites whose article slugs are too short to score.
- **Inlines everything** into the HTML: stylesheets (including `@import`
  chains), web fonts, images, background images, `srcset`, icons — all as
  `data:` URIs. No broken CSS or missing pictures offline.
- **Or `--md`**: extract just the article and save it as clean, GitHub-flavored
  Markdown with YAML front matter (no HTML chrome, no assets to download).
- Removes JavaScript (keeps JSON-LD), rewrites links to absolute URLs, adds a
  provenance banner + `<meta name="archived-from">`.
- Writes a local `index.html` and a `manifest.json` (title, author, date,
  word count, size, crawled pages, failures).

## Requirements

- Node.js ≥ 20
- Chrome/Chromium for Puppeteer (auto-downloaded on `npm install`)

This folder lives inside the smsroute repo, which already depends on
`puppeteer` and has a Chrome build in `~/.cache/puppeteer`, so you can run it
straight away from the repo root. To use it elsewhere:

```bash
cd post-rea
npm install
```

## Quick start

```bash
# from the repo root
node post-rea/bin/blog-archiver.mjs https://example.com/blog

# or from this folder
npm start -- https://example.com/blog
```

Output goes to `<this folder>/downloads/<site>/` (or `--out <dir>`) and mirrors
the site's URL structure — every path segment becomes a folder and each page is
its `index.html`:

```
downloads/example.com/
├── index.html                                   ← browse the archive
├── manifest.json                                ← metadata + failures
├── blog/
│   ├── how-to-send-sms-without-kyc/
│   │   └── index.html
│   └── the-future-of-a2p-messaging/
│       └── index.html
└── resources/
    └── code-examples/
        └── vonage-node-js-express-marketing-campaigns/
            └── index.html
```

Rules used when mapping a URL to disk:

| URL | Path |
| --- | --- |
| `https://site.com/resources/tools/foo` | `resources/tools/foo/index.html` |
| `https://site.com/blog/post/` | `blog/post/index.html` |
| `https://site.com/?p=123` | `_q-1a2b3c/index.html` (query gets a folder) |
| `https://blog.site.com/post` (seed `site.com`) | `blog.site.com/post/index.html` |
| `https://site.com/` | `_site/index.html` |

Segments are decoded and sanitised (`?`, `:`, `/`, control chars, Windows
reserved names, trailing dots, length > 120), and two URLs that collapse to the
same folder get a short hash suffix so nothing is overwritten. Use `--flat` for
the old flat `slug-hash.html` naming. With `--md` each page is `index.md`
instead of `index.html`.

Archives written by older versions (flat files) are reorganised automatically on
the next run: each file's `archived-from` meta tag is read and the file is moved
into its folder. Saved pages now keep that meta tag as the **first** element of
`<head>` so the mapping is always cheap to recover.

## Options

```
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
    --format <html|mhtml|md>  output format (default: html)
    --md                shorthand for --format md (article as Markdown)
    --no-assets         keep image/font URLs remote instead of inlining
    --keep-scripts      do not strip <script> tags
    --keep-clutter      keep cookie/consent/popup overlays
    --no-banner         do not add the "archived from" banner
    --no-pagination     do not follow pagination links
    --ignore-robots     ignore robots.txt
    --allow-external    allow posts on other domains
    --dry-run           list detected posts, do not download
    --load-media        let the browser download images/fonts (slower)
    --force             re-download posts already present in the output dir
    --flat              flat file names instead of URL-shaped folders
    --headful           show the browser window
-v, --verbose           print discovery details and score reasons
-h, --help              show help
    --version           print version
```

## Recipes

```bash
# See what would be downloaded, with reasons and depth for every candidate
node bin/blog-archiver.mjs https://example.com/blog --dry-run -v

# Recursive resources-site crawl: seed → category hubs → articles (3 hops)
node bin/blog-archiver.mjs https://example.com/resources --depth 3 --max-pages 150 -n 500

# Whole blog, including posts only reachable through sitemaps
node bin/blog-archiver.mjs https://example.com/blog -n 200 --sitemap -c 2

# Seed page only, no recursion at all
node bin/blog-archiver.mjs https://example.com/blog --depth 0

# Only posts about SMS deliverability (case-insensitive regex, no slashes needed)
node bin/blog-archiver.mjs https://example.com/blog --include 'deliverab|dlt|a2p' -n 50

# Skip changelogs and release notes
node bin/blog-archiver.mjs https://example.com/blog --exclude 'release|changelog'

# Fast, small files (leave large media remote)
node bin/blog-archiver.mjs https://example.com/blog --no-assets

# Bullet-proof fallback: Chrome's own single-file snapshot
node bin/blog-archiver.mjs https://example.com/blog --format mhtml

# Markdown instead of HTML (front matter + article body, images stay remote)
node bin/blog-archiver.mjs https://example.com/blog --md -n 50

# Markdown for one page, flat naming
node bin/blog-archiver.mjs https://example.com/blog/post-slug --md --depth 0 --flat

# Debug a stubborn site in a visible browser
node bin/blog-archiver.mjs https://example.com/blog --headful -v -n 1
```

Only pages that are *detected* as posts are downloaded; every other in-scope
page is treated as navigation and walked through. If a site uses unusual URLs,
`--dry-run -v` shows the exact score/reasons/depth, and `--include` /
`--min-score` let you tune it. When the crawl stops because of `--max-pages`
it tells you how many pages were left unvisited.

### Recursive crawl details

- **`--depth`** counts link hops from the seed: the seed is `d0`, pages it links
  to are `d1`, their children `d2`, and so on. Pagination never consumes depth
  (`/blog/page/2` stays at the same level as `/blog`).
- **Never recurses into posts**: once a page looks like a post it is downloaded
  and its links are ignored, so the crawl does not wander through
  related-post sidebars.
- **Scope**: navigation stays on the seed host by default. Posts may live on any
  subdomain of the same site (e.g. `blog.example.com`). Use
  `--crawl-subdomains` to also walk through sibling subdomains, or
  `--allow-external` to drop the scope limit entirely.
- **Priority**: pages inside the seed's section and hub-like pages (categories,
  archives, blog/news/resources/guides…) are visited first, so a small
  `--max-pages` budget is spent where post links actually live.
- **Leaf under hub**: when a hub page links to a sibling-depth page in its own
  section (e.g. `/resources/categories/tools` → `/resources/tools/fcc-numbering`),
  that page is treated as a post even if its slug is too short for the
  URL-only heuristics.

## How it works

1. **Recursive discovery** (`src/crawler.mjs`)
   Launches headless Chrome with CSP bypass, loads the seed page, and performs a
   breadth-first walk: every in-scope navigation link (listings, category/tag
   hubs, archives, pagination, landing pages) is queued and visited up to
   `--depth` hops or `--max-pages` pages. Links that look like posts are
   recorded and never crawled through. Optional `--sitemap` adds every URL from
   `robots.txt` sitemaps, `/sitemap.xml`, `/sitemap_index.xml` and
   `/wp-sitemap.xml`.

2. **Classification** (`src/classify.mjs` + crawl context)
   Each link is scored: section (`/blog`, `/news`, `/insights`…), date in path
   (`/2024/05/…`), slug length/word count, numeric IDs (`?p=123`), anchor text.
   Hard negatives kill categories, tags, authors, feeds, pagination, auth,
   legal, and asset URLs. Pages linked from a hub at the same depth get a
   "leaf" boost. Score ≥ `--min-score` (3) ⇒ post. Every contribution is
   printed with `-v`.

3. **Snapshot** (`src/archive.mjs` + `src/assets.mjs`)
   The page is scrolled (to trigger lazy images), fonts are awaited, then the
   DOM is rewritten in-page:
   - every image/`srcset`/poster/icon/`object[data]` becomes a token,
     `__ARCHIVE_ASSET_<n>__`, with the absolute URL recorded;
   - every `<link rel=stylesheet>` becomes a `<style>` token;
   - every inline `<style>` / `style="…"` that mentions `url()` is handed to
     Node.

   Node then downloads the stylesheets (resolving `@import` recursively), turns
   every CSS `url()` into a token, fetches all unique assets once, and replaces
   tokens with `data:` URIs. Assets larger than `--max-asset-mb`, or that fail,
   keep their original absolute URL so the page degrades gracefully.

4. **Cleanup**
   `script` tags are removed (JSON-LD is preserved), as are preloads, CSP metas
   and `<noscript>` duplicates. Links are absolutised, cookie/consent overlays
   are dropped (`--keep-clutter` keeps them), and archived metadata is added.

5. **Report** (`src/report.mjs`)
   `manifest.json` (title, author, published date, canonical URL, word count,
   bytes, asset counters, crawled pages with their depth, failures) plus a
   styled `index.html` to click through the archive.

## Markdown output (`--md`)

`--md` (or `--format md`) skips the HTML snapshot entirely: it finds the main
article container, strips navigation / share / cookie chrome, and saves the
content as GitHub-flavored Markdown.

```
downloads/example.com/blog/post-slug/index.md
```

```markdown
---
title: "Build an Appointment Scheduler with SMS Reminders Using RedwoodJS and Vonage"
source: "https://example.com/resources/code-examples/vonage-redwoodjs-scheduler"
canonical: "https://www.example.com/resources/code-examples/vonage-redwoodjs-scheduler"
published: "2025-05-03T00:31:58.667+00:00"
description: "Learn how to build a full-stack appointment scheduling application…"
site: "Sent Resources"
lang: "en"
archived: "2026-11-21T08:24:02.434Z"
words: 6225
---

# Build an Appointment Scheduler with SMS Reminders Using RedwoodJS and Vonage

Intro paragraph with **bold text** and a [link](https://example.com).

## Prerequisites

- Node.js 22
- A Vonage API key

![Screenshot of the scheduler](https://example.com/img/scheduler.png)
```

What the extractor does:

- **Container detection**: `<article>`, `<main>`, `[itemprop=articleBody]` and
  common content classes (`.post-content`, `.entry-content`, `.prose`, …),
  scored by text length minus link density, with `<main>`/`<body>` fallback.
- **Cleanup**: drops nav/footer/aside/forms, share/related/newsletter/comments
  blocks, cookie banners, hidden nodes, and "12 min read" by-lines.
- **Structure kept**: headings, paragraphs, nested ordered/unordered lists, GFM
  tables, blockquotes, fenced code blocks with their language tag, figures
  (image + italic caption), `<hr>`, and inline bold/italic/strikethrough/code/links.
- **URLs** are absolutised, so the Markdown works in any viewer. Images are
  **not** downloaded — with `--md` there is no asset pass at all.
- **Front matter** keys: `title`, `source`, `canonical`, `author`, `published`,
  `description`, `site`, `lang`, `archived`, `words`.

Markdown is the fastest mode (~1–2 s per page) and still writes
`manifest.json` + the browsable `index.html`.

## Speed

Captures are dominated by page load and asset fetching, not by disk. The
archiver is tuned for large archives:

- **The browser never downloads images, fonts or media.** The archiver fetches
  those itself in Node, so captures drop from ~10 s to ~1.3 s on heavy
  Next.js sites. Use `--load-media` if a site builds its DOM from images that
  must actually load (rare).
- **Analytics / tag-manager / session-replay hosts are aborted**, so the network
  settles in ~350 ms instead of burning the full idle timeout.
- **Cross-page asset cache**: stylesheets and web fonts are downloaded once per
  run and reused by every post (256 MB in-memory cap, large media excluded).
- **Scrolling is conditional**: it only runs when JS-driven lazy images exist;
  `data-src` / `loading="lazy"` markup is resolved directly by the archiver.
- **Document assembly uses two regex passes** instead of one pass per asset, so
  a 1.7 MB page is no longer copied ~30 times.
- **Post-level concurrency defaults to 4** (`-c 8` for a fast site).

Measured on `example.com/resources`: ~14 s/post before → **~1.3 s/post** at
`-c 4` with a warm cache (8 posts in 10 s), so 1,500 posts take roughly half an
hour instead of two.

### Resuming

Re-running the same command skips every post whose file already exists in the
output directory; use `--force` to capture them again. An interrupted archive
resumes where it stopped, and `manifest.json` / `index.html` are rebuilt from
every file in the output directory — including pages left behind by an older
run that never wrote a manifest. Flat files from older versions are moved into
their URL folders during the same run.

## Respectful crawling

- `robots.txt` is fetched once and honoured (disallow rules are skipped).
- One request at a time by default with `--delay 600`; keep `-c` small.
- The bot identifies itself through a normal Chrome UA and always writes
  `archived-from` metadata into saved pages.

Archiving is your responsibility: check the site's terms and the applicable
copyright rules before redistributing what you save.

## Limitations

- **"Load more" / infinite scroll** driven by JS is not clicked; only real links
  are followed. Seed the archive page directly, or use `--sitemap`.
- **Crawl budget**: recursion stops at `--depth` hops or `--max-pages` loaded
  pages. Deeply nested sites need both raised (`--depth 4 --max-pages 400`); the
  tool prints how many pages it left unvisited.
- **Host scope**: by default only the seed host is walked (posts on sibling
  subdomains are still downloaded). Sites that keep their article list on
  `docs.example.com` while the seed is `www.example.com` need
  `--crawl-subdomains`.
- **Marketing pages** reachable from the header are crawled too once the blog
  hubs are exhausted; they cost pages but do not produce posts.
- **Login walls, paywalls, bot challenges** (Cloudflare Turnstile, hCaptcha) are
  not bypassed. `--headful` helps you see what happened.
- **Iframes and video streams** keep their absolute URLs (a YouTube embed will
  not play offline). Everything visual — images, fonts, backgrounds — is
  inlined.
- **SVG sprite sheets** referenced via `<use href="sprite.svg#icon">` are
  absolutised but not inlined.
- Very heavy pages produce large files: a typical WordPress post lands around
  3–6 MB with all images and fonts embedded. Use `--no-assets` or a lower
  `--max-asset-mb` for a lighter archive.
- **Images are not loaded by the browser**, so `srcset` selection falls back to
  the `src` (or first `srcset`) candidate. Width/height markup keeps the layout
  correct; use `--load-media` if you need the exact variant a visitor would get.
- Pages that render content only after interaction (tabs, accordions) are
  captured in their initial state.
- **`--md` is a content extractor, not an exporter**: anything the site renders
  without real text (interactive widgets, lazy-loaded comment threads) is
  skipped, and article images stay as remote URLs so the Markdown remains
  readable and small.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `no blog posts detected` | Try `--dry-run -v`, lower `--min-score 2`, raise `--depth`, or `--sitemap` |
| Only the seed page's posts found | Raise `--depth` (default 2) and `--max-pages` |
| Crawl stops early ("N pages left unvisited") | Raise `--max-pages` (and/or `--depth`) |
| Chrome not found | `npx puppeteer browsers install chrome` |
| Post stops rendering early | Re-run just that URL with `--headful -v` |
| Files are too big | `--no-assets`, `--max-asset-mb 2`, or `--max-asset-mb 0` |
| Too slow | Raise `-c` (default 4), run in batches — re-runs skip finished posts |
| A page looks unstyled / images missing | Re-run that URL with `--headful -v`; try `--load-media` |
| Styles look wrong | `--format mhtml` produces Chrome's native single-file snapshot |

## Development

```bash
npm test          # node:test — classifier, URL, robots and CSS unit tests
node --test --watch
```

Layout:

```
bin/blog-archiver.mjs   CLI entry point
src/cli.mjs             argument parsing + orchestration
src/crawler.mjs         link discovery + pagination
src/classify.mjs        blog-post heuristics
src/archive.mjs         in-page DOM freeze + token assembly
src/assets.mjs          asset fetcher, registry, CSS inlining
src/extract.mjs         article extraction + --md capture
src/markdown.mjs        block tree → GitHub-flavored Markdown
src/paths.mjs           URL → folder layout, legacy migration
src/browser.mjs         Puppeteer page setup, autoscroll, resource blocking
src/robots.mjs          robots.txt parsing/matching
src/sitemap.mjs         sitemap discovery
src/report.mjs          manifest + index.html
```
