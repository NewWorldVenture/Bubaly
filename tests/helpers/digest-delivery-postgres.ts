// A disposable PostgreSQL fixture for migration 0471 and the PostgreSQL
// DigestDeliveryStore. Opt-in: set DIGEST_DELIVERY_PG=1 with a local cluster in
// PGHOST/PGPORT/PGUSER (default: the docs/audit/verify-pg.sh harness). Without
// it these suites are SKIPPED, and say so; CI's Database job proves the same
// functions through docs/audit/an-admin-digest-reaches-each-admin-once-check.sql.
//
// Each fixture is its own database, created for the run and dropped after it:
//   1. the Supabase roles and default privileges (grant ALL on new tables and
//      functions to anon, authenticated and service_role), so 0471's revokes are
//      tested against what Supabase would actually grant;
//   2. migration 0471, exactly as committed;
//   3. admin_digest_now() replaced by a version that honours a per-session
//      `admin_digest.test_now`, so tests can move time. This replacement exists
//      only in the throwaway database.
// Calls run as `service_role`, through psql, one process per call, so
// concurrent calls are concurrent transactions on separate connections.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RpcCall } from '@/lib/admin/digest-delivery-store';

export const pgFixtureEnabled = process.env.DIGEST_DELIVERY_PG === '1';

const MIGRATION = fileURLToPath(new URL('../../supabase/migrations/0471_an_admin_digest_reaches_each_admin_once.sql', import.meta.url));

const env = () => ({
  ...process.env,
  PGHOST: process.env.PGHOST ?? '/tmp/pgaudit_db',
  PGPORT: process.env.PGPORT ?? '54399',
  PGUSER: process.env.PGUSER ?? 'postgres',
  PGOPTIONS: '',
});

/** Run SQL on stdin in one psql process; resolves to stdout (unaligned, tuples only). */
export function psql(db: string, sql: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db], { env: env(), signal: opts.signal });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePromise(out.replace(/\n$/, '')) : reject(new Error(`psql exited ${code}: ${err.trim()}`))));
    child.stdin.end(sql);
  });
}

/** A dollar-quoted literal whose tag cannot occur in the value. */
function lit(value: string): string {
  let tag: string;
  do { tag = `q${randomBytes(6).toString('hex')}`; } while (value.includes(tag));
  return `$${tag}$${value}$${tag}$`;
}

type ArgType = 'text' | 'jsonb' | 'integer' | 'bigint';
const SIGNATURES: Record<string, { returns: 'jsonb' | 'text'; args: Record<string, ArgType> }> = {
  admin_digest_freeze: { returns: 'jsonb', args: { p_occurrence: 'jsonb', p_deliveries: 'jsonb' } },
  admin_digest_load: { returns: 'jsonb', args: { p_occurrence_id: 'text' } },
  admin_digest_claim: { returns: 'jsonb', args: { p_occurrence_id: 'text', p_recipient_key: 'text', p_owner: 'text', p_lease_ms: 'integer', p_max_attempts: 'integer', p_retention_ms: 'bigint', p_margin_ms: 'bigint' } },
  admin_digest_begin_send: { returns: 'jsonb', args: { p_occurrence_id: 'text', p_recipient_key: 'text', p_fence: 'bigint', p_min_lease_ms: 'integer', p_retention_ms: 'bigint', p_margin_ms: 'bigint' } },
  admin_digest_complete: { returns: 'text', args: { p_occurrence_id: 'text', p_recipient_key: 'text', p_fence: 'bigint', p_result: 'jsonb', p_max_attempts: 'integer' } },
};

function arg(name: string, type: ArgType, value: unknown): string {
  if (type === 'jsonb') return `${lit(JSON.stringify(value))}::jsonb`;
  if (type === 'text') {
    if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
    return `${lit(value)}::text`;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(`${name} must be an integer`);
  return `${value}::${type}`;
}

export type PgFixture = {
  db: string;
  /** SQL as the superuser that owns the fixture (setup, inspection, fault injection). */
  sql(text: string): Promise<string>;
  /** The adapter's transport: named-argument calls as `service_role`, at `now` when given. */
  rpc(now?: () => Date): RpcCall;
  /** Empty both tables (TRUNCATE fires no row trigger; only the fixture owner can do it). */
  reset(): Promise<void>;
  drop(): Promise<void>;
};

export async function createPgFixture(): Promise<PgFixture> {
  const db = `digest_delivery_${process.pid}_${randomBytes(4).toString('hex')}`;
  await psql('postgres', `create database ${db};`);
  const sql = (text: string) => psql(db, text);
  await sql(`
    do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  await sql(readFileSync(MIGRATION, 'utf8'));
  await sql(`
    create or replace function public.admin_digest_now()
    returns timestamptz language sql volatile set search_path = public, pg_temp
    as $$ select coalesce(nullif(current_setting('admin_digest.test_now', true), '')::timestamptz, clock_timestamp()) $$;
  `);
  return {
    db,
    sql,
    rpc: (now) => async (fn, args) => {
      const sig = SIGNATURES[fn];
      if (!sig) throw new Error(`unknown function ${fn}`);
      const named = Object.entries(sig.args).map(([k, t]) => `${k} => ${arg(k, t, args[k])}`).join(', ');
      const pin = now ? `set admin_digest.test_now = ${lit(now().toISOString())};\n` : '';
      const out = await psql(db, `${pin}set role service_role;\nselect public.${fn}(${named})::text;`);
      if (sig.returns === 'text') return out;
      return out === '' ? null : JSON.parse(out);
    },
    reset: async () => { await sql('truncate public.admin_digest_deliveries, public.admin_digest_occurrences;'); },
    drop: async () => { await psql('postgres', `drop database if exists ${db} with (force);`); },
  };
}
