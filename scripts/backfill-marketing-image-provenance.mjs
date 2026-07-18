import { createHash } from 'node:crypto';
import nextEnv from '@next/env';
import { createClient } from '@supabase/supabase-js';

nextEnv.loadEnvConfig(process.cwd());

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const apply = process.argv.includes('--apply');
const READ_PAGE_SIZE = 1000;
const WRITE_BATCH_SIZE = 20;

if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function readAll() {
  const rows = [];
  for (let offset = 0; ; offset += READ_PAGE_SIZE) {
    const { data, error } = await db
      .from('blog_posts')
      .select('id,slug,hero_image_url,hero_image_credit,hero_image_source_url,hero_image_license,hero_image_attribution,hero_image_source_hash')
      .order('id', { ascending: true })
      .range(offset, offset + READ_PAGE_SIZE - 1);
    if (error) throw new Error(`blog_posts read failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < READ_PAGE_SIZE) return rows;
  }
}

function licenseFromCredit(credit) {
  const value = String(credit ?? '').trim().toLowerCase();
  if (!value) return null;
  if (value.includes('cc0')) return 'cc0';
  if (value.includes('public domain') || value.includes('no restrictions')) return 'public_domain';
  if (value.includes('cc by-sa')) return 'cc_by_sa';
  if (value.includes('cc by')) return 'cc_by';
  if (value.includes('unsplash')) return 'unsplash';
  if (value.includes('original')) return 'original';
  return null;
}

function provenanceFor(row) {
  const sourceUrl = String(row.hero_image_url ?? '').trim() || null;
  if (!sourceUrl) {
    return {
      hero_image_source_url: null,
      hero_image_license: null,
      hero_image_attribution: null,
      hero_image_source_hash: null,
    };
  }
  const license = licenseFromCredit(row.hero_image_credit);
  if (!/^https:\/\//i.test(sourceUrl)) throw new Error(`${row.slug}: hero image URL must use HTTPS.`);
  if (!license) throw new Error(`${row.slug}: hero image credit has no approved free-use license.`);
  const attribution = String(row.hero_image_credit ?? '').trim();
  if (!attribution) throw new Error(`${row.slug}: hero image attribution is required.`);
  return {
    hero_image_source_url: sourceUrl,
    hero_image_license: license,
    hero_image_attribution: attribution,
    hero_image_source_hash: createHash('sha256').update(sourceUrl).digest('hex'),
  };
}

const rows = await readAll();
const seen = new Map();
const updates = [];
for (const row of rows) {
  const next = provenanceFor(row);
  if (next.hero_image_source_hash) {
    const prior = seen.get(next.hero_image_source_hash);
    if (prior) throw new Error(`Duplicate blog hero image source: ${prior} and ${row.slug}.`);
    seen.set(next.hero_image_source_hash, row.slug);
  }
  const changed = Object.entries(next).some(([field, value]) => row[field] !== value);
  if (changed) updates.push({ id: row.id, slug: row.slug, ...next });
}

console.log(`Blog image provenance: ${rows.length} posts read, ${seen.size} image sources, ${updates.length} rows need normalization.`);
if (!apply) {
  console.log('Dry run only. Re-run with --apply to persist the normalized provenance fields.');
  process.exit(0);
}

for (let offset = 0; offset < updates.length; offset += WRITE_BATCH_SIZE) {
  const batch = updates.slice(offset, offset + WRITE_BATCH_SIZE);
  await Promise.all(batch.map(async ({ id, slug, ...fields }) => {
    const { error } = await db.from('blog_posts').update(fields).eq('id', id);
    if (error) throw new Error(`${slug}: provenance update failed: ${error.message}`);
  }));
  console.log(`Normalized blog image provenance ${offset + 1}-${offset + batch.length}.`);
}

console.log(`Blog image provenance applied: ${updates.length} rows normalized.`);
