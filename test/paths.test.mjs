import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { archivePathFor, legacyFileNameFor, safeSegment, walkArchives, migrateFlatArchive } from '../src/paths.mjs';

test('archivePathFor mirrors URL segments as folders', () => {
  assert.equal(
    archivePathFor('https://site.com/resources/code-examples/foo', { seedHost: 'site.com' }),
    'resources/code-examples/foo/index.html',
  );
  assert.equal(archivePathFor('https://site.com/blog/post/', { seedHost: 'site.com' }), 'blog/post/index.html');
  assert.equal(
    archivePathFor('https://site.com/resources/code-examples/foo', { seedHost: 'site.com', format: 'mhtml' }),
    'resources/code-examples/foo/index.mhtml',
  );
});

test('archivePathFor keeps other hosts, queries and missing paths distinct', () => {
  assert.equal(
    archivePathFor('https://blog.site.com/post', { seedHost: 'site.com' }),
    'blog.site.com/post/index.html',
  );
  assert.match(archivePathFor('https://site.com/?p=123', { seedHost: 'site.com' }), /^_q-[0-9a-f]{6}\/index\.html$/);
  assert.equal(archivePathFor('https://site.com/', { seedHost: 'site.com' }), '_site/index.html');
});

test('archivePathFor avoids folder collisions between urls', () => {
  const used = new Map();
  const first = archivePathFor('https://site.com/blog/post', { seedHost: 'site.com', used });
  const second = archivePathFor('https://site.com/Blog/Post', { seedHost: 'site.com', used });
  assert.equal(first, 'blog/post/index.html');
  assert.notEqual(second, first);
  assert.match(second, /^Blog\/Post-[0-9a-f]{6}\/index\.html$/);
});

test('safeSegment neutralises unsafe path segments', () => {
  assert.equal(safeSegment('..'), '_');
  assert.equal(safeSegment('a/b\\c'), 'a-b-c');
  assert.equal(safeSegment('CON'), '_CON');
  assert.equal(safeSegment('what?'), 'what-');
  assert.equal(safeSegment('trailing.'), 'trailing');
  assert.equal(safeSegment('%20'), '_');
  assert.equal(safeSegment('hello%20world'), 'hello world');
  assert.ok(safeSegment('x'.repeat(400)).length <= 120);
});

test('legacyFileNameFor keeps the old flat naming', () => {
  assert.match(legacyFileNameFor('https://site.com/blog/hello-world'), /^blog-hello-world-[0-9a-f]{6}\.html$/);
  assert.match(legacyFileNameFor('https://site.com/blog/hello-world', 'mhtml'), /\.mhtml$/);
});

test('walkArchives finds nested pages but not the archive index', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bpa-walk-'));
  await fs.mkdir(path.join(root, 'blog', 'post'), { recursive: true });
  await fs.mkdir(path.join(root, 'blog', 'other'), { recursive: true });
  await fs.writeFile(path.join(root, 'index.html'), '<html></html>');
  await fs.writeFile(path.join(root, 'manifest.json'), '{}');
  await fs.writeFile(path.join(root, 'blog', 'post', 'index.html'), '<html></html>');
  await fs.writeFile(path.join(root, 'blog', 'other', 'index.mhtml'), 'MIME');

  const found = (await walkArchives(root)).sort();
  assert.deepEqual(found, ['blog/other/index.mhtml', 'blog/post/index.html']);
  await fs.rm(root, { recursive: true, force: true });
});

test('migrateFlatArchive moves legacy files into url folders', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bpa-migrate-'));
  const url = 'https://site.com/resources/tools/fcc-numbering';
  const legacy = legacyFileNameFor(url);
  await fs.writeFile(
    path.join(root, legacy),
    `<!DOCTYPE html><html><head><meta name="archived-from" content="${url}"></head><body>archived</body></html>`,
  );

  const moved = await migrateFlatArchive(root, { seedHost: 'site.com' });
  assert.equal(moved, 1);
  const target = path.join(root, 'resources', 'tools', 'fcc-numbering', 'index.html');
  const html = await fs.readFile(target, 'utf8');
  assert.match(html, /archived/);
  await assert.rejects(fs.stat(path.join(root, legacy)));

  await fs.rm(root, { recursive: true, force: true });
});
