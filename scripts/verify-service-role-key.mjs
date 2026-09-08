// Does this deployment's service-role key actually work?
//
// Written after production spent an unknown stretch serving an admin console
// that could read nothing. /api/health reported "ok" throughout, because
// checkRequiredEnv tests that SUPABASE_SERVICE_ROLE_KEY is PRESENT and both of
// its probes send the ANON key — so a present-but-rejected service-role key was
// invisible until a human opened /admin and saw an empty dashboard.
//
// Run this BEFORE deploying a key, not after:
//
//   node scripts/verify-service-role-key.mjs                  # key from .env
//   SUPABASE_SERVICE_ROLE_KEY=… node scripts/verify-service-role-key.mjs
//
// The key is never printed — only its format, and whether each service took it.
import nextEnv from '@next/env';
import {
  describeKey, FORMAT_LABEL, projectScheme, schemeMismatch, isCredentialRejection,
} from './lib/service-key-format.mjs';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const rawKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url) { console.error('NEXT_PUBLIC_SUPABASE_URL is not set.'); process.exit(2); }
if (!rawKey) { console.error('SUPABASE_SERVICE_ROLE_KEY is not set.'); process.exit(2); }

async function probe(name, path, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${url}${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    return { name, ok: res.ok, status: res.status, detail: res.ok ? '' : (await res.text()).slice(0, 200) };
  } catch (err) {
    return { name, ok: false, status: 0, detail: err?.message ?? 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

const key = rawKey.trim();
const described = describeKey(rawKey);

console.log(`Project : ${url}`);
console.log(`Key     : ${FORMAT_LABEL[described.format]}, ${described.length} chars`);
if (described.untrimmed) {
  console.log('  ! The value has leading/trailing whitespace. Supabase rejects it as-is.');
}

const scheme = projectScheme(anonKey);
if (scheme) {
  console.log(`Project uses ${scheme} keys (read from the public publishable key).`);
  const mismatch = schemeMismatch(anonKey, described.format);
  if (mismatch) {
    console.log(`  ! MISMATCH: project is on ${mismatch.project} keys, service key is ${mismatch.key}.`);
    console.log('    Copy the matching key from Supabase → Project Settings → API.');
  }
}

const results = await Promise.all([
  probe('PostgREST (data)', '/rest/v1/', key),
  probe('Storage', '/storage/v1/bucket', key),
  probe('Auth admin', '/auth/v1/admin/users?page=1&per_page=1', key),
]);

console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  → ${r.status || 'no response'} ${r.detail}`}`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length === 0) {
  console.log('\nEvery service accepted this key. /admin will read normally.');
  process.exit(0);
}

console.log('');
if (isCredentialRejection(failed.map((r) => r.detail))) {
  console.log('Supabase rejected the KEY itself, not the query.');
  console.log('Set SUPABASE_SERVICE_ROLE_KEY to this project’s current service key:');
  console.log('  Supabase → Project Settings → API → Secret keys');
  console.log('  Vercel   → Settings → Environment Variables → Production → redeploy');
} else {
  console.log('The key was accepted somewhere but a service still failed — see above.');
}
process.exit(1);
