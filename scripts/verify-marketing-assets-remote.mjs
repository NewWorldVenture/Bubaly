import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const headers = { apikey: key, Authorization: `Bearer ${key}` };
const getRows = async (resource, label) => {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const separator = resource.includes('?') ? '&' : '?';
    const response = await fetch(`${url}/rest/v1/${resource}${separator}limit=1000&offset=${offset}`, { headers });
    if (!response.ok) {
      console.error(`${label} query failed (HTTP ${response.status}). Apply migrations 0231 and 0232 first.`);
      process.exit(1);
    }
    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
};

const assets = await getRows(
  'marketing_assets?select=id,name,kind,content_hash,license,source_url,attribution&deleted_at=is.null&order=created_at.asc',
  'marketing_assets',
);
const videos = await getRows(
  'marketing_videos?select=id,title,provider,url,storage_path,source_hash,license,source_url,attribution&deleted_at=is.null&order=created_at.asc',
  'marketing_videos',
);
const blogs = await getRows(
  'blog_posts?select=id,slug,published,hero_image_url,hero_image_source_url,hero_image_license,hero_image_attribution,hero_image_source_hash&hero_image_url=not.is.null&order=id.asc',
  'blog_posts',
);

const failures = [];
const seen = new Map();
const seenBlogSources = new Map();
const approvedBlogLicenses = new Set(['cc0', 'public_domain', 'cc_by', 'cc_by_sa', 'unsplash', 'original']);
for (const asset of assets) {
  if (!asset.content_hash) failures.push(`asset ${asset.name ?? asset.id} has no content_hash`);
  if (!asset.license) failures.push(`asset ${asset.name ?? asset.id} has no license`);
  if (asset.license !== 'original' && (!asset.source_url || !asset.attribution)) {
    failures.push(`asset ${asset.name ?? asset.id} needs source_url and attribution for license ${asset.license}`);
  }
  if (asset.content_hash) {
    const prior = seen.get(asset.content_hash);
    if (prior) failures.push(`duplicate asset hash: ${prior} == ${asset.name ?? asset.id}`);
    else seen.set(asset.content_hash, asset.name ?? asset.id);
  }
}
for (const blog of blogs) {
  const label = `blog ${blog.slug ?? blog.id}`;
  const sourceUrl = typeof blog.hero_image_source_url === 'string' ? blog.hero_image_source_url.trim() : '';
  const imageUrl = typeof blog.hero_image_url === 'string' ? blog.hero_image_url.trim() : '';
  if (!/^https:\/\//i.test(imageUrl)) failures.push(`${label} has a non-HTTPS hero image URL`);
  if (!sourceUrl || sourceUrl !== imageUrl) failures.push(`${label} has incomplete hero image source provenance`);
  if (!approvedBlogLicenses.has(blog.hero_image_license)) failures.push(`${label} has an unapproved hero image license`);
  if (!blog.hero_image_attribution) failures.push(`${label} has no hero image attribution`);
  if (!blog.hero_image_source_hash) failures.push(`${label} has no hero image source hash`);
  const prior = seenBlogSources.get(sourceUrl);
  if (prior) failures.push(`duplicate blog hero image source: ${prior} == ${blog.slug ?? blog.id}`);
  else if (sourceUrl) seenBlogSources.set(sourceUrl, blog.slug ?? blog.id);
}
for (const video of videos) {
  if (!video.source_hash) failures.push(`video ${video.title ?? video.id} has no source_hash`);
  if (!video.license) failures.push(`video ${video.title ?? video.id} has no license`);
  if (video.provider !== 'upload' && !(video.source_url || video.url)) failures.push(`video ${video.title ?? video.id} has no source URL`);
  if (video.license !== 'embedded_source' && (!video.source_url || !video.attribution)) {
    failures.push(`video ${video.title ?? video.id} needs source_url and attribution for license ${video.license}`);
  }
  if (video.source_hash) {
    const prior = seen.get(video.source_hash);
    if (prior) failures.push(`duplicate media hash: ${prior} == ${video.title ?? video.id}`);
    else seen.set(video.source_hash, video.title ?? video.id);
  }
}

if (failures.length) {
  console.error(`Remote marketing asset verification failed: ${failures.length} issue${failures.length === 1 ? '' : 's'}.`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Remote marketing asset verification passed: ${assets.length} assets, ${videos.length} videos, and ${blogs.length} blog hero images are attributed and unique.`);
