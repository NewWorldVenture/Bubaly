// Synthetic kernel mechanism proof, never a Supabase startup/retry or host tuning tool.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '..');
const workflow = join(root, '.github/workflows/supabase-port-rehearsal.yml');
const kernelFiles = {
  range: '/proc/sys/net/ipv4/ip_local_port_range',
  reserved: '/proc/sys/net/ipv4/ip_local_reserved_ports',
};
const ports = new Set([18080, 54322, 54323]);
const forbiddenEnv = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DATABASE_URL', 'SUPABASE_DB_URL',
  'PGHOST', 'PGPORT', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGPASSWORD', 'PGOPTIONS'];
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const pins = () => ({ script: sha(script), workflow: sha(workflow) });
const kernel = () => Object.fromEntries(Object.entries(kernelFiles).map(([key, path]) => [key, readFileSync(path, 'utf8')]));
const namespace = pid => readlinkSync(`/proc/${pid}/ns/net`);
function requireThat(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}
const errorCode = error => /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'REHEARSAL_ASSERTION_FAILED';
const checkPins = expected => requireThat(JSON.stringify(pins()) === JSON.stringify(expected), 'SOURCE_CHANGED');

export function validateController(env, platform, uid) {
  requireThat(platform === 'linux', 'REFUSE_NON_LINUX');
  requireThat(Number.isInteger(uid) && uid > 0, 'REFUSE_ROOT_CONTROLLER');
  requireThat(env.CI === 'true' && env.GITHUB_ACTIONS === 'true', 'REFUSE_NON_CI');
  requireThat(env.GITHUB_REPOSITORY === 'NewWorldVenture/Bubaly', 'REFUSE_REPOSITORY');
  requireThat(env.GITHUB_JOB === 'port-rehearsal', 'REFUSE_JOB');
  requireThat(/^\d+$/.test(env.GITHUB_RUN_ID ?? '') && /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'REFUSE_RUN_ID');
  requireThat(isAbsolute(env.RUNNER_TEMP ?? '') && isAbsolute(env.GITHUB_EVENT_PATH ?? ''), 'REFUSE_RUNNER_PATHS');
  requireThat(/^[a-f0-9]{40}$/.test(env.BUBALY_PORT_REHEARSAL_HEAD ?? ''), 'REFUSE_HEAD');
  requireThat(env.GITHUB_EVENT_NAME === 'pull_request' ||
    (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main'), 'REFUSE_EVENT');
  for (const name of forbiddenEnv) requireThat(!Object.hasOwn(env, name), 'REFUSE_CONNECTION_OVERRIDE');
}

// This same guard runs before `ip link` and again before EVERY namespace sysctl write.
// PID 1 independently anchors the host namespace; a supplied "parent" alone is insufficient.
export function validateNamespace(actual, manifest, currentPins) {
  requireThat(actual.platform === 'linux' && actual.uid === 0, 'REFUSE_CHILD_PLATFORM');
  requireThat(actual.self !== actual.init, 'REFUSE_HOST_NAMESPACE');
  requireThat(actual.parent === actual.init && actual.parent === manifest.hostNamespace, 'REFUSE_PARENT_NAMESPACE');
  requireThat(actual.parentUid === manifest.controllerUid && actual.parentUid > 0, 'REFUSE_PARENT_UID');
  requireThat(actual.parentStart === manifest.controllerStart, 'REFUSE_PARENT_REUSED');
  requireThat(actual.parentExecutable === manifest.executable, 'REFUSE_PARENT_EXECUTABLE');
  requireThat(actual.parentIsAncestor, 'REFUSE_UNRELATED_PARENT');
  requireThat(/^[a-f0-9-]{36}$/.test(manifest.nonce ?? ''), 'REFUSE_NONCE');
  requireThat(manifest.script === script && manifest.workflow === workflow, 'REFUSE_SOURCE_PATH');
  requireThat(JSON.stringify(currentPins) === JSON.stringify(manifest.sourcePins), 'SOURCE_CHANGED');
  requireThat(['proof', 'injected-failure', 'host-refusal', 'source-refusal'].includes(manifest.operation), 'REFUSE_OPERATION');
}

function processInfo(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  return { parent: Number(fields[1]), start: fields[19],
    uid: Number(status.match(/^Uid:\s+(\d+)/m)?.[1]), executable: readlinkSync(`/proc/${pid}/exe`) };
}
function isAncestor(pid) {
  let cursor = process.ppid;
  for (let depth = 0; depth < 12 && cursor > 1; depth++) {
    if (cursor === pid) return true;
    cursor = processInfo(cursor).parent;
  }
  return false;
}
function actualNamespace(manifest) {
  const parent = processInfo(manifest.controllerPid);
  return { platform: process.platform, uid: process.getuid(), self: namespace('self'), init: namespace(1),
    parent: namespace(manifest.controllerPid), parentUid: parent.uid, parentStart: parent.start,
    parentExecutable: parent.executable, parentIsAncestor: isAncestor(manifest.controllerPid) };
}
function command(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 64_000,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
  requireThat(!result.error && result.status === 0, 'NAMESPACE_COMMAND_FAILED');
  return result.stdout;
}
function assertLoopbackOnly() {
  const links = JSON.parse(command('ip', ['-j', 'link', 'show']));
  requireThat(links.length === 1 && links[0].ifname === 'lo', 'REFUSE_EXTERNAL_INTERFACE');
  for (const family of ['-4', '-6']) {
    const routes = JSON.parse(command('ip', ['-j', family, 'route', 'show', 'table', 'all']));
    requireThat(routes.every(route => route.dev === 'lo'), 'REFUSE_EXTERNAL_ROUTE');
  }
}
function socketRows() {
  // No remote addresses, command lines, environment variables or payloads are retained.
  return ['/proc/net/tcp', '/proc/net/tcp6'].flatMap(path =>
    readFileSync(path, 'utf8').trim().split('\n').slice(1).flatMap(line => {
      const fields = line.trim().split(/\s+/);
      const port = Number.parseInt(fields[1].split(':')[1], 16);
      return ports.has(port) ? [{ family: path.endsWith('6') ? 6 : 4, localPort: port,
        state: fields[3], inode: fields[9] }] : [];
    }));
}
function bounded(promise, code, ms = 3000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms);
  })]).finally(() => clearTimeout(timer));
}
function parseReserved(text) {
  const values = new Set();
  for (const part of text.trim().split(',').filter(Boolean)) {
    requireThat(/^\d+(?:-\d+)?$/.test(part), 'INVALID_RESERVED_PORTS');
    const [start, suppliedEnd] = part.split('-').map(Number), end = suppliedEnd ?? start;
    requireThat(start >= 1 && end <= 65535 && start <= end, 'INVALID_RESERVED_PORTS');
    for (let port = start; port <= end; port++) values.add(port);
  }
  return values;
}
function addReserved(text, port) {
  const values = parseReserved(text);
  values.add(port);
  return [...values].sort((a, b) => a - b).join(',') + '\n';
}

async function child(manifest) {
  const result = { operation: manifest.operation, nonce: manifest.nonce, pid: process.pid,
    start: process.platform === 'linux' ? processInfo(process.pid).start : null,
    cases: [], primaryError: null, cleanupErrors: [], namespaceWrites: 0, linkMutations: 0 };
  let guarded = false, initial;
  const sockets = new Set(), servers = new Set();
  const guard = () => validateNamespace(actualNamespace(manifest), manifest, pins());
  const pass = (name, detail = {}) => result.cases.push({ name, status: 'PASS', ...detail });
  const ownSocket = socket => {
    sockets.add(socket);
    socket.on('error', () => {}); // Each operation separately asserts its expected outcome.
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const closeSocket = async socket => {
    if (socket.closed) return;
    const closed = new Promise(resolve => socket.once('close', resolve));
    if (socket.readyState === 'open') socket.resetAndDestroy();
    else socket.destroy();
    await bounded(closed, 'SOCKET_CLOSE_TIMEOUT');
  };
  const closeServer = async server => {
    if (!servers.has(server)) return;
    await bounded(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 'SERVER_CLOSE_TIMEOUT');
    servers.delete(server);
  };
  const listen = async (port, host = '127.0.0.1', onConnection = () => {}) => {
    const server = net.createServer(socket => onConnection(ownSocket(socket)));
    servers.add(server);
    try {
      await bounded(new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ port, host, exclusive: true }, resolve);
      }), 'LISTEN_TIMEOUT');
      return server;
    } catch (error) {
      if (!server.listening) servers.delete(server);
      throw error;
    }
  };
  const writeKernel = (key, value) => {
    guard();
    requireThat(Object.hasOwn(kernelFiles, key), 'REFUSE_SYSCTL_PATH');
    writeFileSync(kernelFiles[key], value);
    result.namespaceWrites++;
  };
  const closeFailure = async fn => {
    try { await fn(); } catch (error) { result.cleanupErrors.push(errorCode(error)); }
  };
  try {
    guard(); // Absolutely no namespace mutation precedes this guard.
    guarded = true;
    initial = kernel();
    result.namespace = namespace('self');
    result.hostNamespace = namespace(1);
    assertLoopbackOnly();
    requireThat(socketRows().length === 0, 'REFUSE_PREEXISTING_TEST_SOCKET');
    command('ip', ['link', 'set', 'dev', 'lo', 'up']);
    result.linkMutations++;
    assertLoopbackOnly();
    pass('distinct owned namespace; only loopback interfaces and routes');

    const accepted = [];
    await listen(18080, '127.0.0.1', socket => accepted.push(socket));
    const connect = async () => {
      const socket = ownSocket(net.createConnection({ host: '127.0.0.1', port: 18080 }));
      await bounded(new Promise((resolve, reject) => {
        socket.once('connect', resolve); socket.once('error', reject);
      }), 'CONNECT_TIMEOUT');
      requireThat(socket.remoteAddress === '127.0.0.1', 'REFUSE_NON_LOOPBACK_PEER');
      return socket;
    };
    // Deliberately tiny namespace-local range makes the mechanism deterministic,
    // rather than assuming this was the range or traffic pattern in the failed CI job.
    writeKernel('range', '54322 54323\n');
    writeKernel('reserved', '60000\n');
    requireThat(kernel().range.trim().split(/\s+/).join(' ') === '54322 54323', 'RANGE_NOT_APPLIED');
    const first = await connect(), second = await connect();
    assert.deepEqual([first.localPort, second.localPort].sort((a, b) => a - b), [54322, 54323]);
    pass('automatic allocation occupies both constrained ephemeral ports');
    const heldRows = socketRows().filter(row => row.localPort === 54322);
    requireThat(heldRows.some(row => row.state === '01') && !heldRows.some(row => row.state === '0A'), 'EXPECTED_ESTABLISHED_WITHOUT_LISTENER');
    pass('54322 has an established connection and no listener', { rows: heldRows });
    await assert.rejects(() => listen(54322, '0.0.0.0'), error => error.code === 'EADDRINUSE');
    pass('wildcard service bind fails with real EADDRINUSE for a non-listening connection');
    if (manifest.operation === 'injected-failure') throw Object.assign(new Error('INJECTED_AFTER_COLLISION'), { code: 'INJECTED_AFTER_COLLISION' });

    await closeSocket(first); await closeSocket(second);
    for (const socket of [...accepted]) await closeSocket(socket);
    const released = await listen(54322, '0.0.0.0');
    pass('closing only owned connections releases54322 for an explicit bind');
    await closeServer(released);
    const beforeReserved = kernel().reserved;
    writeKernel('reserved', addReserved(beforeReserved, 54322));
    const afterReserved = parseReserved(kernel().reserved);
    requireThat([...parseReserved(beforeReserved)].every(port => afterReserved.has(port)) && afterReserved.has(54322), 'RESERVATION_NOT_ADDITIVE');
    pass('adding reserved54322 preserves preexisting reserved60000');
    const reservationClient = await connect();
    requireThat(reservationClient.localPort === 54323, 'RESERVED_PORT_AUTOMATICALLY_ASSIGNED');
    pass('automatic connection uses54323 while54322 is reserved');
    const explicit = await listen(54322, '0.0.0.0');
    requireThat(socketRows().some(row => row.localPort === 54322 && row.state === '0A'), 'EXPECTED_REAL_LISTENER');
    pass('reservation permits an explicit service listener on54322');
    await assert.rejects(() => listen(54322, '0.0.0.0'), error => error.code === 'EADDRINUSE');
    pass('a real existing listener still refuses a second bind');
    await closeServer(explicit);
    const afterListener = await listen(54322, '0.0.0.0');
    await closeServer(afterListener);
    pass('closing the owned listener releases its port');
    checkPins(manifest.sourcePins);
  } catch (error) {
    result.primaryError = errorCode(error);
  } finally {
    for (const socket of [...sockets]) await closeFailure(() => closeSocket(socket));
    for (const server of [...servers]) await closeFailure(() => closeServer(server));
    let restoredNamespaceSysctls = false;
    if (guarded && initial) {
      await closeFailure(async () => {
        writeKernel('reserved', initial.reserved);
        writeKernel('range', initial.range);
        assert.deepEqual(kernel(), initial);
        restoredNamespaceSysctls = true;
      });
      await closeFailure(async () => {
        requireThat(sockets.size === 0 && servers.size === 0, 'OWNED_SOCKET_REMAINS');
        requireThat(!socketRows().some(row => ['01', '0A'].includes(row.state)), 'ACTIVE_TEST_SOCKET_REMAINS');
        assertLoopbackOnly();
        checkPins(manifest.sourcePins);
      });
    }
    result.cleanup = { trackedSockets: sockets.size, trackedServers: servers.size,
      restoredNamespaceSysctls };
  }
  result.status = result.primaryError || result.cleanupErrors.length ? 'FAIL' : 'PASS';
  return result;
}

function selfCheck() {
  const env = { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'NewWorldVenture/Bubaly',
    GITHUB_JOB: 'port-rehearsal', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
    RUNNER_TEMP: resolve('synthetic-temp'), GITHUB_EVENT_PATH: resolve('synthetic-event'),
    GITHUB_EVENT_NAME: 'pull_request', BUBALY_PORT_REHEARSAL_HEAD: 'a'.repeat(40) };
  let count = 0;
  validateController(env, 'linux', 1001); count++;
  for (const [field, value] of [['CI', 'false'], ['GITHUB_ACTIONS', 'false'], ['GITHUB_REPOSITORY', 'other/repo'],
    ['GITHUB_JOB', 'e2e'], ['GITHUB_RUN_ID', '../foreign'], ['GITHUB_RUN_ATTEMPT', ''],
    ['RUNNER_TEMP', 'relative'], ['GITHUB_EVENT_PATH', 'relative'], ['BUBALY_PORT_REHEARSAL_HEAD', 'branch'],
    ['GITHUB_EVENT_NAME', 'workflow_dispatch'], ...forbiddenEnv.map(name => [name, 'synthetic'])]) {
    assert.throws(() => validateController({ ...env, [field]: value }, 'linux', 1001)); count++;
  }
  assert.throws(() => validateController(env, 'win32', 1001)); count++;
  assert.throws(() => validateController(env, 'linux', 0)); count++;
  const sourcePins = pins();
  const manifest = { hostNamespace: 'net:[10]', controllerUid: 1001, controllerStart: '123',
    executable: '/synthetic/node', nonce: randomUUID(), script, workflow, sourcePins, operation: 'proof' };
  const actual = { platform: 'linux', uid: 0, self: 'net:[20]', init: 'net:[10]', parent: 'net:[10]',
    parentUid: 1001, parentStart: '123', parentExecutable: '/synthetic/node', parentIsAncestor: true };
  validateNamespace(actual, manifest, sourcePins); count++;
  for (const [field, value] of [['platform', 'win32'], ['uid', 1001], ['self', 'net:[10]'],
    ['parent', 'net:[30]'], ['parentUid', 0], ['parentStart', '456'],
    ['parentExecutable', '/foreign/node'], ['parentIsAncestor', false]]) {
    assert.throws(() => validateNamespace({ ...actual, [field]: value }, manifest, sourcePins)); count++;
  }
  for (const [field, value] of [['hostNamespace', 'net:[30]'], ['nonce', 'bad'], ['script', '/foreign/script'],
    ['workflow', '/foreign/workflow'], ['operation', 'host-write'], ['sourcePins', {}]]) {
    assert.throws(() => validateNamespace(actual, { ...manifest, [field]: value }, sourcePins)); count++;
  }
  assert.deepEqual([...parseReserved(addReserved('60000,60002-60003\n', 54322))], [54322, 60000, 60002, 60003]); count++;
  for (const invalid of ['0', '65536', '2-1', '1;2', 'one']) { assert.throws(() => parseReserved(invalid)); count++; }
  console.log(JSON.stringify({ status: 'PASS', scope: 'static invocation/namespace/refusal/parser controls; no native Linux execution', cases: count, sourcePins }));
}

async function controller() {
  validateController(process.env, process.platform, process.getuid?.());
  const expected = process.env.BUBALY_PORT_REHEARSAL_HEAD;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    requireThat(event.pull_request?.head?.repo?.full_name === 'NewWorldVenture/Bubaly' &&
      event.pull_request.head.sha === expected, 'REFUSE_FOREIGN_PR');
  } else requireThat(event.after === expected, 'REFUSE_PUSH_HEAD');
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, cwd: root });
  requireThat(git.status === 0 && git.stdout.trim() === expected, 'REFUSE_CHECKOUT_HEAD');
  requireThat(namespace('self') === namespace(1), 'REFUSE_NON_HOST_CONTROLLER');
  requireThat(realpathSync(script) === script && realpathSync(workflow) === workflow, 'REFUSE_SOURCE_SYMLINK');
  const sourcePins = pins(), hostBefore = kernel(), hostNamespace = namespace('self');
  const controllerIdentity = processInfo(process.pid);
  const output = join(realpathSync(process.env.RUNNER_TEMP), `bubaly-port-rehearsal-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
  requireThat(!existsSync(output), 'REFUSE_EXISTING_OUTPUT');
  mkdirSync(output);
  const summary = { at: new Date().toISOString(), head: expected, sourcePins, hostNamespace, hostBefore,
    children: [], primaryError: null, cleanupErrors: [], status: 'FAIL',
    limits: ['Mechanism proof under a deliberately constrained private namespace range.',
      'Does not identify the historical CI socket owner, actual range, registry causality or Docker daemon behavior.',
      'No Supabase, Docker, provider, production, host sysctl or existing CI startup change.'] };
  try {
    for (const operation of ['host-refusal', 'source-refusal', 'injected-failure', 'proof']) {
      const manifest = { operation, nonce: randomUUID(), sourcePins: operation === 'source-refusal' ? { ...sourcePins, script: '0'.repeat(64) } : sourcePins,
        hostNamespace, controllerPid: process.pid, controllerUid: process.getuid(),
        controllerStart: controllerIdentity.start, executable: process.execPath, script, workflow };
      const isolated = operation !== 'host-refusal';
      const args = ['-n', '--', '/usr/bin/timeout', '--signal=TERM', '--kill-after=2s', '45s',
        ...(isolated ? ['/usr/bin/unshare', '--net', '--fork', '--kill-child=KILL', '--'] : []),
        process.execPath, script, '--namespace-child'];
      const childHostBefore = kernel();
      let childResult, primaryChildError;
      try {
        const spawned = spawnSync('sudo', args, { input: JSON.stringify(manifest), encoding: 'utf8',
          timeout: 55_000, maxBuffer: 100_000, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
        // Retain the first actual outcome even if startup/JSON/identity checks fail.
        // The child receives a scrubbed environment and emits only this synthetic report.
        const observed = { operation, exit: spawned.status, signal: spawned.signal,
          launchError: spawned.error ? errorCode(spawned.error) : null,
          stdout: spawned.stdout ?? '', stderr: spawned.stderr ?? '' };
        summary.children.push(observed);
        requireThat(!spawned.error && spawned.signal === null, 'CHILD_LAUNCH_OR_TIMEOUT');
        requireThat(observed.stderr.length === 0, 'CHILD_UNEXPECTED_STDERR');
        childResult = JSON.parse(observed.stdout);
        Object.assign(observed, { result: childResult });
        requireThat(childResult.nonce === manifest.nonce && childResult.operation === operation, 'CHILD_IDENTITY_MISMATCH');
        requireThat(childResult.cleanupErrors.length === 0, 'CHILD_CLEANUP_FAILED');
        requireThat(childResult.cleanup.trackedSockets === 0 && childResult.cleanup.trackedServers === 0, 'CHILD_SOCKET_REMAINS');
        const expectedError = { 'host-refusal': 'REFUSE_HOST_NAMESPACE', 'source-refusal': 'SOURCE_CHANGED',
          'injected-failure': 'INJECTED_AFTER_COLLISION', proof: null }[operation];
        requireThat(childResult.primaryError === expectedError && spawned.status === (expectedError ? 1 : 0), 'CHILD_UNEXPECTED_OUTCOME');
        if (operation.endsWith('refusal')) requireThat(childResult.namespaceWrites === 0 && childResult.linkMutations === 0, 'REFUSAL_MUTATED_NAMESPACE');
        else requireThat(childResult.cleanup.restoredNamespaceSysctls && childResult.namespace !== hostNamespace, 'CHILD_NAMESPACE_NOT_CLEAN');
        requireThat(childResult.cases.length === (operation === 'proof' ? 10 : operation === 'injected-failure' ? 4 : 0), 'NATIVE_CASE_COUNT_CHANGED');
        if (existsSync(`/proc/${childResult.pid}/stat`)) {
          requireThat(processInfo(childResult.pid).start !== childResult.start, 'OWNED_CHILD_REMAINS');
        }
        checkPins(sourcePins);
      } catch (error) {
        primaryChildError = error;
        throw error;
      } finally {
        try {
          assert.deepEqual(kernel(), childHostBefore, 'Host sysctls changed across child execution');
          requireThat(namespace('self') === hostNamespace, 'HOST_NAMESPACE_CHANGED');
        } catch (error) {
          summary.cleanupErrors.push(errorCode(error));
          if (!primaryChildError) throw error;
        }
      }
    }
  } catch (error) {
    summary.primaryError = errorCode(error);
  } finally {
    try {
      summary.hostAfter = kernel();
      assert.deepEqual(summary.hostAfter, hostBefore);
      requireThat(namespace('self') === hostNamespace, 'HOST_NAMESPACE_CHANGED');
      checkPins(sourcePins);
      summary.hostSysctlsByteEqual = true;
    } catch (error) { summary.cleanupErrors.push(errorCode(error)); }
    summary.status = summary.primaryError || summary.cleanupErrors.length ? 'FAIL' : 'PASS';
    writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify({ status: summary.status, children: summary.children.length,
    hostSysctlsByteEqual: summary.hostSysctlsByteEqual === true, sourcePins, primaryError: summary.primaryError }));
  if (summary.status !== 'PASS') process.exitCode = 1;
}

const mode = process.argv.slice(2);
if (mode.length === 1 && mode[0] === '--self-check') selfCheck();
else if (mode.length === 1 && mode[0] === '--namespace-child') {
  // Root children receive one bounded controller manifest on stdin; no target URL,
  // arbitrary sysctl, Docker socket, provider key or command can be supplied.
  try {
    requireThat(process.platform === 'linux', 'REFUSE_NON_LINUX');
    const input = readFileSync(0, 'utf8');
    requireThat(input.length < 16_000, 'REFUSE_MANIFEST_SIZE');
    const result = await child(JSON.parse(input));
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'PASS' ? 0 : 1;
  } catch (error) { console.error(errorCode(error)); process.exitCode = 1; }
} else if (mode.length === 0) {
  controller().catch(error => { console.error(errorCode(error)); process.exitCode = 1; });
} else { console.error('REFUSE_ARGUMENTS'); process.exitCode = 1; }
