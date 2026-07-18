import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and a Supabase API key are required.');
  process.exit(1);
}

const checks = [
  ['marketing_pages', '0231_marketing_platform_spine.sql'],
  ['marketing_page_versions', '0231_marketing_platform_spine.sql'],
  ['marketing_content_templates', '0231_marketing_platform_spine.sql'],
  ['marketing_brand_rules', '0231_marketing_platform_spine.sql'],
  ['marketing_generation_jobs', '0231_marketing_platform_spine.sql'],
  ['marketing_page_relationships', '0231_marketing_platform_spine.sql'],
  ['marketing_embeddings', '0231_marketing_platform_spine.sql'],
  ['marketing_provider_observations', '0231_marketing_platform_spine.sql'],
  ['marketing_provider_syncs', '0231_marketing_platform_spine.sql'],
  ['marketing_assets.provenance', '0231_marketing_platform_spine.sql', 'marketing_assets?select=content_hash,license,source_url,attribution&limit=0'],
  ['marketing_videos.provenance', '0231_marketing_platform_spine.sql', 'marketing_videos?select=source_hash,license&limit=0'],
];

const headers = { apikey: key, Authorization: `Bearer ${key}` };
const results = await Promise.all(checks.map(async ([name, migration, resource = `${name}?select=*&limit=0`]) => {
  try {
    const response = await fetch(`${url}/rest/v1/${resource}`, { headers });
    return { name, migration, status: response.status, ok: response.ok };
  } catch (error) {
    return { name, migration, status: 0, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}));

try {
  const response = await fetch(`${url}/rest/v1/marketing_pages?select=id&limit=1`, { headers });
  const body = response.ok ? await response.json() : null;
  results.push({
    name: 'marketing_pages.content',
    migration: '0231_marketing_platform_spine.sql + marketing:backfill:pages',
    status: response.status,
    ok: response.ok && Array.isArray(body) && body.length > 0,
  });
} catch (error) {
  results.push({
    name: 'marketing_pages.content',
    migration: '0231_marketing_platform_spine.sql + marketing:backfill:pages',
    status: 0,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

for (const result of results) {
  if (result.ok) console.log(`OK      ${result.name}`);
  else console.error(`MISSING ${result.name} (${result.migration}, HTTP ${result.status || 'network'})`);
}

const failures = results.filter((result) => !result.ok);
if (failures.length) {
  console.error(`\nMarketing platform verification failed: ${failures.length} schema check${failures.length === 1 ? '' : 's'} unavailable.`);
  process.exit(1);
}

console.log(`\nMarketing platform verification passed: ${results.length} checks available.`);
