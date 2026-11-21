import fs from 'node:fs/promises';
import path from 'node:path';
import { escapeHtml, humanBytes } from './util.mjs';

export function buildManifest({ seed, startedAt, finishedAt, posts, failures, candidates, pages, options }) {
  return {
    generator: 'blog-post-archiver',
    version: '1.0.0',
    seed,
    startedAt,
    finishedAt,
    counts: {
      candidates: candidates ?? posts.length + failures.length,
      posts: posts.length,
      downloaded: posts.filter((post) => !post.recovered).length,
      recovered: posts.filter((post) => post.recovered).length,
      failed: failures.length,
      pagesCrawled: Array.isArray(pages) ? pages.length : 0,
    },
    options,
    posts,
    failures,
    pages: Array.isArray(pages) ? pages : [],
  };
}

function renderIndex(manifest) {
  const rows = manifest.posts
    .map((post) => {
      const date = post.publishedAt ? String(post.publishedAt).slice(0, 10) : '—';
      const title = escapeHtml(post.title || post.url || post.file);
      let host = post.siteName || '';
      if (!host && post.url) {
        try {
          host = new URL(post.url).hostname;
        } catch {
          host = '';
        }
      }
      const source = post.url
        ? `<a class="source" href="${escapeHtml(post.url)}" title="Original URL">source</a>`
        : '';
      const meta = [host, humanBytes(post.bytes), post.wordCount ? `${post.wordCount} words` : '']
        .filter(Boolean)
        .join(' · ');
      return `      <li>
        <a class="post" href="./${encodeURI(post.file)}">
          <span class="date">${escapeHtml(date)}</span>
          <span class="title">${title}</span>
          <span class="meta">${escapeHtml(meta)}</span>
        </a>
        ${source}
      </li>`;
    })
    .join('\n');

  const failureRows = (manifest.failures || [])
    .map((failure) => `      <li><a href="${escapeHtml(failure.url)}">${escapeHtml(failure.url)}</a> — ${escapeHtml(failure.error)}</li>`)
    .join('\n');

  const seedHost = escapeHtml(new URL(manifest.seed).hostname);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blog archive — ${seedHost}</title>
<style>
  :root { color-scheme: light dark; --fg:#111827; --muted:#6b7280; --bg:#ffffff; --card:#f9fafb; --line:#e5e7eb; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e5e7eb; --muted:#9ca3af; --bg:#0b1220; --card:#111a2b; --line:#1f2a3d; --accent:#60a5fa; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:2.5rem 1.25rem 4rem; background:var(--bg); color:var(--fg); font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 .35rem; letter-spacing:-.02em; }
  .sub { color: var(--muted); font-size: .9rem; margin: 0 0 2rem; }
  .sub a { color: var(--accent); text-decoration: none; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: stretch; gap: .5rem; border:1px solid var(--line); background:var(--card); border-radius: 10px; margin-bottom: .6rem; }
  a.post { flex: 1; display: grid; grid-template-columns: 6.5rem 1fr; grid-template-areas: "date title" "date meta"; gap:.15rem 1rem; padding: .8rem 1rem; text-decoration: none; color: inherit; }
  a.post:hover .title { color: var(--accent); }
  .date { grid-area: date; color: var(--muted); font-variant-numeric: tabular-nums; font-size: .85rem; padding-top:.15rem; }
  .title { grid-area: title; font-weight: 600; }
  .meta { grid-area: meta; color: var(--muted); font-size: .82rem; }
  a.source { display:flex; align-items:center; padding: 0 1rem; color: var(--muted); font-size:.78rem; text-decoration:none; border-left:1px solid var(--line); }
  a.source:hover { color: var(--accent); }
  h2 { font-size: 1rem; margin: 2.25rem 0 .75rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
  .failures li { display:block; padding: .6rem .9rem; font-size:.85rem; overflow-wrap:anywhere; }
  .failures a { color: var(--accent); text-decoration:none; }
  @media (max-width: 620px) { a.post { grid-template-columns: 1fr; grid-template-areas: "title" "meta"; } .date { display:none; } }
</style>
</head>
<body>
<main>
  <h1>Blog archive — ${seedHost}</h1>
  <p class="sub">
    ${manifest.counts.posts} post(s) saved from <a href="${escapeHtml(manifest.seed)}">${escapeHtml(manifest.seed)}</a>
    · archived ${escapeHtml(String(manifest.finishedAt).slice(0, 10))}
    · ${manifest.counts.failed} failure(s)
  </p>
  <ul>
${rows || '      <li><a class="post" href="./">No posts were downloaded.</a></li>'}
  </ul>
${failureRows ? `  <h2>Failures</h2>\n  <ul class="failures">\n${failureRows}\n  </ul>\n` : ''}</main>
</body>
</html>
`;
}

export async function writeOutputs(outDir, manifest) {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, 'index.html'), renderIndex(manifest));
  return {
    manifestPath: path.join(outDir, 'manifest.json'),
    indexPath: path.join(outDir, 'index.html'),
  };
}
