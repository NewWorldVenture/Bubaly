import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PG_IMAGE = 'postgres:17@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3';
export const REST_IMAGE = 'postgrest/postgrest:v16.4@sha256:d155c6718ed9a9f990d159a2ab7c0a3f16944dbb6d0a0344557421042acfe0df';
export const MIGRATIONS = [
  ['0256_idempotency_keys.sql', 'c7c133ae9de94a9a00864aceadcbc5c668208e41496fec8b53f0eb447f975bb7'],
  ['0272_rsvp_is_first_person.sql', '534ec9b0283fcda467f82c33afc94d6d5ea4f9ff1ca7e8fb1d62d0554d89be7a'],
  ['0327_autopilot_suggestions_are_not_erasable.sql', '9e2209e7cc5c49b9138c5b08fe0a287cefd645595ffc5073df8186301d09ddbe'],
  ['0486_an_autopilot_card_is_read_by_its_audience.sql', '9e483d8730413fd0a84b798eb6b1c1e36bdd75e7242b6d82f430d3c8391222dd'],
  ['0487_copied_card_reminder_origin.sql', '19927e5fd8ae6bfffaea1805e0f4d6868f364cd26d0a333712c10f4ca1a6abb4'],
];
export const OWNED_FILES = [
  'scripts/run-reminder-cutover-rehearsal.mjs',
  'tests/fixtures/reminder-cutover-predecessor.sql',
  'tests/fixtures/reminder-cutover-hold.sql',
  'tests/runtime/reminder-cutover.native.mjs',
  '.github/workflows/reminder-cutover-rehearsal.yml',
];
export const TABLES = [
  'autopilot_suggestions', 'calendar_events', 'chore_assignments', 'documents',
  'event_rsvps', 'families', 'family_insurance_policies', 'family_members', 'family_reminders', 'grocery_items',
  'meal_plans', 'reminders', 'todo_items', 'transactions',
];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function validateInvocation(args, env, platform) {
  assert(args.length === 0 || (args.length === 1 && args[0] === '--self-check'), 'External connection arguments are refused');
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'DATABASE_URL', 'SUPABASE_DB_URL']) {
    assert(!env[key], 'External database or Docker environment is refused');
  }
  if (args.length === 0) assert.equal(platform, 'linux', 'Native rehearsal requires the isolated Linux job');
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error || result.signal) throw Error('Owned process did not terminate normally');
  return result;
}
function docker(args, input) {
  const result = run('docker', args, { input });
  assert.equal(result.status, 0, 'Owned Docker operation failed: ' + args[0]);
  return result.stdout.trim();
}
function localDocker() {
  assert.equal(docker(['context', 'show']), 'default');
  assert.equal(docker(['context', 'inspect', 'default', '--format', '{{.Endpoints.docker.Host}}']), 'unix:///var/run/docker.sock');
}
function sourcePins() {
  const result = run('git', ['ls-files', '-z']);
  assert.equal(result.status, 0);
  const files = [...new Set([...result.stdout.split('\0').filter(Boolean), ...OWNED_FILES])].sort();
  return Object.fromEntries(files.map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
}
function validateInputs() {
  for (const [file, digest] of MIGRATIONS) assert.equal(sha(fs.readFileSync(path.join(root, 'supabase/migrations', file))), digest, 'Migration input drift: ' + file);
  const reserved = fs.readdirSync(path.join(root, 'supabase/reserved')).filter(file => file.endsWith('.sql')).sort();
  assert.equal(reserved.length, 27, 'Held allocation changed; independent review required');
  // These files are pinned but never loaded into a database.
  return reserved.map(file => ({ path: 'supabase/reserved/' + file, sha256: sha(fs.readFileSync(path.join(root, 'supabase/reserved', file))) }));
}
function selfCheck() {
  const held = validateInputs();
  validateInvocation(['--self-check'], {}, 'win32');
  let controls = 0;
  for (const args of [['--url', 'postgres://synthetic.invalid'], ['--privacy-sql', 'other.sql'], ['--apply'], ['--self-check', 'extra']]) {
    assert.throws(() => validateInvocation(args, {}, 'linux')); controls++;
  }
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'PGHOST', 'PGPASSWORD', 'PGSERVICE', 'DATABASE_URL']) {
    assert.throws(() => validateInvocation([], { [key]: 'synthetic' }, 'linux')); controls++;
  }
  assert.throws(() => validateInvocation([], {}, 'win32')); controls++;
  assert.equal(TABLES.length, 14); assert.equal(new Set(TABLES).size, 14);
  console.log(JSON.stringify({ staticOnly: true, refusalControls: controls, migrationsPinned: MIGRATIONS.length, heldFilesPinned: held.length, nativeExecuted: false }));
}

export class OwnedRuntime {
  constructor(output) {
    this.marker = crypto.randomBytes(16).toString('hex');
    this.prefix = 'bubaly-cutover-' + this.marker;
    this.network = this.prefix + '-network';
    this.pg = this.prefix + '-pg';
    this.rest = this.prefix + '-rest';
    this.output = output;
    this.sessions = new Set();
    this.sockets = new Set();
    this.operations = [];
    this.sequence = 0;
    this.relay = null;
  }
  attest() {
    localDocker();
    assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "bubaly.cutover-run"}}', this.pg]), this.marker);
    assert.equal(docker(['inspect', '--format', '{{.Config.Image}}', this.pg]), PG_IMAGE);
    assert.equal(docker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', this.pg]), this.network);
    assert.equal(docker(['network', 'inspect', '--format', '{{.Internal}}', this.network]), 'true');
    assert.equal(docker(['port', this.pg]), '');
  }
  args(login = 'cutover_maint') {
    assert(['cutover_maint', 'authenticator', 'cutover_old_writer'].includes(login), 'Unowned login refused');
    this.attest();
    return ['exec', '-i', this.pg, 'psql', '-X', '-A', '-t', '--file=-', '--host=/var/run/postgresql', '--username=' + login, '--dbname=cutover_runtime', '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=verbose'];
  }
  sql(text, { login = 'cutover_maint', allowFailure = false, singleTransaction = false } = {}) {
    const args = this.args(login);
    if (singleTransaction) args.push('--single-transaction');
    const result = run('docker', args, { input: text, timeout: 15000 });
    const event = { index: ++this.sequence, login, inputSha256: sha(text), exit: result.status, sqlstates: [...new Set([...result.stderr.matchAll(/ERROR:\s+([0-9A-Z]{5}):/g)].map(match => match[1]))] };
    this.operations.push(event);
    fs.writeFileSync(path.join(this.output, `sql-${event.index}.private.json`), JSON.stringify({ ...event, stdout: result.stdout, stderr: result.stderr }), { mode: 0o600 });
    if (!allowFailure) assert.equal(result.status, 0, 'Owned SQL operation failed at operation ' + event.index + ': ' + event.sqlstates.join(','));
    return result;
  }
  json(text) { return JSON.parse(this.sql(text).stdout.trim()); }
  session(login = 'cutover_maint') {
    const child = spawn('docker', this.args(login), { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const record = { child, stdout: '', stderr: '', closed: false, code: null };
    child.stdout.on('data', bytes => { record.stdout += bytes.toString(); });
    child.stderr.on('data', bytes => { record.stderr += bytes.toString(); });
    record.done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => { record.closed = true; record.code = code; resolve(record); });
    });
    this.sessions.add(record);
    return record;
  }
  async wait(predicate, message, timeout = 5000) {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      if (await predicate()) return;
      await pause(25);
    }
    throw Error(message);
  }
  async setup() {
    localDocker();
    docker(['network', 'create', '--internal', '--label', 'bubaly.cutover-run=' + this.marker, this.network]);
    docker(['run', '--detach', '--name', this.pg, '--network', this.network, '--network-alias', 'pg', '--label', 'bubaly.cutover-run=' + this.marker, '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', '--env', 'POSTGRES_DB=cutover_runtime', PG_IMAGE]);
    // pg_isready failures are bounded readiness probes, never repeated test runs.
    await this.wait(() => run('docker', ['exec', this.pg, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'cutover_runtime', '-t', '2']).status === 0, 'Owned PostgreSQL readiness deadline', 60000);
    this.attest();
    docker(['exec', '-i', this.pg, 'psql', '-X', '-U', 'postgres', '-d', 'cutover_runtime', '-v', 'ON_ERROR_STOP=1'], 'create role cutover_maint login superuser;');
    this.sql(fs.readFileSync(path.join(root, 'tests/fixtures/reminder-cutover-predecessor.sql'), 'utf8'), { singleTransaction: true });
    this.secret = crypto.randomBytes(48).toString('hex');
    // Crucially, actual application sessions log in as authenticator, never postgres.
    docker(['run', '--detach', '--name', this.rest, '--network', this.network, '--label', 'bubaly.cutover-run=' + this.marker,
      '--env', 'PGRST_DB_URI=postgres://authenticator@pg:5432/cutover_runtime', '--env', 'PGRST_DB_SCHEMAS=public',
      '--env', 'PGRST_DB_ANON_ROLE=anon', '--env', 'PGRST_DB_CONFIG=false', '--env', 'PGRST_JWT_SECRET=' + this.secret,
      '--env', 'PGRST_SERVER_PORT=3000', REST_IMAGE]);
    assert.equal(docker(['inspect', '--format', '{{.Config.Image}}', this.rest]), REST_IMAGE);
    assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "bubaly.cutover-run"}}', this.rest]), this.marker);
    assert.equal(docker(['port', this.rest]), '');
    const ip = docker(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', this.rest]);
    assert(/^(?:172|10|192)\.\d+\.\d+\.\d+$/.test(ip));
    this.relay = net.createServer(socket => {
      const target = net.connect(3000, ip);
      for (const connection of [socket, target]) { this.sockets.add(connection); connection.once('close', () => this.sockets.delete(connection)); }
      target.on('error', () => socket.destroy()); socket.on('error', () => target.destroy());
      socket.on('close', () => target.destroy()); target.on('close', () => socket.destroy());
      socket.pipe(target).pipe(socket);
    });
    await new Promise((resolve, reject) => { this.relay.once('error', reject); this.relay.listen(0, '127.0.0.1', resolve); });
    this.base = 'http://127.0.0.1:' + this.relay.address().port;
    await this.wait(async () => { try { return (await fetch(this.base + '/', { redirect: 'error', signal: AbortSignal.timeout(2000) })).status === 200; } catch { return false; } }, 'Owned PostgREST readiness deadline', 60000);
  }
  token(role, sub) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ role, ...(sub ? { sub } : {}), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    return header + '.' + body + '.' + crypto.createHmac('sha256', this.secret).update(header + '.' + body).digest('base64url');
  }
  async request(role, sub, route, method = 'GET', body) {
    const url = new URL(route, this.base);
    assert.equal(url.origin, this.base); assert(route.startsWith('/') && !route.startsWith('//'));
    const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + this.token(role, sub), 'Content-Type': 'application/json', Prefer: 'return=representation' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  }
  async reload() {
    this.sql("notify pgrst,'reload schema';");
    await this.wait(async () => {
      const result = await this.request('authenticated', this.users.parent, '/');
      return result.status === 200 && result.data.paths?.['/rpc/create_card_family_reminder'];
    }, 'Exact new RPC is absent after schema reload', 10000);
  }
  fixture(name) { assert(['reminder-cutover-hold.sql'].includes(name)); return fs.readFileSync(path.join(root, 'tests/fixtures', name), 'utf8'); }
  migration(index) { const [name, digest] = MIGRATIONS[index]; const bytes = fs.readFileSync(path.join(root, 'supabase/migrations', name)); assert.equal(sha(bytes), digest); return bytes.toString(); }
  async cleanup() {
    for (const session of this.sessions) {
      if (!session.closed) { session.child.stdin.end('rollback;\n\\q\n'); await Promise.race([session.done, pause(1000)]); }
      if (!session.closed) session.child.kill('SIGTERM');
    }
    if (this.relay) {
      for (const socket of this.sockets) socket.destroy();
      await new Promise(resolve => this.relay.close(resolve));
      await new Promise((resolve, reject) => {
        const socket = net.connect(new URL(this.base).port, '127.0.0.1');
        socket.once('connect', () => { socket.destroy(); reject(Error('Owned relay remained reachable')); });
        socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
      });
    }
    localDocker();
    for (const id of docker(['ps', '-aq', '--filter', 'label=bubaly.cutover-run=' + this.marker]).split('\n').filter(Boolean)) {
      assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "bubaly.cutover-run"}}', id]), this.marker);
      assert([this.pg, this.rest].includes(docker(['inspect', '--format', '{{.Name}}', id]).replace(/^\//, '')));
      docker(['rm', '--force', '--volumes', id]);
    }
    assert.equal(docker(['ps', '-aq', '--filter', 'label=bubaly.cutover-run=' + this.marker]), '');
    const networks = docker(['network', 'ls', '-q', '--filter', 'label=bubaly.cutover-run=' + this.marker]).split('\n').filter(Boolean);
    for (const id of networks) {
      assert.equal(docker(['network', 'inspect', '--format', '{{.Name}}', id]), this.network);
      assert.equal(docker(['network', 'inspect', '--format', '{{index .Labels "bubaly.cutover-run"}}', id]), this.marker);
      docker(['network', 'rm', id]);
    }
    assert.equal(docker(['network', 'ls', '-q', '--filter', 'label=bubaly.cutover-run=' + this.marker]), '');
    for (const session of this.sessions) await session.done;
    assert([...this.sessions].every(session => session.closed), 'An owned SQL adapter remained active');
  }
}

async function main() {
  validateInvocation(process.argv.slice(2), process.env, process.platform);
  if (process.argv[2] === '--self-check') return selfCheck();
  const held = validateInputs();
  const before = sourcePins();
  const output = path.join(root, 'cutover-runtime-results', crypto.randomBytes(16).toString('hex'));
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(output, 'source-before.json'), JSON.stringify(before));
  const runtime = new OwnedRuntime(output);
  const report = { nativeExecuted: false, passed: false, cases: [], heldInputs: held, migrationInputs: MIGRATIONS, ownedCleanup: false, sourceStable: false };
  try {
    await runtime.setup();
    report.nativeExecuted = true;
    const { rehearse } = await import('../tests/runtime/reminder-cutover.native.mjs');
    await rehearse(runtime, report);
    report.passed = true;
  } catch (error) {
    report.failure = { name: error.name, message: error.message };
    fs.writeFileSync(path.join(output, 'failure.private.log'), error.stack ?? String(error), { mode: 0o600 });
    process.exitCode = 1;
  } finally {
    try { await runtime.cleanup(); report.ownedCleanup = true; }
    catch (error) { report.cleanupFailure = error.message; report.passed = false; process.exitCode = 1; }
    const after = sourcePins();
    fs.writeFileSync(path.join(output, 'source-after.json'), JSON.stringify(after));
    report.sourceStable = JSON.stringify(before) === JSON.stringify(after);
    report.sourceBeforeSha256 = sha(JSON.stringify(before));
    report.sourceAfterSha256 = sha(JSON.stringify(after));
    if (!report.sourceStable) { report.passed = false; process.exitCode = 1; }
    report.operations = runtime.operations;
    report.terminal = true;
    report.limits = [
      'Synthetic declared predecessor and minimal witnesses; not a production schema clone.',
      'Ten direct tables and four declared dependency tables; owner/superuser DDL is outside the barrier boundary.',
      'auth.users and reminder_lists FK/cascade lifecycles, catalog/routine/extension drift and unenumerated dependencies are outside this bounded predecessor model.',
      'Per-file commits are not whole-chain atomicity. Rehearsal receipts are not the Supabase migration ledger.',
      'Post-removal API acceptance is isolated rehearsal evidence; controlled production acceptance while held remains unresolved.',
      'No production credentials, configuration, SQL, application deployment or automatic retry.',
    ];
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 2; });
}
