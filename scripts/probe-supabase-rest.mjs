// scripts/probe-supabase-rest.mjs — CI diagnostic for the isolated Supabase.
//
// Prints the *shape* of every exported key (never the value) and the HTTP
// status + body of PostgREST for each header combination the app and the
// audit scripts use. It never fails the job: it exists so a red
// `db:audit:schema` explains itself in the same log instead of costing
// another CI cycle. Run: node scripts/probe-supabase-rest.mjs
import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
const keys = {
  anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  service_role: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  publishable: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
  secret: process.env.SUPABASE_SECRET_KEY ?? '',
};

function shape(value) {
  if (!value) return 'EMPTY';
  const parts = value.split('.');
  if (parts.length === 3 && value.startsWith('eyJ')) {
    try {
      const decode = (s) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      const header = decode(parts[0]);
      const payload = decode(parts[1]);
      return `jwt alg=${header.alg} kid=${header.kid ?? '-'} iss=${payload.iss ?? '-'} role=${payload.role ?? '-'} aud=${payload.aud ?? '-'} exp=${payload.exp ?? '-'} len=${value.length}`;
    } catch {
      return `jwt-like but undecodable len=${value.length}`;
    }
  }
  return `${value.slice(0, 15)}… len=${value.length}`;
}

console.log(`URL: ${url || 'EMPTY'}`);
for (const [name, value] of Object.entries(keys)) console.log(`${name.padEnd(13)} ${shape(value)}`);

if (!url) { console.log('No URL — skipping probes.'); process.exit(0); }

const probes = [
  ['no headers', {}],
  ['apikey=anon', { apikey: keys.anon }],
  ['apikey=anon + bearer anon', { apikey: keys.anon, Authorization: `Bearer ${keys.anon}` }],
  ['apikey=service_role + bearer service_role', { apikey: keys.service_role, Authorization: `Bearer ${keys.service_role}` }],
  ['apikey=publishable', { apikey: keys.publishable }],
  ['apikey=publishable + bearer publishable', { apikey: keys.publishable, Authorization: `Bearer ${keys.publishable}` }],
  ['apikey=secret + bearer secret', { apikey: keys.secret, Authorization: `Bearer ${keys.secret}` }],
];
const targets = ['/rest/v1/', '/rest/v1/workload_snapshots?select=*&limit=0', '/rest/v1/families?select=id&limit=0'];

for (const target of targets) {
  console.log(`\n== ${target}`);
  for (const [label, headers] of probes) {
    if (Object.values(headers).some((v) => !v || v === 'Bearer ')) { console.log(`  ${label.padEnd(44)} skipped (key empty)`); continue; }
    try {
      const res = await fetch(`${url}${target}`, { headers });
      const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 160);
      console.log(`  ${label.padEnd(44)} ${res.status} ${body}`);
    } catch (error) {
      console.log(`  ${label.padEnd(44)} network: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
process.exit(0);
