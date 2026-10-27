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
const guardCommand = '\n          node scripts/ci-reserve-supabase-ports.mjs\n';
const npmCommand = '\n        run: npm ci\n';
const startCommand = '\n          supabase start\n';
function assertWorkflowGuard(workflow) {
  const job = workflow.indexOf('\n  e2e:\n');
  assert.ok(job >= 0, 'E2E job must exist');
  const e2e = workflow.slice(job);
  assert.match(e2e, /version: 2\.109\.1/);
  const guard = e2e.indexOf(guardCommand);
  const npm = e2e.indexOf(npmCommand);
  const start = e2e.indexOf(startCommand);
  assert.ok(guard >= 0, 'Reservation command must exist');
  assert.ok(npm >= 0, 'Dependency installation must exist');
  assert.ok(start >= 0, 'Actual full startup command must exist');
  assert.ok(guard < npm, 'Reservation must precede dependency installation');
  assert.ok(guard < start, 'Reservation must precede full startup');
}
test('guard remains before npm and full startup, with the reviewed CLI version pinned', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assertWorkflowGuard(workflow);
});
test('workflow oracle rejects omitted commands/job and reservation reordered after npm/start', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const job = workflow.indexOf('\n  e2e:\n');
  assert.ok(job >= 0);
  const e2e = workflow.slice(job);
  for (const token of ['\n  e2e:\n', guardCommand, npmCommand, startCommand]) {
    assert.ok(e2e.includes(token));
    assert.throws(() => assertWorkflowGuard(e2e.replace(token, '\n')));
  }
  for (const after of [npmCommand, startCommand]) {
    assert.throws(() => assertWorkflowGuard(e2e.replace(guardCommand, '\n').replace(after, after + guardCommand)));
  }
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

// Additive diagnostics controls. The original nineteen registrations and
// assertions above remain byte-for-byte intact.
import { formatGuardFailure } from '../ci-reserve-supabase-ports.mjs';

const socketTables = [
  ['/proc/net/tcp', 'tcp4'], ['/proc/net/tcp6', 'tcp6'],
  ['/proc/net/udp', 'udp4'], ['/proc/net/udp6', 'udp6'],
];
function caught(run) {
  let error;
  try { run(); } catch (failure) { error = failure; }
  assert.ok(error instanceof Error, 'The conflict must still refuse');
  assert.equal(error.message, 'PORT_ALREADY_IN_USE');
  return error;
}
const diagnostic = () => ({ phase: 'before_reservation', table: 'tcp4', port: 54324, state: '06' });
function errorWith(detail) {
  const error = new Error('PORT_ALREADY_IN_USE');
  error.portDiagnostic = detail;
  return error;
}

test('pre-reservation conflicts name only phase, table, protected local port and state without writing', () => {
  for (const port of PORTS) for (const [file, name] of socketTables) for (const state of ['0A', '01', '06']) {
    const f = fixture({ tables: { [file]: table(port, file.endsWith('6'), state) } });
    const error = caught(() => f.run());
    assert.equal(f.writes, 0);
    assert.ok(!f.calls.includes('APPLY'));
    assert.deepEqual(error.portDiagnostic, { phase: 'before_reservation', table: name, port, state });
    assert.equal(formatGuardFailure(error), `PORT_ALREADY_IN_USE phase=before_reservation table=${name} port=${port} state=${state}`);
  }
});

test('post-readback conflicts identify the second snapshot and preserve exactly one write and immediate refusal', () => {
  for (const port of PORTS) for (const [file, name] of socketTables) for (const state of ['0A', '01', '06']) {
    let reservations = '', writes = 0;
    const calls = [];
    const error = caught(() => reservePorts({ env, platform: 'linux', uid: 1001,
      read(path) {
        calls.push(path);
        if (path === 'supabase/config.toml') return '';
        if (path.endsWith('ip_local_reserved_ports')) return reservations;
        return writes === 1 && path === file ? table(port, file.endsWith('6'), state) : header;
      },
      apply(value) { calls.push('APPLY'); writes++; reservations = value; },
    }));
    assert.equal(writes, 1);
    const at = calls.indexOf('APPLY');
    assert.ok(at >= 0);
    assert.equal(calls.slice(0, at).filter(path => path.startsWith('/proc/net/')).length, 4);
    assert.equal(calls[at + 1], '/proc/sys/net/ipv4/ip_local_reserved_ports');
    assert.equal(calls.at(-1), file);
    assert.deepEqual(error.portDiagnostic, { phase: 'after_reservation', table: name, port, state });
    assert.equal(formatGuardFailure(error), `PORT_ALREADY_IN_USE phase=after_reservation table=${name} port=${port} state=${state}`);
  }
});

test('all hexadecimal socket states remain conflicts, including lower-case source state normalization', () => {
  for (let value = 0; value <= 255; value++) {
    const state = value.toString(16).padStart(2, '0');
    const error = caught(() => assertNoOwnedPortSockets(table(54324, false, state), { phase: 'before_reservation', table: 'tcp4' }));
    assert.equal(error.portDiagnostic.state, state.toUpperCase());
    assert.equal(formatGuardFailure(error), `PORT_ALREADY_IN_USE phase=before_reservation table=tcp4 port=54324 state=${state.toUpperCase()}`);
  }
});

test('malformed state or context cannot turn a port conflict into permission to continue', () => {
  for (const state of ['', 'not-a-state', '0A\nSYNTHETIC_PRIVATE_VALUE']) {
    // The newline case can leave a valid first row, but no row content may be logged.
    const error = caught(() => assertNoOwnedPortSockets(table(54324, false, state), { phase: 'before_reservation', table: 'tcp4' }));
    assert.ok(!formatGuardFailure(error).includes('SYNTHETIC_PRIVATE_VALUE'));
  }
  for (const context of [undefined, null, {}, { phase: 'foreign', table: 'tcp4' },
    { phase: 'before_reservation', table: '/arbitrary/file' }, { phase: 'before_reservation', table: 'tcp4', pid: 123 }]) {
    const error = caught(() => assertNoOwnedPortSockets(table(54324), context));
    assert.equal(formatGuardFailure(error), 'PORT_ALREADY_IN_USE');
  }
});

test('formatter refuses any extra diagnostic fields instead of serializing sensitive metadata', () => {
  for (const key of ['address', 'remote', 'pid', 'uid', 'inode', 'command', 'env', 'message', 'raw']) {
    const error = errorWith({ ...diagnostic(), [key]: 'SYNTHETIC_PRIVATE_VALUE' });
    assert.equal(formatGuardFailure(error), 'CI_PORT_GUARD_FAILED');
  }
  const symbol = Symbol('SYNTHETIC_PRIVATE_VALUE');
  assert.equal(formatGuardFailure(errorWith({ ...diagnostic(), [symbol]: true })), 'CI_PORT_GUARD_FAILED');
});

test('formatter accepts only closed phases, tables, source ports and exactly two upper-case hexadecimal state digits', () => {
  for (const changed of [{ phase: '' }, { phase: 'before_reservation\nPRIVATE' }, { phase: 'startup' },
    { table: 'tcp' }, { table: '/proc/net/tcp' }, { table: 'tcp4\nPRIVATE' },
    { port: 0 }, { port: 54330 }, { port: '54324' }, { port: 54324.5 },
    { state: '' }, { state: '6' }, { state: '006' }, { state: '0a' }, { state: 'GG' }, { state: '06\nPRIVATE' }]) {
    assert.equal(formatGuardFailure(errorWith({ ...diagnostic(), ...changed })), 'CI_PORT_GUARD_FAILED');
  }
  for (const detail of [null, [], 'PRIVATE', Object.create(diagnostic())]) {
    assert.equal(formatGuardFailure(errorWith(detail)), 'CI_PORT_GUARD_FAILED');
  }
});

test('formatter never calls getters, toJSON, string conversion or a diagnostic accessor', () => {
  let accessed = 0;
  const detail = diagnostic();
  Object.defineProperty(detail, 'state', { get() { accessed++; throw new Error('PRIVATE'); } });
  assert.equal(formatGuardFailure(errorWith(detail)), 'CI_PORT_GUARD_FAILED');
  const accessor = new Error('PORT_ALREADY_IN_USE');
  Object.defineProperty(accessor, 'portDiagnostic', { get() { accessed++; throw new Error('PRIVATE'); } });
  assert.equal(formatGuardFailure(accessor), 'CI_PORT_GUARD_FAILED');
  const convert = { ...diagnostic(), toJSON() { accessed++; throw new Error('PRIVATE'); }, toString() { accessed++; throw new Error('PRIVATE'); } };
  assert.equal(formatGuardFailure(errorWith(convert)), 'CI_PORT_GUARD_FAILED');
  const messageAccessor = new Error();
  Object.defineProperty(messageAccessor, 'message', { get() { accessed++; throw new Error('PRIVATE'); } });
  assert.equal(formatGuardFailure(messageAccessor), 'CI_PORT_GUARD_FAILED');
  assert.equal(accessed, 0);
});

test('formatter does not echo arbitrary error messages or stacks even when they look like upper-case codes', () => {
  for (const error of [new Error('SYNTHETIC_PRIVATE_VALUE'), new Error('https://user:secret@example.invalid/'),
    'PORT_ALREADY_IN_USE', { message: 'PORT_ALREADY_IN_USE' }, null, undefined]) {
    assert.equal(formatGuardFailure(error), 'CI_PORT_GUARD_FAILED');
  }
  const known = new Error('RESERVATION_WRITE_FAILED');
  known.stack = 'SYNTHETIC_PRIVATE_VALUE';
  assert.equal(formatGuardFailure(known), 'RESERVATION_WRITE_FAILED');
  known.portDiagnostic = diagnostic();
  assert.equal(formatGuardFailure(known), 'CI_PORT_GUARD_FAILED');
});

test('remote protected ports do not become local conflicts and successful reservation has no diagnostic side effect', () => {
  const remoteOnly = `${header} 0: 00000000:c350 00000000:d434 01\n`;
  const f = fixture({ tables: Object.fromEntries(socketTables.map(([file]) => [file, remoteOnly])) });
  assert.deepEqual(f.run(), { protectedPorts: 12, existingReservationsPreserved: true });
  assert.equal(f.writes, 1);
});

test('CLI catch prints the closed formatter and retains a nonzero exit instead of raw errors', () => {
  const source = readFileSync(new URL('../ci-reserve-supabase-ports.mjs', import.meta.url), 'utf8');
  const main = source.slice(source.lastIndexOf('if (process.argv[1]'));
  assert.ok(main.startsWith('if (process.argv[1]'), 'Real CLI entry must exist');
  assert.match(main, /console\.error\(formatGuardFailure\(error\)\)/);
  assert.match(main, /process\.exitCode = 1/);
  assert.doesNotMatch(main, /console\.(?:error|log)\(error(?:[),.]|\s)/);
});
