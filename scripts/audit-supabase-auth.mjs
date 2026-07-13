import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;

function errorSummary(body) {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    const message = parsed.msg ?? parsed.message ?? parsed.error_description ?? parsed.error;
    const id = parsed.error_id ? ` [${parsed.error_id}]` : '';
    return message ? `${String(message)}${id}` : '';
  } catch {
    return body.slice(0, 240);
  }
}

async function probe(fetchImpl, name, endpoint, key) {
  try {
    const response = await fetchImpl(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    const body = response.ok ? '' : await response.text();
    return {
      name,
      ok: response.ok,
      status: response.status,
      detail: errorSummary(body),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      status: 0,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function auditSupabaseAuth({ url, anonKey, serviceRoleKey, fetchImpl = fetch }) {
  const base = url.replace(/\/$/, '');
  return Promise.all([
    probe(fetchImpl, 'public auth health', `${base}/auth/v1/health`, anonKey),
    probe(fetchImpl, 'admin users query', `${base}/auth/v1/admin/users?page=1&per_page=1`, serviceRoleKey),
  ]);
}

loadEnvConfig(process.cwd());

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceRoleKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const results = await auditSupabaseAuth({ url, anonKey, serviceRoleKey });
for (const result of results) {
  if (result.ok) {
    console.log(`OK    ${result.name}`);
  } else {
    const status = result.status || 'network';
    console.error(`ERROR ${result.name} (HTTP ${status})${result.detail ? `: ${result.detail}` : ''}`);
  }
}

const failures = results.filter((result) => !result.ok);
if (failures.length > 0) {
  console.error(`\nAuth audit failed: ${failures.length} of ${results.length} probes failed.`);
  process.exit(1);
}

console.log(`\nAuth audit passed: ${results.length} of ${results.length} probes healthy.`);
