// Disposable GitHub E2E stack only. Never an apply/release entry point.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';

const socket = 'unix:///var/run/docker.sock';
export function validateInvocation(env, platform, args) {
  assert.equal(platform, 'linux'); assert.equal(args.length, 0);
  assert.equal(env.CI, 'true'); assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_JOB, 'e2e'); assert.equal(env.GITHUB_REPOSITORY?.toLowerCase(), 'newworldventure/bubaly');
  assert.match(env.GITHUB_RUN_ID ?? '', /^\d+$/); assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^\d+$/);
  assert.ok(['prepare', 'capture', 'install', 'cleanup'].includes(env.BUBALY_BILL_STACK_PHASE));
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DATABASE_URL', 'SUPABASE_DB_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGPASSWORD', 'PGOPTIONS']) {
    assert.ok(!Object.hasOwn(env, key), `Refuse connection override ${key}`);
  }
  assert.ok(env.RUNNER_TEMP && env.GITHUB_ENV);
  assert.ok(!env.PLAYWRIGHT_EXTERNAL_SERVER && !env.PLAYWRIGHT_PORT, 'Refuse inherited browser server overrides');
}
export function localOrigin(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:'); assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/'); assert.equal(url.username + url.password + url.search + url.hash, '');
  assert.equal(url.port, '54321'); return url.origin;
}
export async function assertNextStopped(connect = createConnection) {
  for (const host of ['127.0.0.1', '::1']) {
    await new Promise((resolve, reject) => {
      const socket = connect({ host, port: 3107 });
      const finish = error => { socket.destroy(); if (error) reject(error); else resolve(); };
      socket.setTimeout(1500);
      socket.once('connect', () => finish(new Error('Next TCP listener remains active')));
      socket.once('timeout', () => finish(new Error('Next TCP absence is unproven')));
      socket.once('error', error => finish(error.code === 'ECONNREFUSED' ? undefined : new Error('Next TCP absence is unproven')));
    });
  }
}
function execute(program, args, input, env = process.env) {
  const result = spawnSync(program, args, { input, encoding: 'utf8', env, timeout: 60_000, maxBuffer: 1_000_000 });
  // Never attach provider/database command output to errors (it can contain keys).
  assert.equal(result.status, 0, `Owned fixture command failed: ${program}`);
  return result.stdout.trim();
}
async function main() {
  validateInvocation(process.env, process.platform, process.argv.slice(2));
  const env = process.env, phase = env.BUBALY_BILL_STACK_PHASE;
  const run = `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  const receiptPath = join(env.RUNNER_TEMP, `bubaly-bill-stack-${run}.json`);
  const docker = (args, input) => execute('docker', ['--config', join(env.RUNNER_TEMP, `bubaly-bill-docker-${run}`), '--host', socket, ...args], input, { PATH: env.PATH, HOME: env.RUNNER_TEMP });
  assert.equal(execute('docker', ['context', 'show']), 'default');
  assert.equal(execute('docker', ['context', 'inspect', 'default', '--format', '{{.Endpoints.docker.Host}}']), socket);
  assert.match(readFileSync('supabase/config.toml', 'utf8'), /^project_id = "bubaly"$/m);
  const containers = () => docker(['ps', '-aq', '--no-trunc', '--filter', 'label=com.supabase.cli.project=bubaly']).split(/\r?\n/).filter(Boolean).sort();
  const inspect = id => JSON.parse(docker(['inspect', '--format', '{"id":{{json .Id}},"name":{{json .Name}},"created":{{json .Created}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"image":{{json .Config.Image}},"ports":{{json .NetworkSettings.Ports}}}', id]));
  if (phase === 'prepare') {
    assert.ok(!existsSync(receiptPath)); assert.equal(containers().length, 0, 'Refuse a preexisting Supabase stack');
    writeFileSync(receiptPath, JSON.stringify({ run, nonce: randomUUID(), startedAt: Date.now(), ids: null }));
    console.log('PASS no preexisting stack; owned startup attestation recorded'); return;
  }
  if (!existsSync(receiptPath) && phase === 'cleanup') { console.log('No owned startup attestation; no cleanup action'); return; }
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.run, run); assert.match(receipt.nonce, /^[a-f0-9-]{36}$/);
  const ids = containers();
  for (const id of ids) {
    assert.match(id, /^[a-f0-9]{64}$/); const row = inspect(id);
    assert.equal(row.id, id); assert.equal(row.project, 'bubaly');
    assert.ok(Date.parse(row.created) >= receipt.startedAt, 'Refuse a container predating owned startup');
  }
  if (phase === 'capture') {
    assert.equal(receipt.ids, null); assert.ok(ids.length > 0);
    const db = ids.map(inspect).filter(row => row.name === '/supabase_db_bubaly');
    assert.equal(db.length, 1); assert.equal(db[0].running, true); assert.match(db[0].image, /supabase\/postgres:15\./);
    receipt.ids = ids; receipt.db = db[0].id;
    // Write immutable IDs before any fixture DDL so cleanup remains bound to them.
    writeFileSync(receiptPath, JSON.stringify(receipt));
  } else if (receipt.ids !== null) assert.deepEqual(ids, receipt.ids, 'Owned stack immutable IDs changed');
  if (phase === 'cleanup') {
    // A failed startup without captured immutable IDs is not sufficient proof
    // to remove actors. Refuse rather than adopt a concurrently-created stack.
    assert.ok(receipt.ids !== null || ids.length === 0, 'No cleanup of uncaptured stack actors');
    if (ids.length) execute('supabase', ['stop', '--no-backup']);
    assert.equal(containers().length, 0); console.log('PASS owned disposable stack stopped'); return;
  }
  assert.ok(receipt.ids && receipt.db);
  const gateways = ids.map(inspect).filter(row => row.name === '/supabase_kong_bubaly' && row.running);
  assert.equal(gateways.length, 1);
  assert.ok(gateways[0].ports['8000/tcp']?.some(binding => binding.HostPort === '54321'));
  assert.deepEqual(docker(['ps', '-q', '--no-trunc', '--filter', 'publish=54321']).split(/\r?\n/).filter(Boolean), [gateways[0].id], 'Loopback provider port must belong to the captured gateway');
  const sql = text => docker(['exec', '-i', '--user', 'postgres', receipt.db, 'psql', '-X', '--no-password', '-q', '-t', '-A', '--host', '/var/run/postgresql', '--port', '5432', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '-'], text);
  assert.equal(sql("select current_database() || ':' || current_setting('server_version_num')::integer / 10000;"), 'postgres:15');
  const marker = `${run}:${receipt.nonce}`;
  if (phase === 'capture') {
    assert.equal(sql("select count(*) from pg_namespace where nspname='bill_e2e_private';"), '0');
    assert.equal(sql("select count(*) from pg_attribute where attrelid='public.bills'::regclass and attname='due_day' and not attisdropped;"), '0');
    sql(`create schema bill_e2e_private; revoke all on schema bill_e2e_private from public; create table bill_e2e_private.marker(value text primary key); alter table bill_e2e_private.marker enable row level security; insert into bill_e2e_private.marker values ('${marker}');`);
    appendFileSync(env.GITHUB_ENV, `BUBALY_BILL_STACK_MARKER=${marker}\n`);
    console.log('PASS captured owned full-stack PG15 identity and private marker'); return;
  }
  assert.equal(env.BUBALY_BILL_STACK_MARKER, marker);
  assert.equal(sql('select value from bill_e2e_private.marker;'), marker);
  localOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
  assert.equal(env.E2E_BILL_PARALLEL_FINISHED, '1', 'No held fixture install during parallel browser suite');
  // A stale or externally-owned Next listener must not share the DDL phase.
  await assertNextStopped();
  assert.equal(sql("select count(*) from pg_attribute where attrelid='public.bills'::regclass and attname='due_day' and not attisdropped;"), '0');
  assert.equal(sql("select count(*) from pg_trigger where tgrelid='public.bills'::regclass and tgname='set_bills_updated' and tgenabled='O';"), '1');
  assert.match(sql("select pg_get_functiondef('public.set_updated_at()'::regprocedure);"), /NEW\.updated_at\s*=\s*now\(\)/i);
  const ledger = sql('select count(*) from supabase_migrations.schema_migrations;');
  const source = readFileSync('supabase/reserved/0488_a_month_end_bill_keeps_its_day.sql', 'utf8');
  sql(`begin;\n${source}\nnotify pgrst,'reload schema'; commit;`);
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), ledger);
  assert.equal(sql("select data_type || ':' || is_nullable || ':' || coalesce(column_default,'NULL') from information_schema.columns where table_schema='public' and table_name='bills' and column_name='due_day';"), 'smallint:YES:NULL');
  assert.equal(sql("select count(*) from pg_constraint where conrelid='public.bills'::regclass and conname='bills_due_day_check' and contype='c' and convalidated;"), '1');
  const origin = localOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  assert.ok(key);
  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/rest/v1/bills?id=eq.${randomUUID()}`, { method: 'PATCH', redirect: 'error', signal: AbortSignal.timeout(3000), headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ due_day: null }) });
    if (response.ok && JSON.stringify(await response.json()) === '[]') { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'PostgREST write schema never became ready');
  console.log(`PASS unchanged held0488 fixture only; PG15; ledger unchanged; payload cache ready; SHA256 ${createHash('sha256').update(source).digest('hex')}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Bill fixture refused or failed; no credential-bearing diagnostics emitted.'); process.exitCode = 1; });
}
