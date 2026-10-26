import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PORTS, parseRanges, formatRanges, assertCI, assertFixedConfig, assertNoOwnedPortSockets,
  reservePorts } from '../ci-reserve-supabase-ports.mjs';

const env = { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'NewWorldVenture/Bubaly',
  GITHUB_JOB: 'e2e', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
  GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
const header = '  sl  local_address rem_address st\n';
const table = (port, ipv6 = false, state = '0A') => `${header} 0: ${ipv6 ? '0'.repeat(32) : '00000000'}:${port.toString(16).padStart(4, '0')} 00000000:0000 ${state}\n`;
function fixture(options = {}) {
  let reservations = options.before ?? '1000-1002,60000';
  let writes = 0;
  const calls = [];
  return {
    calls, get writes() { return writes; }, get reservations() { return reservations; },
    run() { return reservePorts({ env: options.env ?? env, platform: 'linux', uid: 1001,
      read(file) {
        calls.push(file);
        if (file === 'supabase/config.toml') return options.config ?? '[db]\nport = 54322\n';
        if (file.endsWith('ip_local_reserved_ports')) return reservations;
        return options.tables?.[file] ?? header;
      },
      apply(value) { calls.push('APPLY'); writes++; if (!options.dropWrite) reservations = value; },
    }); },
  };
}

test('union preserves every existing range and all complete CLI default ports', () => {
  const f = fixture();
  assert.deepEqual(f.run(), { protectedPorts: 12, existingReservationsPreserved: true });
  assert.equal(f.reservations, '1000-1002,3107,8083,54320-54329,60000');
  assert.equal(f.writes, 1);
  const at = f.calls.indexOf('APPLY');
  assert.equal(f.calls.slice(0, at).filter(p => p.startsWith('/proc/net/')).length, 4);
  assert.equal(f.calls.slice(at + 1).filter(p => p.startsWith('/proc/net/')).length, 4);
});
test('all-covered reservations are verified without a write', () => {
  const f = fixture({ before: '1-65535' }); f.run(); assert.equal(f.writes, 0);
});
test('normalizes overlapping adjacent intervals without dropping prior ports', () => {
  assert.equal(formatRanges(parseRanges('9-12,1,2-8,10,65535')), '1-12,65535');
});
test('invalid kernel input refuses instead of overwriting existing reservations', () => {
  for (const value of ['0', '9-1', '65536', '1,', 'x', '1-2-3']) assert.throws(() => parseRanges(value));
});
test('all reserved ports refuse preexisting unknown IPv4 and IPv6 TCP/UDP sockets', () => {
  for (const port of PORTS) for (const path of ['/proc/net/tcp', '/proc/net/tcp6', '/proc/net/udp', '/proc/net/udp6']) {
    const f = fixture({ tables: { [path]: table(port, path.endsWith('6')) } });
    assert.throws(() => f.run(), /PORT_ALREADY_IN_USE/); assert.equal(f.writes, 0);
  }
});
test('outbound established and TIME_WAIT local ports are not mistaken for free ports', () => {
  for (const state of ['01', '06']) assert.throws(() => assertNoOwnedPortSockets(table(54324, false, state)), /PORT_ALREADY_IN_USE/);
  assert.doesNotThrow(() => assertNoOwnedPortSockets(table(50000)));
});
test('missing or malformed socket metadata fails closed', () => {
  for (const source of ['', 'header\n', `${header}bad-row\n`]) assert.throws(() => assertNoOwnedPortSockets(source), /INVALID_SOCKET_TABLE/);
});
test('write success without exact reservation readback is refused', () => {
  const f = fixture({ dropWrite: true }); assert.throws(() => f.run(), /READBACK_MISMATCH/); assert.equal(f.writes, 1);
});
test('local, root, self-hosted, wrong-job and unbound run invocations cannot write', () => {
  assert.throws(() => assertCI(env, 'win32', 1001)); assert.throws(() => assertCI(env, 'linux', 0));
  for (const changed of [{ CI: 'false' }, { GITHUB_JOB: 'other' }, { RUNNER_ENVIRONMENT: 'self-hosted' },
    { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_RUN_ID: '' }, { GITHUB_ACTIONS: 'false' }]) {
    const f = fixture({ env: { ...env, ...changed } }); assert.throws(() => f.run()); assert.equal(f.writes, 0);
  }
});
test('CLI environment port overrides and remote Docker contexts refuse before effects', () => {
  for (const changed of [{ SUPABASE_DB_PORT: '55555' }, { SUPABASE_LOCAL_SMTP_PORT: '55555' },
    { SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT: '9999' }, { DOCKER_HOST: '' }, { DOCKER_CONTEXT: 'foreign' }]) {
    const f = fixture({ env: { ...env, ...changed } });
    assert.throws(() => f.run(), /REFUSE_CONNECTION_OVERRIDE/); assert.equal(f.calls.length, 0); assert.equal(f.writes, 0);
  }
});
test('fixed defaults remain accepted and any unexpected service port override refuses', () => {
  assert.doesNotThrow(() => assertFixedConfig('[db]\nport = 54322\n[local_smtp]\nport = 54324\n# smtp_port = 1234\n'));
  for (const source of ['[db]\nport = 55555', '[new]\nport = 54324', '[local_smtp]\nsmtp_port = 55555']) {
    const f = fixture({ config: source }); assert.throws(() => f.run(), /UNRESERVED_CONFIG_PORT/); assert.equal(f.writes, 0);
  }
});
test('quoted, escaped and dotted assignment keys refuse before any reservation write', () => {
  for (const source of ['[db]\n"port" = 55555', '[db]\n\'port\' = 55555', 'api.port = 55555',
    '[db]\n"po\\u0072t" = 55555', 'db."port" = 55555', '[db]\nPort = 55555', '[db]\nPORT = 55555']) {
    const f = fixture({ config: source }); assert.throws(() => f.run(), /UNSUPPORTED_CONFIG_KEY/); assert.equal(f.writes, 0);
  }
});
test('inline service tables cannot bypass explicit fixed-port validation', () => {
  for (const source of ['db = { port = 55555 }', 'api = { port = 55555 }']) {
    const f = fixture({ config: source }); assert.throws(() => f.run(), /UNSUPPORTED_CONFIG_INLINE_TABLE/); assert.equal(f.writes, 0);
  }
});
test('guard remains before npm and full startup, with the reviewed CLI version pinned', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const e2e = workflow.slice(workflow.indexOf('\n  e2e:\n'));
  assert.match(e2e, /version: 2\.109\.1/);
  assert.ok(e2e.indexOf('node scripts/ci-reserve-supabase-ports.mjs') < e2e.indexOf('run: npm ci'));
  assert.ok(e2e.indexOf('node scripts/ci-reserve-supabase-ports.mjs') < e2e.indexOf('supabase start'));
});
test('tracked config is accepted without rewriting production/default service URLs', () => {
  assert.doesNotThrow(() => assertFixedConfig(readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8')));
});
test('failed privileged write is surfaced without retry or subsequent success', () => {
  let writes = 0;
  assert.throws(() => reservePorts({ env, platform: 'linux', uid: 1001,
    read: path => path === 'supabase/config.toml' || path.endsWith('ip_local_reserved_ports') ? '' : header,
    apply: () => { writes++; throw new Error('RESERVATION_WRITE_FAILED'); },
  }), /RESERVATION_WRITE_FAILED/);
  assert.equal(writes, 1);
});
test('reservation mutation between snapshot and write is refused', () => {
  let reads = 0, writes = 0;
  assert.throws(() => reservePorts({ env, platform: 'linux', uid: 1001,
    read: path => path === 'supabase/config.toml' ? '' : path.endsWith('ip_local_reserved_ports') ? (++reads === 1 ? '1000' : '2000') : header,
    apply: () => writes++,
  }), /RESERVATIONS_CHANGED_BEFORE_WRITE/);
  assert.equal(writes, 0);
});
test('new explicit socket appearing after reservation still refuses', () => {
  let applied = false;
  assert.throws(() => reservePorts({ env, platform: 'linux', uid: 1001,
    read: path => path === 'supabase/config.toml' ? '' : path.endsWith('ip_local_reserved_ports')
      ? applied ? formatRanges(new Set(PORTS)) : '' : applied ? table(54324) : header,
    apply: () => { applied = true; },
  }), /PORT_ALREADY_IN_USE/);
});
