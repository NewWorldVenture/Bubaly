// Verify that shipped marketing raster assets are byte-unique and that source
// code does not introduce unreviewed remote image URLs. Supabase uploads are
// protected separately by marketing_assets.content_hash + license columns.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const assetExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);
const sourceRoots = ['app', 'components', 'lib'];
const remoteImagePattern = /https?:\/\/[^'"`\s)]+\.(?:png|jpe?g|webp|gif|avif)(?:\?[^'"`\s)]*)?/gi;
const allowedProviderHosts = new Set(['img.youtube.com', 'i.ytimg.com']);

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else out.push(path);
  }
  return out;
}

const publicFiles = await walk(join(root, 'public'));
const images = publicFiles.filter((path) => assetExtensions.has(extname(path).toLowerCase()));
const byHash = new Map();
for (const path of images) {
  const hash = createHash('sha256').update(await fs.readFile(path)).digest('hex');
  const list = byHash.get(hash) ?? [];
  list.push(relative(root, path));
  byHash.set(hash, list);
}
const duplicates = [...byHash.values()].filter((paths) => paths.length > 1);
if (duplicates.length) {
  console.error('Duplicate shipped image content detected:');
  for (const paths of duplicates) console.error(`- ${paths.join(' == ')}`);
  process.exit(1);
}

const remoteImages = [];
for (const sourceRoot of sourceRoots) {
  const files = await walk(join(root, sourceRoot));
  for (const path of files.filter((file) => /\.(?:ts|tsx|js|jsx|css)$/.test(file))) {
    const source = await fs.readFile(path, 'utf8');
    for (const match of source.matchAll(remoteImagePattern)) {
      try {
        if (!allowedProviderHosts.has(new URL(match[0]).hostname)) remoteImages.push({ path: relative(root, path), url: match[0] });
      } catch { remoteImages.push({ path: relative(root, path), url: match[0] }); }
    }
  }
}
if (remoteImages.length) {
  console.error('Unreviewed remote marketing image URLs detected:');
  for (const image of remoteImages) console.error(`- ${image.path}: ${image.url}`);
  process.exit(1);
}

console.log(`Marketing asset audit passed: ${images.length} unique shipped raster assets; no remote image URLs.`);
