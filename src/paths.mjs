import fs from 'node:fs/promises';
import path from 'node:path';
import { hashShort, slugify } from './util.mjs';

const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_SEGMENT_LENGTH = 120;

/**
 * Turn one URL path segment into a safe directory name (works on macOS,
 * Linux and Windows, and keeps the segment readable).
 */
export function safeSegment(raw) {
  let value = String(raw ?? '');
  try {
    value = decodeURIComponent(value);
  } catch {
    /* malformed %-escapes: keep the raw text */
  }

  value = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SEGMENT_LENGTH)
    .replace(/[. ]+$/, '');

  if (!value || /^\.+$/.test(value)) return '_';
  if (RESERVED_WINDOWS_NAMES.test(value)) value = `_${value}`;
  return value;
}

/** Flat, legacy layout: `resources-code-examples-foo-1a2b3c.html`. */
export function legacyFileNameFor(rawUrl, format = 'html') {
  const url = new URL(rawUrl);
  const segment = decodeURIComponent(url.pathname).replace(/\/+$/, '');
  const slug = slugify(segment || url.hostname, 70);
  const extension = format === 'mhtml' ? 'mhtml' : format === 'md' ? 'md' : 'html';
  return `${slug}-${hashShort(rawUrl)}.${extension}`;
}

/**
 * URL → path on disk. Every path segment becomes a folder and the page itself
 * is `index.html`, so the archive mirrors the site:
 *
 *   https://site.com/resources/code-examples/foo
 *     → resources/code-examples/foo/index.html
 *
 * `used` de-duplicates URLs that collapse to the same folder (case-insensitive
 * file systems, query variants, …) by appending a short hash.
 */
export function archivePathFor(rawUrl, { format = 'html', seedHost = '', used } = {}) {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^www\./, '');
  const parts = [];

  // Posts discovered on a sibling subdomain keep their host as a folder.
  if (seedHost && host !== seedHost) parts.push(safeSegment(host));
  for (const segment of url.pathname.split('/').filter(Boolean)) {
    parts.push(safeSegment(segment));
  }
  // Distinct query strings (`?p=123`, `?page_id=4`) get their own folder.
  if (url.search) parts.push(`_q-${hashShort(url.search, 6)}`);
  if (!parts.length) parts.push('_site');

  let directory = parts.join('/');
  if (used) {
    const owner = used.get(directory.toLowerCase());
    if (owner && owner !== url.href) {
      directory = `${directory}-${hashShort(url.href, 6)}`;
    }
    used.set(directory.toLowerCase(), url.href);
  }

  const file = format === 'mhtml' ? 'index.mhtml' : format === 'md' ? 'index.md' : 'index.html';
  return `${directory}/${file}`;
}

export async function statArchive(root, relativePath) {
  try {
    const stat = await fs.stat(path.join(root, relativePath));
    return stat.size > 0 ? stat : null;
  } catch {
    return null;
  }
}

/** Move a legacy flat file into its URL-shaped folder, if present. */
export async function migrateLegacyFile(root, rawUrl, targetRelative, format = 'html') {
  const legacy = legacyFileNameFor(rawUrl, format);
  if (legacy === targetRelative) return null;
  const stat = await statArchive(root, legacy);
  if (!stat) return null;

  const target = path.join(root, targetRelative);
  if (await statArchive(root, targetRelative)) return null;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(path.join(root, legacy), target);
  return { relative: targetRelative, size: stat.size, mtime: stat.mtime };
}

const ARCHIVED_FROM = /<meta\s+name="archived-from"\s+content="([^"]+)"/i;
const META_SCAN_CHUNK = 128 * 1024;
const META_SCAN_LIMIT = 4 * 1024 * 1024;

/** Stream a saved page until the `archived-from` meta tag is found. */
async function findArchivedFrom(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(META_SCAN_CHUNK);
    let position = 0;
    let carry = '';
    while (position < META_SCAN_LIMIT) {
      const { bytesRead } = await handle.read(buffer, 0, META_SCAN_CHUNK, position);
      if (!bytesRead) break;
      const text = carry + buffer.subarray(0, bytesRead).toString('utf8');
      const match = ARCHIVED_FROM.exec(text);
      if (match) return match[1].replace(/&amp;/g, '&');
      carry = text.slice(-512);
      position += bytesRead;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * One-time reorganisation of an archive written by an older version: every
 * flat `*.html`/`*.mhtml` at the output root is moved to the folder layout
 * using the `archived-from` meta tag inside the file.
 */
export async function migrateFlatArchive(root, { format = 'html', seedHost = '', used } = {}) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }

  let moved = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:html|mhtml|md)$/i.test(entry.name)) continue;
    if (entry.name === 'index.html') continue;

    const source = path.join(root, entry.name);
    const pageUrl = await findArchivedFrom(source);
    if (!pageUrl) continue;

    const extension = entry.name.toLowerCase().split('.').pop();
    const entryFormat = extension === 'mhtml' ? 'mhtml' : extension === 'md' ? 'md' : format;

    let target;
    try {
      target = archivePathFor(pageUrl, { format: entryFormat, seedHost, used });
    } catch {
      continue;
    }
    if (await statArchive(root, target)) continue;

    const destination = path.join(root, target);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
    moved += 1;
  }
  return moved;
}

/** Recursively list archived pages (relative POSIX paths). */
export async function walkArchives(root) {
  const results = [];
  const visit = async (directory, prefix) => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name), relative);
        continue;
      }
      if (!/\.(?:html|mhtml|md)$/i.test(entry.name)) continue;
      if (!prefix && entry.name === 'index.html') continue; // the archive's own index
      results.push(relative);
    }
  };
  await visit(root, '');
  return results;
}
