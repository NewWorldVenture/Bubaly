// Disposable PostgreSQL only. No connection URLs, credentials or hosted targets.
// Actual schedule helper + source 0006 trigger + reserved 0488; the CAS SQL below
// is handwritten. This is not SDK/PostgREST/RLS or production acceptance.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [mode, target, port, executable, database, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0, 'Unexpected target arguments');
let command, connection, expectedDataDirectory;
function run(program, args, input) {
  const environment = { ...process.env, PGCONNECT_TIMEOUT: '3' };
  for (const key of ['PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGPASSWORD', 'PGPASSFILE']) delete environment[key];
  const result = spawnSync(program, args, {
    encoding: 'utf8', input, timeout: 30_000, maxBuffer: 2_000_000,
    env: environment,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || 'Synthetic subprocess failed');
  return result.stdout.trim();
}
if (mode === '--docker') {
  assert.equal(port, undefined, 'Docker mode accepts only its own container name');
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.match(process.env.GITHUB_RUN_ID ?? '', /^\d+$/);
  assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^\d+$/);
  assert.equal(target, `bubaly-bill-anchor-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
  const [container] = JSON.parse(run('docker', ['inspect', '--type', 'container', target]));
  assert.equal(container.Config.Image, 'postgres:17');
  assert.equal(container.Config.Labels['bubaly.bill-anchor-fixture'], 'true');
  assert.equal(container.HostConfig.NetworkMode, 'none');
  assert.equal(container.HostConfig.LogConfig.Type, 'none');
  assert.equal(container.State.Running, true);
  // postgres:17 declares its own anonymous data volume. Refuse host binds or
  // any additional mount; cleanup removes this container's anonymous volume.
  assert.equal(container.Mounts.length, 1);
  assert.equal(container.Mounts[0].Type, 'volume');
  assert.equal(container.Mounts[0].Destination, '/var/lib/postgresql/data');
  assert.ok(Object.values(container.NetworkSettings.Ports ?? {}).every(value => value === null));
  command = 'docker';
  connection = ['exec', '-i', target, 'psql', '-h', '/var/run/postgresql', '-U', 'postgres', '-d', 'bubaly_bill_anchor_ci'];
} else {
  assert.equal(mode, '--local', 'Use --docker own-container or --local own-temp-data-dir port psql database');
  assert.match(port ?? '', /^\d{5}$/);
  assert.ok(Number(port) >= 49152 && Number(port) <= 65535, 'Local probe requires a high loopback port');
  assert.match(database ?? '', /^bubaly_bill_anchor_ci(?:_[a-z0-9]+)?$/);
  expectedDataDirectory = realpathSync(target);
  const withinTemp = relative(realpathSync(tmpdir()), expectedDataDirectory);
  assert.ok(!withinTemp.startsWith('..') && !withinTemp.startsWith(sep));
  assert.match(withinTemp.replaceAll('\\', '/'), /^bubaly-bill-anchor-gate-[a-f0-9]{32}\/data$/);
  command = realpathSync(executable);
  assert.match(command, /(?:^|[\\/])psql(?:\.exe)?$/i);
  connection = ['-h', '127.0.0.1', '-p', port, '-U', 'billprobe', '-d', database];
}
const pg = sql => run(command, [...connection, '-X', '--no-password', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql);
// Read-only identity checks precede every fixture DDL statement.
const identity = JSON.parse(pg(`select json_build_object('database', current_database(), 'version', current_setting('server_version_num'), 'directory', current_setting('data_directory'), 'address', inet_server_addr(), 'port', inet_server_port(), 'tables', (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','f')));`));
assert.match(identity.database, /^bubaly_bill_anchor_ci(?:_[a-z0-9]+)?$/);
assert.ok(Number(identity.version) >= 170000 && Number(identity.version) < 180000, 'PostgreSQL 17 required');
assert.equal(Number(identity.tables), 0, 'Refuse a nonempty public schema');
if (mode === '--local') {
  assert.equal(realpathSync(identity.directory), expectedDataDirectory);
  assert.equal(identity.address, '127.0.0.1');
  assert.equal(identity.port, Number(port));
} else {
  assert.equal(identity.database, 'bubaly_bill_anchor_ci');
  assert.equal(identity.address, null, 'Docker fixture uses only its private Unix socket');
}

const { billPaidPatch } = await import(pathToFileURL(join(root, 'lib/finance/bill-schedule.ts')).href);
const migration = readFileSync(join(root, 'supabase/reserved/0488_a_month_end_bill_keeps_its_day.sql'), 'utf8');
const original = readFileSync(join(root, 'supabase/migrations/0006_financial_health_school_sports.sql'), 'utf8');
const functions = original.match(/CREATE OR REPLACE FUNCTION set_updated_at\(\)[\s\S]*?\$\$;/g);
const triggers = original.match(/create or replace trigger set_bills_updated\b[^;]+;/g);
assert.equal(functions?.length, 1, 'Identify the exact source timestamp function');
assert.equal(triggers?.length, 1, 'Identify the exact source bills trigger');
pg(`create table public.bills (id integer primary key, family_id text not null, amount integer not null default 100, due_date date not null, status text not null, recurrence text, is_recurring boolean not null, updated_at timestamptz not null default now());\n${functions[0]}\n${triggers[0]}\n${migration}`);
const literal = value => value == null ? 'null' : typeof value === 'boolean' ? String(value) : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const read = id => JSON.parse(pg(`select row_to_json(b) from public.bills b where id=${Number(id)};`));
function cas(id, seen, patch) {
  assert.ok(patch, 'Actual schedule helper must produce a patch');
  const allowed = new Set(['status', 'due_date', 'recurrence', 'due_day']);
  assert.ok(Object.keys(patch).every(key => allowed.has(key)));
  const setters = Object.entries(patch).map(([key, value]) => `${key}=${literal(value)}`).join(',');
  // Equivalent snapshot predicates, intentionally not a PostgREST emulator.
  const filters = ['updated_at', 'due_date', 'status', 'recurrence', 'is_recurring', 'due_day']
    .map(key => `${key} is not distinct from ${literal(seen[key])}`).join(' and ');
  return Number(pg(`with u as (update public.bills set ${setters} where id=${Number(id)} and family_id='synthetic-family' and ${filters} returning id) select count(*) from u;`));
}
pg("insert into public.bills (id,family_id,due_date,status,recurrence,is_recurring,due_day) values (1,'synthetic-family','2026-01-31','upcoming','monthly',true,31),(2,'synthetic-family','2024-02-29','upcoming','yearly',true,29),(3,'synthetic-family','2026-02-28','upcoming','monthly',true,null);");
for (const next of ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']) {
  const seen = read(1), patch = billPaidPatch(seen, seen.due_date);
  assert.equal(patch?.due_date, next);
  assert.equal(cas(1, seen, patch), 1);
  assert.equal(read(1).due_date, next);
  assert.equal(read(1).due_day, 31);
  assert.equal(cas(1, seen, patch), 0, 'A repeated snapshot must not advance twice');
}
console.log('PASS persisted monthly Jan31-Feb28-Mar31-Apr30-May31 and repeated snapshot refusal');
for (const next of ['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']) {
  const seen = read(2), patch = billPaidPatch(seen, seen.due_date);
  assert.equal(patch?.due_date, next);
  assert.equal(cas(2, seen, patch), 1);
  assert.equal(read(2).due_date, next);
  assert.equal(read(2).due_day, 29);
}
console.log('PASS persisted yearly leap-day anchor returns February29 in2028');
assert.equal(billPaidPatch(read(3), '2026-02-28'), null);
assert.equal(read(3).due_day, null);
console.log('PASS legacy unknown anchor stays unknown and requires confirmation');
for (const day of [0, 32]) {
  assert.equal(pg(`do $$ begin begin update public.bills set due_day=${day} where id=3; raise exception 'invalid anchor accepted'; exception when check_violation then null; end; end $$; select due_day is null from public.bills where id=3;`), 't');
}
console.log('PASS physical anchor bounds reject0/32 without changing the row');
const seen = read(1);
pg('update public.bills set amount=200 where id=1;');
assert.notEqual(read(1).updated_at, seen.updated_at, 'Source trigger must stamp an amount-only edit');
assert.equal(cas(1, seen, billPaidPatch(seen, seen.due_date)), 0);
assert.equal(read(1).due_date, seen.due_date);
console.log('PASS source timestamp trigger rejects stale snapshot after amount-only edit');
const crossFamily = read(1);
pg("update public.bills set family_id='other-synthetic-family' where id=1;");
assert.equal(cas(1, { ...read(1), family_id: crossFamily.family_id }, billPaidPatch(crossFamily, crossFamily.due_date)), 0);
console.log('PASS handwritten CAS family predicate refuses a different family');
console.log('LIMIT: synthetic PostgreSQL storage/source helper/trigger and handwritten CAS only; no SDK, PostgREST, RLS, simultaneous concurrency, hosted schema or production acceptance. Reserved0488 remains held.');
