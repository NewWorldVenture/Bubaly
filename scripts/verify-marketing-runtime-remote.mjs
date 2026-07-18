import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const strict = process.argv.includes('--strict');
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const headers = { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' };

function countFromRange(value) {
  const match = /\/(\d+|\*)$/.exec(value ?? '');
  return match && match[1] !== '*' ? Number(match[1]) : 0;
}

async function count(resource, label) {
  const response = await fetch(`${url}/rest/v1/${resource}`, { headers });
  if (!response.ok) throw new Error(`${label} query failed (HTTP ${response.status}).`);
  return countFromRange(response.headers.get('content-range'));
}

async function readProviders() {
  const response = await fetch(`${url}/rest/v1/marketing_provider_syncs?select=provider,status,rows_imported,last_completed_at,last_error&order=provider`, { headers });
  if (!response.ok) throw new Error(`provider sync query failed (HTTP ${response.status}).`);
  return response.json();
}

try {
  const jobStatuses = ['queued', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled'];
  const embeddingStatuses = ['ready', 'queued', 'failed', 'stale'];
  const [publishedPages, providerRows, jobCounts, embeddingCounts] = await Promise.all([
    count('marketing_pages?select=id&status=eq.published&deleted_at=is.null&limit=1', 'published pages'),
    readProviders(),
    Promise.all(jobStatuses.map(async (status) => [status, await count(`marketing_generation_jobs?select=id&status=eq.${status}&limit=1`, `jobs.${status}`)])),
    Promise.all(embeddingStatuses.map(async (status) => [status, await count(`marketing_embeddings?select=id&status=eq.${status}&limit=1`, `embeddings.${status}`)])),
  ]);

  const jobs = Object.fromEntries(jobCounts);
  const embeddings = Object.fromEntries(embeddingCounts);
  const pending = jobs.queued + jobs.running;
  const providerWarnings = providerRows.filter((row) => row.status !== 'connected').map((row) => `${row.provider}: ${row.status}`);
  const warnings = [];
  if (pending > 0) warnings.push(`marketing generation queue has ${pending.toLocaleString()} pending job${pending === 1 ? '' : 's'}`);
  if (publishedPages > 0 && embeddings.ready === 0) warnings.push('no ready marketing vector chunks are persisted');
  if (providerWarnings.length) warnings.push(`provider readiness: ${providerWarnings.join(', ')}`);

  console.log(`Marketing runtime: ${publishedPages.toLocaleString()} published pages, ${pending.toLocaleString()} pending jobs, ${embeddings.ready.toLocaleString()} ready vector chunks.`);
  for (const warning of warnings) console.warn(`WARN ${warning}`);

  if (strict && warnings.length) {
    console.error(`Marketing runtime strict verification failed: ${warnings.length} issue${warnings.length === 1 ? '' : 's'}.`);
    process.exit(1);
  }
  console.log(`Marketing runtime verification ${strict ? 'passed' : 'completed with truthful warnings'}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
