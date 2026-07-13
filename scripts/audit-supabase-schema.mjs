import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;

loadEnvConfig(process.cwd());

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required.');
  process.exit(1);
}

const expected = [
  ['workload_snapshots', '0174_workload_snapshots.sql'],
  ['independence_milestones', '0175_independence_milestones.sql'],
  ['money_timeline_insights', '0168_money_timeline_insights.sql'],
  ['paperwork_items', '0169_paperwork_items.sql'],
  ['contact_interactions', '0170_contact_interactions.sql'],
  ['crm_contact_profile', '0171_crm_contact_profile.sql'],
  ['crm_lead_scores', '0172_crm_lead_scores.sql'],
  ['marketplace_circles', '0176_marketplace_circles.sql'],
];

const results = await Promise.all(expected.map(async ([table, migration]) => {
  try {
    const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=0`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    return { table, migration, status: response.status, ok: response.ok };
  } catch (error) {
    return {
      table,
      migration,
      status: 0,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}));

for (const result of results) {
  if (result.ok) {
    console.log(`OK      ${result.table}`);
  } else if (result.status === 404) {
    console.error(`MISSING ${result.table} (${result.migration})`);
  } else {
    console.error(`ERROR   ${result.table} (HTTP ${result.status || 'network'})${result.error ? `: ${result.error}` : ''}`);
  }
}

const failures = results.filter((result) => !result.ok);
if (failures.length > 0) {
  console.error(`\nSchema audit failed: ${failures.length} required table${failures.length === 1 ? '' : 's'} unavailable.`);
  process.exit(1);
}

console.log(`\nSchema audit passed: ${results.length} required tables available.`);
