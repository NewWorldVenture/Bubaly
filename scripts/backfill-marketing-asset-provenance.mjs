import nextEnv from '@next/env';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

nextEnv.loadEnvConfig(process.cwd());

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const apply = process.argv.includes('--apply');

if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const hashBytes = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const hashVideoSource = (row) => createHash('sha256')
  .update(`${row.provider}:${row.video_id ?? row.storage_path ?? row.url ?? ''}`)
  .digest('hex');

const { data: assets, error: assetError } = await supabase
  .from('marketing_assets')
  .select('id,kind,name,storage_path,content_hash,license,source_url,attribution')
  .is('deleted_at', null)
  .order('created_at', { ascending: true });
if (assetError) {
  console.error(`Unable to read marketing_assets: ${assetError.message}`);
  process.exit(1);
}

const assetByStoragePath = new Map((assets ?? []).map((asset) => [asset.storage_path, asset]));

const assetUpdates = [];
const unresolvedAssets = [];
for (const asset of assets ?? []) {
  if (asset.content_hash || !asset.storage_path) {
    if (!asset.content_hash) unresolvedAssets.push(`${asset.id} (${asset.name} has no storage path)`);
    continue;
  }
  const { data: file, error: downloadError } = await supabase.storage
    .from('marketing-assets')
    .download(asset.storage_path);
  if (downloadError || !file) {
    unresolvedAssets.push(`${asset.id} (${asset.name}: ${downloadError?.message ?? 'download failed'})`);
    continue;
  }
  assetUpdates.push({ id: asset.id, hash: hashBytes(await file.arrayBuffer()), name: asset.name });
}

const { data: videos, error: videoError } = await supabase
  .from('marketing_videos')
  .select('id,title,provider,video_id,url,storage_path,source_hash,license,source_url,attribution')
  .is('deleted_at', null)
  .order('created_at', { ascending: true });
if (videoError) {
  console.error(`Unable to read marketing_videos: ${videoError.message}`);
  process.exit(1);
}

const videoUpdates = (videos ?? [])
  .map((video) => {
    const asset = video.provider === 'upload' ? assetByStoragePath.get(video.storage_path) : null;
    const hash = asset?.content_hash ?? hashVideoSource(video);
    return { id: video.id, hash, title: video.title, currentHash: video.source_hash };
  })
  .filter((video) => !video.currentHash || video.currentHash !== video.hash);

const duplicateGroups = new Map();
for (const row of [...assetUpdates, ...videoUpdates]) {
  const list = duplicateGroups.get(row.hash) ?? [];
  list.push(row.name ?? row.title ?? row.id);
  duplicateGroups.set(row.hash, list);
}
const duplicates = [...duplicateGroups.entries()].filter(([, rows]) => rows.length > 1);

console.log(`Assets needing hashes: ${assetUpdates.length}; videos needing hashes: ${videoUpdates.length}.`);
if (unresolvedAssets.length) {
  console.error('Unresolved asset files:');
  for (const item of unresolvedAssets) console.error(`- ${item}`);
}
if (duplicates.length) {
  console.error('Duplicate content/source hashes detected; no rows were updated:');
  for (const [, rows] of duplicates) console.error(`- ${rows.join(' == ')}`);
  process.exit(1);
}
if (unresolvedAssets.length) process.exit(1);

if (!apply) {
  console.log('Dry run only. Re-run with --apply to write the calculated hashes.');
  process.exit(0);
}

for (const row of assetUpdates) {
  const { error } = await supabase.from('marketing_assets').update({ content_hash: row.hash }).eq('id', row.id).is('deleted_at', null);
  if (error) throw new Error(`Failed to update asset ${row.id}: ${error.message}`);
}
for (const row of videoUpdates) {
  const { error } = await supabase.from('marketing_videos').update({ source_hash: row.hash }).eq('id', row.id).is('deleted_at', null);
  if (error) throw new Error(`Failed to update video ${row.id}: ${error.message}`);
}

console.log(`Backfilled ${assetUpdates.length + videoUpdates.length} provenance hashes.`);
