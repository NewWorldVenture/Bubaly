// Explicit opt-in integration gate; ordinary unit runs collect visible skips.
// Actual service -> installed SDK -> real HTTP/PostgREST -> PG/source trigger.
// Only the /rest/v1 prefix is rewritten. No SQL CAS or HTTP result emulation.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative } from 'node:path';
import { createServer, createConnection, isIPv4, type Socket } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { readCompleteBills, saveBillPayment, saveBillSchedule } from '@/lib/finance/bills';
import { isDueDayNotKept, isMissingDueDayColumn } from '@/lib/finance/recurring';

const flag = process.env.BUBALY_BILL_POSTGREST_GATE;
if (flag !== undefined && flag !== '1') throw new Error('Invalid bill integration opt-in; refusing a silent skip');
if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_WORKFLOW === 'Recurring bill real PostgREST runtime' && flag !== '1') {
  throw new Error('Dedicated bill PostgREST workflow must enable the integration gate');
}
const enabled = flag === '1';
const PG_IMAGE = 'postgres:17@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3';
const REST_IMAGE = 'postgrest/postgrest:v16.4@sha256:d155c6718ed9a9f990d159a2ab7c0a3f16944dbb6d0a0344557421042acfe0df';
const JWT_KEY = 'bubaly-bill-gate-synthetic-key-with-no-external-use-20261008';
const DB = 'bubaly_bill_postgrest_ci';
const FAMILY = '10000000-0000-4000-8000-000000000001';
const FOREIGN_FAMILY = '10000000-0000-4000-8000-000000000002';
const PARENT = '20000000-0000-4000-8000-000000000001';
const CHILD = '20000000-0000-4000-8000-000000000002';
const BILL = '50000000-0000-4000-8000-000000000001';
const env: NodeJS.ProcessEnv = { ...process.env, PGCONNECT_TIMEOUT: '3' };
for (const key of ['PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGPASSWORD', 'PGPASSFILE']) delete env[key];
let pgCommand: string, pgArgs: string[], rest: URL, marker: string, modern = false;
const nativeFetch = globalThis.fetch;
let relay: Awaited<ReturnType<typeof startOwnedRelay>> | undefined;

// Docker does not publish ports for actors attached exclusively to an internal
// bridge. Keep both actors isolated; this test owns only a loopback TCP relay.
type OwnedNetwork = { Id: string; Driver: string; Containers: Record<string, { EndpointID: string; IPv4Address: string }> };
type OwnedContainer = { Id: string; NetworkSettings: { Networks: Record<string, { NetworkID: string; EndpointID: string; IPAddress: string }> } };
function ownedRestAddress(network: OwnedNetwork, container: OwnedContainer, name: string): string {
  assert.equal(network.Driver, 'bridge'); assert.match(network.Id, /^[a-f0-9]{64}$/);
  assert.match(container.Id, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(container.NetworkSettings.Networks), [name], 'No extra actor network');
  const attachment = container.NetworkSettings.Networks[name];
  assert.equal(attachment.NetworkID, network.Id); assert.match(attachment.EndpointID, /^[a-f0-9]{64}$/);
  const member = network.Containers[container.Id]; assert.ok(member, 'REST must belong to the captured network');
  assert.equal(member.EndpointID, attachment.EndpointID);
  assert.equal(member.IPv4Address.split('/')[0], attachment.IPAddress);
  assert.ok(isIPv4(attachment.IPAddress));
  const octets = attachment.IPAddress.split('.').map(Number);
  assert.ok(octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168), 'Only the owned private bridge address is eligible');
  return attachment.IPAddress;
}
async function startOwnedRelay(upstream: { host: string; port: number }, port: number) {
  assert.ok(isIPv4(upstream.host)); assert.ok(Number.isInteger(upstream.port) && upstream.port > 0 && upstream.port <= 65535);
  assert.ok(Number.isInteger(port) && port >= 49152 && port <= 65535);
  const sockets = new Set<Socket>();
  let failure: Error | undefined, stopped = false;
  const server = createServer({ allowHalfOpen: true }, downstream => {
    if (stopped || failure) { downstream.destroy(); return; }
    const target = createConnection({ host: upstream.host, port: upstream.port, allowHalfOpen: true });
    for (const socket of [downstream, target]) {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    }
    const destroyPair = () => { downstream.destroy(); target.destroy(); };
    downstream.once('error', destroyPair); target.once('error', destroyPair);
    downstream.once('close', () => target.destroy()); target.once('close', () => downstream.destroy());
    // Byte streams only: no HTTP parsing, header/body changes or error synthesis.
    downstream.pipe(target); target.pipe(downstream);
  });
  server.on('error', error => { failure = error; for (const socket of sockets) socket.destroy(); });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        server.removeListener('error', reject); resolve();
      });
    });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '127.0.0.1'); assert.equal(address.port, port);
  } catch (error) { server.close(); for (const socket of sockets) socket.destroy(); throw error; }
  return {
    requireHealthy: () => { assert.ok(!stopped && !failure && server.listening, 'Owned TCP relay is unavailable'); },
    close: async () => {
      stopped = true; for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      assert.equal(server.listening, false); assert.equal(server.address(), null);
    },
  };
}
type Receipt = { method: string; url: URL; status: number; body: unknown; contentRange: string | null };

function command(program: string, args: string[], input?: string) {
  return execFileSync(program, args, { input, encoding: 'utf8', env, timeout: 15_000, maxBuffer: 2_000_000 }).trim();
}
function sql(query: string) { return command(pgCommand, [...pgArgs, '-f', '-'], query); }
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(probe: () => boolean | Promise<boolean>, label: string, diagnostic?: () => string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (await probe()) return; await wait(100); }
  throw new Error(`Timed out waiting for ${label}${diagnostic ? `; ${diagnostic()}` : ''}`);
}
/** Only bounded diagnostic identifiers; no raw message/body/header values. */
function readinessCode(value: unknown): string {
  return typeof value === 'string' && /^(?:PGRST[0-9]{3}|[0-9A-Z]{5}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET|ABORTED)|TypeError|AbortError|TimeoutError|Error)$/.test(value) ? value : 'unavailable';
}
async function requireOwnedHttpIdentity() {
  let diagnostic = 'No authenticated identity response received';
  await until(async () => {
    relay?.requireHealthy();
    let response: Response;
    try {
      response = await nativeFetch(new URL('/rpc/bill_gate_identity', rest), {
        method: 'POST', headers: { Authorization: `Bearer ${jwt()}` }, signal: AbortSignal.timeout(2000),
      });
    } catch (error) {
      const cause = error instanceof Error ? error.cause as { code?: unknown } | undefined : undefined;
      diagnostic = `transport name=${readinessCode(error instanceof Error ? error.name : undefined)} causeCode=${readinessCode(cause?.code)}`;
      return false;
    }
    let body: unknown;
    try { body = await response.json(); }
    catch { diagnostic = `HTTP ${response.status}; non-JSON identity response`; return false; }
    if (response.status !== 200) {
      const error = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      diagnostic = `HTTP ${response.status}; code=${readinessCode(error.code)}`;
      return false;
    }
    // A healthy but different endpoint must fail immediately, before any DDL.
    assert.deepEqual(body, { database: DB, marker }, 'HTTP and SQL must identify the same owned fixture before DDL');
    return true;
  }, 'authenticated real PostgREST fixture identity', () => diagnostic);
}
function jwt(user = PARENT, aal = 'aal2') {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ role: 'authenticated', sub: user, aal, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
  return `${head}.${body}.${createHmac('sha256', JWT_KEY).update(`${head}.${body}`).digest('base64url')}`;
}
function client(user = PARENT, aal = 'aal2', receipts: Receipt[] = [], hold?: (receipt: Receipt) => Promise<void>) {
  return createClient<Database>(rest.origin, 'synthetic-bill-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${jwt(user, aal)}` }, fetch: async (input, init) => {
      const url = new URL(String(input));
      relay?.requireHealthy();
      assert.equal(url.origin, rest.origin, 'No request may leave the owned loopback REST endpoint');
      assert.equal(url.pathname, '/rest/v1/bills', 'No auth/provider/other-table HTTP requests');
      url.pathname = '/bills';
      const response = await nativeFetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
      const receipt = { method: init?.method ?? 'GET', url, status: response.status, body: await response.clone().json(), contentRange: response.headers.get('content-range') };
      receipts.push(receipt);
      if (hold) await hold(receipt); // The real, unchanged response may be delayed.
      return response;
    } },
  });
}
async function read(db = client()): Promise<Tables<'bills'>> {
  const result = await readCompleteBills(db, FAMILY);
  expect(result.error).toBeNull();
  expect(result.data).toHaveLength(1);
  return result.data![0];
}
function seed(date = '2026-01-31', day: number | null = 31, cadence = 'monthly', family = FAMILY) {
  sql(`insert into public.bills (id,family_id,name,due_date,recurrence${modern ? ',due_day' : ''}) values (${literal(BILL)},${literal(family)},'Synthetic rent',${literal(date)},${literal(cadence)}${modern ? `,${day ?? 'null'}` : ''});`);
}
function persisted() { return JSON.parse(sql(`select row_to_json(b) from public.bills b where id=${literal(BILL)};`)) as Tables<'bills'>; }
function extract(source: string, pattern: RegExp) {
  const matches = source.match(pattern); assert.equal(matches?.length, 1, 'Identify exactly one source excerpt'); return matches![0];
}
async function lockRow() {
  const child = spawn(pgCommand, pgArgs, { env, stdio: 'pipe' }) as ChildProcessWithoutNullStreams;
  let output = '', diagnostic = '', exited = false;
  child.stdout.on('data', data => { output += String(data); });
  child.stderr.on('data', data => { diagnostic += String(data); });
  child.on('error', error => { diagnostic += error.message; exited = true; });
  child.on('exit', () => { exited = true; });
  child.stdin.write(`set application_name='bubaly_bill_gate_lock'; begin; select id from public.bills where id=${literal(BILL)} for update; select 'BILL_GATE_LOCKED';\n`);
  try { await until(() => { if (exited) throw new Error(diagnostic); return output.includes('BILL_GATE_LOCKED'); }, 'owned row lock'); }
  catch (error) { child.stdin.end('rollback;\n\\q\n'); throw error; }
  return {
    commit: () => child.stdin.write('commit;\n'),
    close: async () => {
      child.stdin.end('rollback;\n\\q\n');
      try { await until(() => exited, 'lock session cleanup'); } finally { if (!exited) child.kill(); }
    },
  };
}

describe.skipIf(!enabled).sequential('isolated real PostgREST recurring bill acceptance (explicit gate only)', () => {
  beforeAll(async () => {
    marker = process.env.BUBALY_BILL_GATE_MARKER ?? '';
    rest = new URL(process.env.BUBALY_BILL_REST_URL ?? 'invalid');
    assert.equal(rest.protocol, 'http:'); assert.equal(rest.hostname, '127.0.0.1');
    assert.ok(Number(rest.port) >= 49152 && Number(rest.port) <= 65535);
    assert.equal(rest.pathname, '/'); assert.equal(rest.search + rest.hash + rest.username + rest.password, '');
    const mode = process.env.BUBALY_BILL_POSTGREST_MODE;
    let upstream: { host: string; port: number } | undefined;
    if (mode === 'docker') {
      assert.equal(process.env.CI, 'true'); assert.equal(process.env.GITHUB_ACTIONS, 'true');
      assert.equal(process.version, 'v24.21.0');
      assert.ok(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT, 'No inherited remote Docker target');
      assert.equal(command('docker', ['context', 'show']), 'default');
      assert.equal(command('docker', ['context', 'inspect', 'default', '--format', '{{.Endpoints.docker.Host}}']), 'unix:///var/run/docker.sock');
      assert.match(process.env.GITHUB_RUN_ID ?? '', /^\d+$/); assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^\d+$/);
      assert.equal(marker, `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
      const prefix = `bubaly-bill-rest-${marker}`, network = `${prefix}-net`;
      const [net] = JSON.parse(command('docker', ['network', 'inspect', network]));
      assert.equal(net.Internal, true); assert.equal(net.Labels['bubaly.bill-postgrest-run'], marker);
      let databaseId: string | undefined;
      for (const [suffix, image] of [['pg', PG_IMAGE], ['rest', REST_IMAGE]]) {
        const [container] = JSON.parse(command('docker', ['inspect', '--type', 'container', `${prefix}-${suffix}`]));
        assert.equal(container.Config.Image, image); assert.equal(container.State.Running, true);
        assert.equal(container.Config.Labels['bubaly.bill-postgrest-run'], marker);
        assert.equal(container.HostConfig.NetworkMode, network);
        assert.ok(container.Mounts.every((mount: { Type: string; Destination: string }) => suffix === 'pg' && mount.Type === 'volume' && mount.Destination === '/var/lib/postgresql/data'));
        assert.equal(Object.keys(container.HostConfig.PortBindings ?? {}).length, 0, 'No actor publishes a host port');
        assert.equal(Object.keys(container.NetworkSettings.Ports ?? {}).filter(key => container.NetworkSettings.Ports[key]?.length).length, 0);
        const address = ownedRestAddress(net, container, network);
        if (suffix === 'pg') databaseId = container.Id;
        else upstream = { host: address, port: 3000 };
      }
      assert.ok(databaseId && upstream);
      pgCommand = 'docker'; pgArgs = ['exec', '-i', databaseId, 'psql', '-h', '/var/run/postgresql', '-U', 'postgres', '-d', DB];
    } else {
      assert.equal(mode, 'local'); assert.match(marker, /^[a-f0-9]{32}$/);
      const data = realpathSync(process.env.BUBALY_BILL_PG_DATA ?? '');
      assert.equal(relative(realpathSync(tmpdir()), data).replaceAll('\\', '/'), `bubaly-bill-postgrest-probe-${marker}/data`);
      pgCommand = realpathSync(process.env.BUBALY_BILL_PSQL ?? ''); assert.match(pgCommand, /[/\\]psql(?:\.exe)?$/i);
      const port = process.env.BUBALY_BILL_PG_PORT ?? ''; assert.match(port, /^\d{5}$/); assert.ok(Number(port) >= 49152 && Number(port) <= 65535);
      pgArgs = ['-h', '127.0.0.1', '-p', port, '-U', 'postgres', '-d', DB];
    }
    pgArgs.push('-X', '--no-password', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1');
    const identity = JSON.parse(sql(`select json_build_object('database',current_database(),'version',current_setting('server_version_num'),'marker',(select run_id from bill_gate_private.marker),'directory',current_setting('data_directory'));`));
    assert.equal(identity.database, DB); assert.equal(identity.marker, marker);
    assert.ok(Number(identity.version) >= 170000 && Number(identity.version) < 180000);
    if (mode === 'local') assert.equal(realpathSync(identity.directory), realpathSync(process.env.BUBALY_BILL_PG_DATA!));
    assert.equal(sql('select count(*) from public.bills;'), '0');
    assert.equal(sql("select count(*) from pg_attribute where attrelid='public.bills'::regclass and attname='due_day' and not attisdropped;"), '0');
    // API-root OpenAPI metadata is role-dependent, not proof of authenticated
    // execution. Readiness must establish the already required HTTP/SQL identity.
    if (upstream) relay = await startOwnedRelay(upstream, Number(rest.port));
    try { await requireOwnedHttpIdentity(); }
    catch (error) { if (relay) { await relay.close(); relay = undefined; } throw error; }
    const base = readFileSync('supabase/migrations/0003_functions_triggers.sql', 'utf8');
    for (const name of ['is_family_member', 'can_manage_family']) {
      sql(extract(base, new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$;`, 'gi')));
    }
    const source = readFileSync('supabase/migrations/0006_financial_health_school_sports.sql', 'utf8');
    sql(extract(source, /CREATE OR REPLACE FUNCTION set_updated_at\(\)[\s\S]*?\$\$;/g));
    sql(extract(source, /create or replace trigger set_bills_updated\b[^;]+;/g));
    sql(readFileSync('supabase/migrations/0275_money_permissive_write_sweep.sql', 'utf8'));
    sql(readFileSync('supabase/migrations/0382_a_password_alone_does_not_delete_the_familys_budget.sql', 'utf8'));
  }, 60_000);

  afterAll(async () => {
    if (relay) { await relay.close(); relay = undefined; console.log('PASS owned loopback TCP relay closed'); }
  });

  beforeEach(() => { sql('truncate public.bills; truncate auth.mfa_factors;'); });

  it('observes genuine old-schema error, retries a safe anchor and refuses a clamped roll without half writes', async () => {
    seed('2026-01-15'); const receipts: Receipt[] = [], db = client(PARENT, 'aal2', receipts), seen = await read(db);
    expect(seen).not.toHaveProperty('due_day');
    const paid = await saveBillPayment(db, FAMILY, seen, seen.due_date);
    expect(paid.error).toBeNull(); expect(paid.data).toEqual([{ id: BILL }]);
    const patches = receipts.filter(r => r.method === 'PATCH'); expect(patches).toHaveLength(2);
    expect(isMissingDueDayColumn(patches[0].body)).toBe(true); expect(patches[0].status).toBe(400); expect(patches[1].status).toBe(200);
    expect((await read(client())).due_date).toBe('2026-02-15');
    sql('truncate public.bills;'); seed(); const before = persisted(), refused = await saveBillPayment(client(), FAMILY, await read(), '2026-01-31');
    expect(isDueDayNotKept(refused.error)).toBe(true); expect(persisted()).toEqual(before);
    console.log('PASS real old-schema error / safe retry / clamped no-half-write refusal');
  });

  it('preserves actual missing-error response while a stale edit defeats the safe retry', async () => {
    seed('2026-01-15'); const seen = await read(), receipts: Receipt[] = []; let held = false;
    const db = client(PARENT, 'aal2', receipts, async receipt => {
      if (receipt.method === 'PATCH' && isMissingDueDayColumn(receipt.body) && !held) { held = true; sql(`update public.bills set amount=200 where id=${literal(BILL)};`); }
    });
    const result = await saveBillPayment(db, FAMILY, seen, seen.due_date);
    expect(held).toBe(true); expect(result.error).toBeNull(); expect(result.data).toEqual([]);
    expect(receipts.filter(r => r.method === 'PATCH')).toHaveLength(2);
    expect(persisted()).toMatchObject({ amount: 200, due_date: seen.due_date });
  });

  it('owner retirement after a real old-schema refusal prevents a second HTTP dispatch', async () => {
    seed('2026-01-15'); const seen = await read(), receipts: Receipt[] = []; let current = true;
    const db = client(PARENT, 'aal2', receipts, async receipt => { if (isMissingDueDayColumn(receipt.body)) current = false; });
    const result = await saveBillPayment(db, FAMILY, seen, seen.due_date, undefined, false, () => current);
    expect(result.error).toBeTruthy(); expect(receipts.filter(r => r.method === 'PATCH')).toHaveLength(1);
    expect(persisted().due_date).toBe(seen.due_date);
  });

  it('explicit ambiguous day confirmation on the old schema refuses to lose its anchor', async () => {
    seed('2026-03-28'); const seen = await read(), before = persisted();
    const result = await saveBillSchedule(client(), FAMILY, seen, { cadence: 'monthly', dueDay: 31 });
    expect(isDueDayNotKept(result.error)).toBe(true); expect(persisted()).toEqual(before);
  });

  it('applies held0488 only to this fixture, observes real stale cache, then reloads real PostgREST', async () => {
    seed(); const seen = await read(), before = persisted();
    sql(readFileSync('supabase/reserved/0488_a_month_end_bill_keeps_its_day.sql', 'utf8')); modern = true;
    const receipts: Receipt[] = []; const result = await saveBillPayment(client(PARENT, 'aal2', receipts), FAMILY, seen, seen.due_date);
    expect(isDueDayNotKept(result.error)).toBe(true);
    expect(receipts.filter(r => r.method === 'PATCH')).toHaveLength(1);
    expect(isMissingDueDayColumn(receipts[0].body)).toBe(true);
    expect(persisted()).toMatchObject({ ...before, due_day: null });
    sql("notify pgrst, 'reload schema';");
    // SELECT can reach a real column before PostgREST's payload metadata reloads.
    // A zero-row PATCH proves the actual write planner admits the new column,
    // without changing any fixture row or using the app's compatibility retry.
    await until(async () => {
      const response = await client().from('bills').update({ due_day: null }).eq('id', '00000000-0000-0000-0000-000000000000').select('id');
      return !response.error && response.data?.length === 0;
    }, 'real schema cache write-metadata reload');
    const modernReceipts: Receipt[] = [];
    const confirmed = await saveBillSchedule(client(PARENT, 'aal2', modernReceipts), FAMILY, await read(), { cadence: 'monthly', dueDay: 31 });
    expect(confirmed.error).toBeNull(); expect(confirmed.data).toEqual([{ id: BILL }]);
    const paid = await saveBillPayment(client(PARENT, 'aal2', modernReceipts), FAMILY, await read(), seen.due_date);
    expect(paid.error, JSON.stringify(modernReceipts.map(receipt => ({ status: receipt.status, body: receipt.body })))).toBeNull();
    expect(paid.data).toEqual([{ id: BILL }]); expect(await read(client())).toMatchObject({ due_date: '2026-02-28', due_day: 31 });
    console.log('PASS real stale schema cache -> NOTIFY -> fresh SDK durable anchor');
  });

  it('persists monthly31 and yearly29 through actual service/SDK/PostgREST and fresh-client reads', async () => {
    seed();
    for (const next of ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']) {
      const seen = await read(client()), result = await saveBillPayment(client(), FAMILY, seen, seen.due_date);
      expect(result.error).toBeNull(); expect(result.data).toEqual([{ id: BILL }]);
      expect(await read(client())).toMatchObject({ due_date: next, due_day: 31 }); expect(persisted().due_date).toBe(next);
    }
    sql('truncate public.bills;'); seed('2024-02-29', 29, 'yearly');
    for (const next of ['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']) {
      const seen = await read(client()), result = await saveBillPayment(client(), FAMILY, seen, seen.due_date);
      expect(result.data).toEqual([{ id: BILL }]); expect(await read(client())).toMatchObject({ due_date: next, due_day: 29 });
    }
    console.log('PASS actual service/SDK/PostgREST monthly31 and leap29 persisted reloads');
  });

  it('confirms future anchor without paying or moving an unpaid current occurrence', async () => {
    seed('2026-03-28', null); const seen = await read();
    const result = await saveBillSchedule(client(), FAMILY, seen, { cadence: 'monthly', dueDay: 31 });
    expect(result.data).toEqual([{ id: BILL }]); expect(await read(client())).toMatchObject({ due_date: seen.due_date, status: seen.status, due_day: 31 });
  });

  it('completes a genuine two-row server cap with stable exact scoped paging', async () => {
    sql(`insert into public.bills (id,family_id,name,due_date,due_day)
      select ('50000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,${literal(FAMILY)},'Synthetic '||n,
      date '2026-01-01'+(n%3),1+(n%3) from generate_series(1,11) n;
      insert into public.bills (id,family_id,name,due_date,due_day) values
      ('50000000-0000-4000-8000-000000000099',${literal(FOREIGN_FAMILY)},'Foreign synthetic','2026-01-01',1);`);
    const receipts: Receipt[] = [], result = await readCompleteBills(client(PARENT, 'aal2', receipts), FAMILY);
    expect(result.error).toBeNull(); expect(result.data).toHaveLength(11);
    expect(result.data!.map(row => row.id)).toEqual([3, 6, 9, 1, 4, 7, 10, 2, 5, 8, 11].map(n => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`));
    expect(result.data!.every(row => row.family_id === FAMILY)).toBe(true);
    expect(receipts.length).toBeGreaterThan(1);
    expect(receipts.every(receipt => receipt.method === 'GET' && Array.isArray(receipt.body) && receipt.body.length <= 2 && receipt.contentRange?.endsWith('/11'))).toBe(true);
    expect(receipts.some(receipt => Number(receipt.url.searchParams.get('offset')) > 0)).toBe(true);
    console.log('PASS real server max-rows2 -> complete11 scoped bills / exact counts / stable order');
  });

  it('two real blocked HTTP payments admit exactly one snapshot after the row lock releases', async () => {
    seed(); const seen = await read(), lock = await lockRow();
    const competing = Promise.all([saveBillPayment(client(), FAMILY, seen, seen.due_date), saveBillPayment(client(), FAMILY, seen, seen.due_date)]);
    try {
      await until(() => Number(sql("select count(*) from pg_stat_activity where datname='bubaly_bill_postgrest_ci' and usename='bubaly_bill_authenticator' and wait_event_type='Lock';")) >= 2, 'two actual PostgREST requests blocked on PostgreSQL locks');
      lock.commit(); const results = await competing;
      expect(results.every(result => result.error === null)).toBe(true);
      expect(results.map(result => result.data?.length).sort()).toEqual([0, 1]);
      expect(await read(client())).toMatchObject({ due_date: '2026-02-28', due_day: 31 });
    } finally { await lock.close(); await competing; }
    console.log('PASS deterministic independent HTTP/PG sessions: one accepted payment');
  }, 45_000);

  it.each(['amount', 'autopay', 'schedule ABA'])('source timestamp and actual SDK CAS reject stale %s snapshots', async change => {
    seed(); const seen = await read();
    if (change === 'amount') sql(`update public.bills set amount=200 where id=${literal(BILL)};`);
    else if (change === 'autopay') sql(`update public.bills set autopay=true where id=${literal(BILL)};`);
    else { sql(`update public.bills set recurrence='quarterly' where id=${literal(BILL)};`); sql(`update public.bills set recurrence='monthly' where id=${literal(BILL)};`); }
    const changed = persisted(); expect(changed.updated_at).not.toBe(seen.updated_at);
    const result = await saveBillPayment(client(), FAMILY, seen, seen.due_date);
    expect(result.error).toBeNull(); expect(result.data).toEqual([]); expect(persisted()).toEqual(changed);
  });

  it('actual0275/0382 policies deny child, foreign family and enrolled-manager aal1; allow aal2', async () => {
    seed(); const seen = await read();
    const child = await saveBillPayment(client(CHILD), FAMILY, seen, seen.due_date); expect(child.data).toEqual([]);
    sql(`insert into auth.mfa_factors values (${literal(PARENT)},'verified');`);
    const weak = await saveBillPayment(client(PARENT, 'aal1'), FAMILY, seen, seen.due_date); expect(weak.data).toEqual([]);
    const strong = await saveBillPayment(client(PARENT, 'aal2'), FAMILY, seen, seen.due_date); expect(strong.data).toEqual([{ id: BILL }]);
    sql(`update public.bills set family_id=${literal(FOREIGN_FAMILY)} where id=${literal(BILL)};`);
    const foreign = persisted(), refused = await saveBillPayment(client(), FOREIGN_FAMILY, foreign, foreign.due_date);
    expect(refused.data).toEqual([]); expect(persisted()).toEqual(foreign);
    console.log('PASS actual money policies with modeled auth claims; not GoTrue/production RLS acceptance');
  });

  it('physical day bounds refuse invalid real HTTP writes without partial row changes', async () => {
    seed(); const before = persisted();
    for (const day of [0, 32]) { const result = await client().from('bills').update({ due_day: day }).eq('id', BILL).select('id'); expect(result.error?.code).toBe('23514'); expect(persisted()).toEqual(before); }
    console.log('PASS real HTTP anchor bounds and no partial write; isolated service-to-database gate complete');
  });
});
