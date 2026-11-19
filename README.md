# post-rea

Point it at a blog page → it finds the blog posts linked from that page → it
saves **each post as one self-contained `.html` file** that looks exactly like
the original when opened offline.

- **Crawls** the seed page and follows blog pagination (`/blog/page/2`,
  `?paged=2`, "Older posts"…), so a 10-post index still yields the whole blog.
- **Detects posts** with explainable URL/anchor heuristics (skips categories,
  tags, authors, feeds, assets, pricing/about pages…).
- **Inlines everything** into the HTML: stylesheets (including `@import`
  chains), web fonts, images, background images, `srcset`, icons — all as
  `data:` URIs. No broken CSS or missing pictures offline.
- Removes JavaScript (keeps JSON-LD), rewrites links to absolute URLs, adds a
  provenance banner + `<meta name="archived-from">`.
- Writes a local `index.html` and a `manifest.json` (title, author, date,
  word count, size, failures).

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

Output goes to `<this folder>/downloads/<site>/` (or `--out <dir>`):

```
downloads/example.com/
├── index.html                                  ← browse the archive
├── manifest.json                               ← metadata + failures
├── how-to-send-sms-without-kyc-1a2b3c.html
└── the-future-of-a2p-messaging-9f8e7d.html
```

## Options

```
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
-v, --verbose           print discovery details and score reasons
-h, --help              show help
    --version           print version
```

## Recipes

```bash
# See what would be downloaded, with reasons for every score
node bin/blog-archiver.mjs https://example.com/blog --dry-run -v

# Archive the complete blog (sitemap discovery + pagination, 200 posts)
node bin/blog-archiver.mjs https://example.com/blog -n 200 --sitemap -c 2

# Only posts about SMS deliverability (case-insensitive regex, no slashes needed)
node bin/blog-archiver.mjs https://example.com/blog --include 'deliverab|dlt|a2p' -n 50

# Skip changelogs and release notes
node bin/blog-archiver.mjs https://example.com/blog --exclude 'release|changelog'

# Fast, small files (leave large media remote)
node bin/blog-archiver.mjs https://example.com/blog --no-assets

# Bullet-proof fallback: Chrome's own single-file snapshot
node bin/blog-archiver.mjs https://example.com/blog --format mhtml

# Debug a stubborn site in a visible browser
node bin/blog-archiver.mjs https://example.com/blog --headful -v -n 1
```

Only pages that are *detected* as posts are downloaded. If a site uses unusual
URLs, `--dry-run -v` shows the exact score/reasons, and `--include` /
`--min-score` let you tune it.

## How it works

1. **Discovery** (`src/crawler.mjs`)
   Launches headless Chrome with CSP bypass, loads the seed page, collects every
   `<a href>`, and follows pagination links that stay inside the same blog
   section (bounded by `--max-pages`). Optional `--sitemap` adds every URL from
   `robots.txt` sitemaps, `/sitemap.xml`, `/sitemap_index.xml` and
   `/wp-sitemap.xml`.

2. **Classification** (`src/classify.mjs`)
   Each link is scored: section (`/blog`, `/news`, `/insights`…), date in path
   (`/2024/05/…`), slug length/word count, numeric IDs (`?p=123`), anchor text.
   Hard negatives kill categories, tags, authors, feeds, pagination, auth,
   legal, and asset URLs. Score ≥ `--min-score` (3) ⇒ post. Every contribution
   is printed with `-v`.

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
   bytes, asset counters, failures) plus a styled `index.html` to click through
   the archive.

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
- Pages that render content only after interaction (tabs, accordions) are
  captured in their initial state.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `no blog posts detected` | Try `--dry-run -v`, lower `--min-score 2`, or `--sitemap` |
| Only 10 posts saved | Increase `--max-pages`, or add `--sitemap` |
| Chrome not found | `npx puppeteer browsers install chrome` |
| Post stops rendering early | Re-run just that URL with `--headful -v` |
| Files are too big | `--no-assets`, `--max-asset-mb 2`, or `--max-asset-mb 0` |
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
src/browser.mjs         Puppeteer page setup, autoscroll
src/robots.mjs          robots.txt parsing/matching
src/sitemap.mjs         sitemap discovery
src/report.mjs          manifest + index.html
```
