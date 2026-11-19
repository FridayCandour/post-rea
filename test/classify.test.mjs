import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyPost, isListingUrl, looksLikePagination, sectionBase } from '../src/classify.mjs';
import { normalizeUrl, sameSite, siteOf, slugify } from '../src/util.mjs';
import { isAllowedByRobots, parseRobots } from '../src/robots.mjs';
import { AssetRegistry, rewriteCssUrls } from '../src/assets.mjs';

const posts = [
  'https://example.com/blog/how-to-send-sms-without-kyc',
  'https://example.com/blog/some-post',
  'https://example.com/posts/my-first-post',
  'https://example.com/news/company-raises-funding-round',
  'https://example.com/2024/05/hello-world',
  'https://example.com/2024-05-14-hello-world',
  'https://example.com/?p=123',
  'https://example.com/blog/my-first-post.html',
  'https://example.com/my-first-post',
  'https://example.com/engineering/how-we-scaled-to-a-million-sms',
  'https://example.com/insights/the-future-of-a2p-messaging',
];

const notPosts = [
  'https://example.com/',
  'https://example.com/blog',
  'https://example.com/blog/',
  'https://example.com/blog/page/2',
  'https://example.com/blog?page=2',
  'https://example.com/category/engineering',
  'https://example.com/tag/sms',
  'https://example.com/author/jane',
  'https://example.com/about',
  'https://example.com/pricing',
  'https://example.com/contact',
  'https://example.com/privacy-policy',
  'https://example.com/blog/feed',
  'https://example.com/sitemap.xml',
  'https://example.com/assets/main.js',
  'https://example.com/wp-admin/',
  'https://example.com/login',
];

test('classifyPost accepts typical blog permalinks', () => {
  for (const url of posts) {
    const verdict = classifyPost(url);
    assert.equal(verdict.isPost, true, `${url} should be a post (score ${verdict.score}: ${verdict.reasons})`);
    assert.ok(verdict.score >= 3, `${url} score should be >= 3, got ${verdict.score}`);
  }
});

test('classifyPost rejects listing, chrome and asset URLs', () => {
  for (const url of notPosts) {
    const verdict = classifyPost(url);
    assert.equal(verdict.isPost, false, `${url} should not be a post (score ${verdict.score}: ${verdict.reasons})`);
  }
});

test('listing detection covers roots, sections and pagination', () => {
  assert.equal(isListingUrl('https://example.com/'), true);
  assert.equal(isListingUrl('https://example.com/blog'), true);
  assert.equal(isListingUrl('https://example.com/blog/page/3'), true);
  assert.equal(isListingUrl('https://example.com/news?paged=4'), true);
  assert.equal(isListingUrl('https://example.com/blog/some-post'), false);
});

test('pagination detection stays inside the same section', () => {
  assert.equal(looksLikePagination('https://example.com/blog/page/2', 'https://example.com/blog'), true);
  assert.equal(looksLikePagination('https://example.com/blog?page=2', 'https://example.com/blog'), true);
  assert.equal(looksLikePagination('https://example.com/blog/page/2', 'https://example.com/news/page/1'), false);
  assert.equal(looksLikePagination('https://example.com/blog/another-post', 'https://example.com/blog'), false);
  assert.equal(sectionBase('/blog/page/4/'), '/blog');
});

test('normalizeUrl strips tracking noise and index files', () => {
  const url = normalizeUrl('https://example.com/blog/post/?utm_source=x&b=2&a=1#comments');
  assert.equal(url.href, 'https://example.com/blog/post/?a=1&b=2');
  assert.equal(normalizeUrl('https://example.com/index.html').href, 'https://example.com/');
  assert.equal(normalizeUrl('mailto:hi@example.com'), null);
  assert.equal(normalizeUrl('not a url'), null);
});

test('sameSite handles subdomains and multi-label suffixes', () => {
  assert.equal(siteOf('blog.example.com'), 'example.com');
  assert.equal(siteOf('example.co.uk'), 'example.co.uk');
  assert.equal(siteOf('acme.github.io'), 'acme.github.io');
  assert.equal(sameSite('https://blog.example.com/x', 'https://example.com/'), true);
  assert.equal(sameSite('https://example.com/x', 'https://other.com/'), false);
});

test('slugify produces safe file names', () => {
  assert.equal(slugify('/Blog/How to Send SMS!'), 'blog-how-to-send-sms');
  assert.equal(slugify(''), 'page');
});

test('robots.txt parsing honours longest match and wildcards', () => {
  const robots = parseRobots(`
User-agent: *
Disallow: /private/
Allow: /private/public/
Disallow: /search
Sitemap: https://example.com/sitemap.xml
`);
  assert.deepEqual(robots.sitemaps, ['https://example.com/sitemap.xml']);
  assert.equal(isAllowedByRobots(robots, '/blog/post', 'test'), true);
  assert.equal(isAllowedByRobots(robots, '/private/secret', 'test'), false);
  assert.equal(isAllowedByRobots(robots, '/private/public/page', 'test'), true);
  assert.equal(isAllowedByRobots(robots, '/search?q=1', 'test'), false);
});

test('CSS url() rewriting creates tokens and reuses them', () => {
  const registry = new AssetRegistry();
  const css = rewriteCssUrls(
    'body{background:url(/img/bg.png)} .x{background:url("/img/bg.png")}',
    'https://example.com/css/site.css',
    registry,
  );
  assert.match(css, /__ARCHIVE_ASSET_0__/);
  assert.equal(registry.entries().length, 1);
  assert.equal(registry.entries()[0][1], 'https://example.com/img/bg.png');
});
