// Requires an independently started, explicitly named disposable PostgreSQL 17
// cluster. Creates one fresh owned DB, uses only synthetic data, and removes it.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = 'supabase/migrations/0479_sync_atomic_pull.sql';
const migrationHash = createHash('sha256').update(readFileSync(join(ROOT, MIGRATION))).digest('hex');
const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, args) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), args[i + 1]]);
  return pairs;
}, []));
assert(isAbsolute(options['postgres-bin'] ?? '') && isAbsolute(options['expected-data-dir'] ?? ''),
  'Explicit absolute --postgres-bin and --expected-data-dir paths are required.');
assert(/^\d{1,5}$/.test(options.port ?? '') && Number(options.port) > 0 && Number(options.port) <= 65535,
  'An explicit valid localhost --port is required.');
const expectedServerPort = options['expected-server-port'] ?? options.port;
assert(/^\d{1,5}$/.test(expectedServerPort) && Number(expectedServerPort) > 0 && Number(expectedServerPort) <= 65535,
  'The expected server port must be valid.');
const executable = name => join(options['postgres-bin'], name + (process.platform === 'win32' ? '.exe' : ''));
const connection = ['-h', '127.0.0.1', '-p', options.port, '-U', 'postgres', '-w'];
const database = 'synthetic_sync_pull_' + randomUUID().replaceAll('-', '');
const clients = new Set();
let created = false, completed = 0;
const q = value => "'" + String(value).replaceAll("'", "''") + "'";
function command(sql, db = database) {
  return execFileSync(executable('psql'), [...connection, '-X', '-d', db, '-qAt',
    '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-c', sql],
  { cwd: ROOT, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PGCONNECT_TIMEOUT: '5' } }).trim();
}
const [actualDirectory, actualServerPort, version, login] = command('show data_directory; show port; show server_version_num; select session_user;', 'postgres').split(/\r?\n/);
const normalized = path => {
  const value = resolve(path).replaceAll('\\', '/');
  return process.platform === 'win32' ? value.toLowerCase() : value;
};
assert.equal(normalized(actualDirectory), normalized(options['expected-data-dir']),
  'Refusing writes: this is not the explicitly named disposable cluster.');
assert.equal(actualServerPort, expectedServerPort, 'Refusing writes: server port did not match the explicitly expected port.');
assert.match(version, /^17\d{4}$/, 'This contract requires PostgreSQL 17.');
assert.equal(login, 'postgres', 'The fixture connection must use the explicit postgres role.');
// SHOW port is the server's internal port, which differs from the CI loopback
// Docker mapping. Validate its explicit expected server port separately from
// the libpq loopback client port; the default is the same port for local clusters.
const json = sql => JSON.parse(command(sql).split(/\r?\n/).at(-1));
const service = sql => `set role service_role; set request.jwt.claim.sub=''; ${sql}`;
const owner = (x, sql) => `set role authenticated; set request.jwt.claim.sub=${q(x.user)}; ${sql}`;
const transaction = sql => `begin; set local statement_timeout='12s'; set local deadlock_timeout='100ms'; ${sql}`;
const count = (table, where) => Number(command(`select count(*) from public.${table} where ${where};`));
const itemTable = kind => kind === 'event' ? 'sync_calendar_events' : 'sync_reminders';
const containerTable = kind => kind === 'event' ? 'sync_calendars' : 'sync_reminder_lists';
const linkColumn = kind => kind === 'event' ? 'calendar_id' : 'list_id';
const fields = kind => kind === 'event'
  ? { title: 'Visit', starts_at: '2026-10-05T09:00:00Z', ends_at: '2026-10-05T10:00:00Z', all_day: false, status: 'confirmed' }
  : { title: 'Task', notes: null, due_at: '2026-10-05T09:00:00Z', is_completed: false };
const HASH = 'a'.repeat(64);
function seed(provider = 'google', direction = 'import') {
  const x = { user: randomUUID(), other: randomUUID(), family: randomUUID(), account: randomUUID(), provider };
  command(`insert into auth.users(id,email) values(${q(x.user)},'synthetic-owner@example.invalid'),(${q(x.other)},'synthetic-parent@example.invalid');
    insert into public.families(id,name,created_by) values(${q(x.family)},'Synthetic sync',${q(x.user)});
    insert into public.family_members(family_id,user_id,display_name,role) values
      (${q(x.family)},${q(x.user)},'Owner','parent'),(${q(x.family)},${q(x.other)},'Surviving parent','parent');
    insert into public.sync_accounts(id,user_id,family_id,provider,sync_direction)
      values(${q(x.account)},${q(x.user)},${q(x.family)},${q(provider)},${q(direction)});`);
  return x;
}
const container = (x, kind = 'event', external = 'primary') =>
  `select public.ensure_sync_pull_container(${q(x.account)},${q(x.family)},${q(x.user)},${q(x.provider)},${q(kind)},${q(external)},'Synthetic','UTC','#6366f1');`;
const item = (x, kind, id, external = 'remote', payload = fields(kind), hash = HASH) =>
  `select public.create_sync_pull_item(${q(x.account)},${q(x.family)},${q(x.user)},${q(x.provider)},${q(kind)},${q(id)},${q(external)},${q(JSON.stringify(payload))}::jsonb,${q(hash)});`;
function failure(sql, state, message) {
  let error;
  try { command(sql); } catch (caught) { error = caught; }
  assert(error && error.status !== 0 && !error.code, 'Expected a PostgreSQL error, not success or a client timeout.');
  const stderr = String(error.stderr ?? '');
  assert.match(stderr, new RegExp(`ERROR:\\s+${state}:`), stderr);
  if (message) assert.match(stderr, message);
  assert.doesNotMatch(stderr, /40P01|deadlock detected/, 'A deadlock must never count as a refusal.');
  return stderr;
}
async function check(label, work) {
  await work(); completed++;
  console.log('PASS ' + label);
}
function session(label) {
  const app = 'sync-atomic-' + randomUUID() + '-' + label;
  const child = spawn(executable('psql'), [...connection, '-X', '-d', database, '-qAt',
    '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'],
  { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PGAPPNAME: app, PGCONNECT_TIMEOUT: '5' } });
  let output = '', errors = '', pending = null, exited = false;
  const reject = error => {
    if (pending) { const job = pending; pending = null; clearTimeout(job.timer); job.reject(error); }
  };
  child.stdout.on('data', data => {
    output += data;
    if (!pending || !output.includes(pending.marker)) return;
    const job = pending; pending = null; clearTimeout(job.timer);
    const offset = output.indexOf(job.marker);
    const result = output.slice(0, offset).trim();
    output = output.slice(offset + job.marker.length);
    job.resolve(result);
  });
  child.stderr.on('data', data => { errors += data; });
  child.on('error', reject);
  child.stdin.on('error', reject);
  const closed = new Promise(resolveClose => child.on('close', code => {
    exited = true;
    reject(new Error(`psql exited ${code}: ${errors}\n${output}`));
    resolveClose();
  }));
  const client = {
    app,
    run(sql) {
      assert(!exited && !pending, 'Session commands must be sequential and use a live process.');
      return new Promise((resolveJob, rejectJob) => {
        const marker = 'done_' + randomUUID();
        const timer = setTimeout(() => { reject(new Error(`Session timeout: ${errors}\n${output}`)); child.kill(); }, 15_000);
        pending = { marker, timer, resolve: resolveJob, reject: rejectJob };
        child.stdin.write(sql + '\n\\echo ' + marker + '\n');
      });
    },
    async close() {
      if (!exited) {
        child.stdin.end('\\q\n');
        const timer = setTimeout(() => child.kill(), 5000);
        await closed; clearTimeout(timer);
      }
      clients.delete(client);
    },
  };
  clients.add(client);
  return client;
}
async function waiting(target, blocker) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (command(`select count(*) from pg_stat_activity where application_name=${q(target.app)}
      and wait_event_type='Lock' and (select pid from pg_stat_activity where application_name=${q(blocker.app)})=any(pg_blocking_pids(pid));`) === '1') return;
    await new Promise(resolveWait => setTimeout(resolveWait, 30));
  }
  throw new Error('Expected the actual blocker PID for ' + target.app);
}
function retryError(result) {
  assert(result instanceof Error, String(result));
  assert.match(result.message, /ERROR:\s+55P03:/);
  assert.doesNotMatch(result.message, /40P01|deadlock detected/);
}
function emptyPair(x, kind) {
  assert.equal(count(itemTable(kind), `family_id=${q(x.family)}`), 0);
  assert.equal(count('sync_external_mappings', `account_id=${q(x.account)}`), 0);
  assert.equal(count('sync_change_logs', `family_id=${q(x.family)}`), 0);
}
const signatures = {
  container: 'public.ensure_sync_pull_container(uuid,uuid,uuid,public.sync_provider,public.sync_item_type,text,text,text,text)',
  item: 'public.create_sync_pull_item(uuid,uuid,uuid,public.sync_provider,public.sync_item_type,uuid,text,jsonb,text)',
  admit: 'sync_pull_private.admit_account(uuid,uuid,uuid,public.sync_provider,boolean)',
  auth: 'sync_pull_private.lock_auth_parent(uuid,uuid,uuid,public.sync_provider)',
};
function mappingRefusal() {
  command(`create function fixture.refuse_sync_map() returns trigger language plpgsql as $$ begin
    if new.external_id='fail-map' then raise exception 'Synthetic mapping refusal' using errcode='42501'; end if;
    return new; end $$;
    create trigger synthetic_refuse_sync_map before insert on public.sync_external_mappings for each row execute function fixture.refuse_sync_map();`);
}
const removeRefusal = () => command('drop trigger synthetic_refuse_sync_map on public.sync_external_mappings; drop function fixture.refuse_sync_map();');
function oldSeparateItem(x, kind, id) {
  const common = `${q(id)},${q(x.family)},${q(x.user)},${q(x.provider)},'fail-map','Old separate write',${q(HASH)},'synced'`;
  return kind === 'event'
    ? `insert into public.sync_calendar_events(calendar_id,family_id,user_id,provider,external_id,title,content_hash,sync_status,starts_at) values(${common},'2026-10-05T09:00:00Z') returning id;`
    : `insert into public.sync_reminders(list_id,family_id,user_id,provider,external_id,title,content_hash,sync_status) values(${common}) returning id;`;
}
const oldSeparateMap = (x, kind, id) => `insert into public.sync_external_mappings(family_id,account_id,provider,item_type,local_id,external_id,metadata)
  values(${q(x.family)},${q(x.account)},${q(x.provider)},${q(kind)},${q(id)},'fail-map',${q(JSON.stringify({ lastHash: HASH }))}::jsonb);`;

async function pairedDeletion(kind, label, deletionFirst) {
  const x = seed(), c = json(service(container(x, kind)));
  const deletionSql = label === 'family'
    ? `set role authenticated; set request.jwt.claim.sub=${q(x.other)}; delete from public.families where id=${q(x.family)};`
    : label === 'auth-user'
      ? `set role supabase_auth_admin; set request.jwt.claim.sub=''; delete from auth.users where id=${q(x.user)};`
      : owner(x, `delete from public.sync_accounts where id=${q(x.account)};`);
  const first = session('import'), deletion = session('deletion');
  try {
    if (deletionFirst) {
      await deletion.run(transaction(deletionSql));
      const result = await first.run(transaction(service(item(x, kind, c.id))) + 'commit;').catch(error => error);
      retryError(result);
      const lateContainer = session('late-container');
      retryError(await lateContainer.run(transaction(service(container(x, kind))) + 'commit;').catch(error => error));
      await deletion.run('commit;');
      emptyPair(x, kind);
    } else {
      const receipt = JSON.parse((await first.run(transaction(service(item(x, kind, c.id))))).split(/\r?\n/).at(-1));
      assert.equal(receipt.created, true);
      const pending = deletion.run(transaction(deletionSql) + 'commit;').catch(error => error);
      await waiting(deletion, first);
      await first.run('commit;');
      const result = await pending;
      assert(!(result instanceof Error), String(result));
      assert.equal(count('sync_external_mappings', `account_id=${q(x.account)}`), 0);
      if (label === 'family') {
        assert.equal(count(itemTable(kind), `id=${q(receipt.mapping.local_id)}`), 0);
        assert.equal(count(containerTable(kind), `id=${q(c.id)}`), 0);
      } else {
        const retained = json(`select row_to_json(t) from public.${itemTable(kind)} t where id=${q(receipt.mapping.local_id)};`);
        const detached = json(`select row_to_json(t) from public.${containerTable(kind)} t where id=${q(c.id)};`);
        assert.equal(retained.id, receipt.mapping.local_id);
        assert.equal(retained[linkColumn(kind)], c.id);
        assert.equal(detached.account_id, null);
        assert.equal(retained.user_id, label === 'auth-user' ? null : x.user);
        assert.equal(detached.user_id, label === 'auth-user' ? null : x.user);
      }
    }
    assert.equal(count('sync_accounts', `id=${q(x.account)}`), 0);
    assert.equal(count('families', `id=${q(x.family)}`), label === 'family' ? 0 : 1);
    assert.equal(Number(command(`select count(*) from auth.users where id=${q(x.user)};`)), label === 'auth-user' ? 0 : 1);
  } finally { await Promise.all([first.close(), deletion.close()]); }
}

try {
  execFileSync(executable('createdb'), [...connection, database], { cwd: ROOT, timeout: 15_000, stdio: 'pipe' });
  created = true;
  execFileSync(executable('psql'), [...connection, '-X', '-d', database, '-v', 'ON_ERROR_STOP=1',
    '-f', join(ROOT, 'tests/fixtures/sync-atomic-pull.sql')], { cwd: ROOT, timeout: 30_000, stdio: 'pipe' });
  await check('public/private ACLs survive broad defaults without any service auth-table grant', () => {
    for (const [name, signature] of Object.entries(signatures)) {
      const row = json(`select json_build_object('service',has_function_privilege('service_role',${q(signature)},'EXECUTE'),
        'auth',has_function_privilege('authenticated',${q(signature)},'EXECUTE'),'anon',has_function_privilege('anon',${q(signature)},'EXECUTE'),
        'public',exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where p.oid=${q(signature)}::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'),
        'definer',(select prosecdef from pg_proc where oid=${q(signature)}::regprocedure));`);
      assert.deepEqual(row, { service: true, auth: false, anon: false, public: false, definer: name === 'auth' });
    }
    assert.deepEqual(json(`select json_build_object('selectAuth',has_table_privilege('service_role','auth.users','SELECT'),
      'updateAuth',has_table_privilege('service_role','auth.users','UPDATE'),
      'anyAuth',has_table_privilege('service_role','auth.users','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
      'authSchema',has_schema_privilege('authenticated','sync_pull_private','USAGE'),
      'anonSchema',has_schema_privilege('anon','sync_pull_private','USAGE'),'defaultParity',has_table_privilege('authenticated','public.sync_accounts','SELECT'));`),
    { selectAuth: false, updateAuth: false, anyAuth: false, authSchema: false, anonSchema: false, defaultParity: true });
  });
  for (const role of ['authenticated', 'anon']) for (const [name, signature] of Object.entries(signatures)) {
    await check(`${role} ${name} direct grant drift still refuses a spoofed service claim`, () => {
      const x = seed(), c = json(service(container(x)));
      const call = name === 'container' ? container(x) : name === 'item' ? item(x, 'event', c.id)
        : `select sync_pull_private.${name === 'admit' ? 'admit_account' : 'lock_auth_parent'}(${q(x.account)},${q(x.family)},${q(x.user)},'google'${name === 'admit' ? ',true' : ''});`;
      failure(`begin; grant usage on schema sync_pull_private to ${role}; grant execute on function ${signature} to ${role};
        set role ${role}; set request.jwt.claim.sub=${q(x.user)}; set request.jwt.claim.role='service_role'; ${call}`, '42501', /Service role required/);
      assert.equal(command(`select has_function_privilege(${q(role)},${q(signature)},'EXECUTE');`), 'f');
      emptyPair(x, 'event');
    });
  }
  for (const provider of ['google', 'microsoft', 'apple']) for (const kind of ['event', 'reminder']) {
    await check(`${provider} ${kind} creates one exact item/map/audit and reuses its receipt`, () => {
      const x = seed(provider), c = json(service(container(x, kind)));
      const a = json(service(item(x, kind, c.id))), b = json(service(item(x, kind, c.id)));
      assert.equal(a.created, true); assert.equal(b.created, false);
      assert.deepEqual(b.mapping, a.mapping);
      assert.equal(json(service(container(x, kind))).id, c.id);
      assert.equal(count(itemTable(kind), `id=${q(a.mapping.local_id)}`), 1);
      assert.equal(count('sync_external_mappings', `account_id=${q(x.account)}`), 1);
      assert.equal(count('sync_change_logs', `local_id=${q(a.mapping.local_id)}`), 1);
    });
  }
  for (const kind of ['event', 'reminder']) {
    await check(`${kind} historical separate writes leave an orphan and a duplicate on retry`, () => {
      const x = seed(), c = json(service(container(x, kind)));
      mappingRefusal();
      const orphan = command(service(oldSeparateItem(x, kind, c.id)));
      failure(service(oldSeparateMap(x, kind, orphan)), '42501', /Synthetic mapping refusal/);
      assert.equal(count(itemTable(kind), `family_id=${q(x.family)}`), 1);
      assert.equal(count('sync_external_mappings', `account_id=${q(x.account)}`), 0);
      assert.equal(count('sync_change_logs', `local_id=${q(orphan)}`), 1);
      removeRefusal();
      const retry = command(service(oldSeparateItem(x, kind, c.id)));
      command(service(oldSeparateMap(x, kind, retry)));
      assert.notEqual(retry, orphan);
      assert.equal(count(itemTable(kind), `family_id=${q(x.family)}`), 2);
      assert.equal(count('sync_external_mappings', `account_id=${q(x.account)} and local_id=${q(retry)}`), 1);
    });
    await check(`${kind} atomic mapping refusal rolls back item and audit; retry creates one pair`, () => {
      const x = seed(), c = json(service(container(x, kind))); mappingRefusal();
      failure(service(item(x, kind, c.id, 'fail-map')), '42501', /Synthetic mapping refusal/);
      emptyPair(x, kind); removeRefusal();
      const receipt = json(service(item(x, kind, c.id, 'fail-map')));
      assert.equal(receipt.created, true);
      assert.equal(count(itemTable(kind), `family_id=${q(x.family)}`), 1);
      assert.equal(count('sync_external_mappings', `account_id=${q(x.account)}`), 1);
      assert.equal(count('sync_change_logs', `local_id=${q(receipt.mapping.local_id)}`), 1);
    });
    await check(`${kind} malformed fields leave no item, mapping or audit`, () => {
      const x = seed(), c = json(service(container(x, kind)));
      failure(service(item(x, kind, c.id, 'bad', { title: 'Bad', starts_at: 'invalid timestamp', due_at: 'invalid timestamp' })), '22007');
      emptyPair(x, kind);
    });
    await check(`${kind} discarded commit receipt returns the exact committed mapping identity`, () => {
      const x = seed(), c = json(service(container(x, kind)));
      command(service(item(x, kind, c.id, 'uncertain')));
      const before = json(`select json_build_object('id',id,'family_id',family_id,'local_id',local_id,'external_id',external_id,'metadata',metadata)
        from public.sync_external_mappings where account_id=${q(x.account)};`);
      const receipt = json(service(item(x, kind, c.id, 'uncertain')));
      assert.equal(receipt.created, false); assert.deepEqual(receipt.mapping, before);
      assert.equal(count(itemTable(kind), `family_id=${q(x.family)}`), 1);
      assert.equal(count('sync_change_logs', `local_id=${q(before.local_id)}`), 1);
    });
    await check(`${kind} changed-content retry preserves existing content and hash`, () => {
      const x = seed(), c = json(service(container(x, kind))), a = json(service(item(x, kind, c.id)));
      const b = json(service(item(x, kind, c.id, 'remote', { ...fields(kind), title: 'Different remote intent' }, 'b'.repeat(64))));
      assert.equal(b.created, false); assert.deepEqual(b.mapping, a.mapping);
      const retained = json(`select json_build_object('title',title,'hash',content_hash) from public.${itemTable(kind)} where id=${q(a.mapping.local_id)};`);
      assert.deepEqual(retained, { title: fields(kind).title, hash: HASH });
    });
    await check(`${kind} existing exported internal item mapping is reused`, () => {
      const x = seed(), c = json(service(container(x, kind))), a = json(service(item(x, kind, c.id)));
      command(`update public.${itemTable(kind)} set provider='internal',external_id=null where id=${q(a.mapping.local_id)};`);
      const b = json(service(item(x, kind, c.id)));
      assert.equal(b.created, false); assert.deepEqual(b.mapping, a.mapping);
      assert.equal(count(itemTable(kind), `family_id=${q(x.family)}`), 1);
    });
    await check(`${kind} export-only container is allowed while remote item creation is refused`, () => {
      const x = seed('google', 'export'), c = json(service(container(x, kind)));
      assert.equal(json(service(container(x, kind))).id, c.id);
      failure(service(item(x, kind, c.id)), '42501', /Standard pull unavailable/); emptyPair(x, kind);
    });
    await check(`${kind} two-way account admits a remote item`, () => {
      const x = seed('google', 'two_way'), c = json(service(container(x, kind)));
      assert.equal(json(service(item(x, kind, c.id))).created, true);
    });
    await check(`${kind} sibling account cannot adopt the first account's container`, () => {
      const x = seed(), c = json(service(container(x, kind))), sibling = { ...x, account: randomUUID() };
      command(`insert into public.sync_accounts(id,user_id,family_id,provider,external_id,sync_direction)
        values(${q(sibling.account)},${q(x.user)},${q(x.family)},'google','sibling','import');`);
      failure(service(item(sibling, kind, c.id)), '42501'); emptyPair(x, kind);
    });
    await check(`${kind} ambiguous existing containers are refused without adoption`, () => {
      const x = seed(); json(service(container(x, kind)));
      command(`insert into public.${containerTable(kind)}(user_id,family_id,account_id,provider,external_id,name)
        values(${q(x.user)},${q(x.family)},${q(x.account)},'google','primary','Duplicate');`);
      failure(service(container(x, kind)), '42501', /Ambiguous sync/);
      assert.equal(count(containerTable(kind), `account_id=${q(x.account)}`), 2);
    });
    for (const poison of ['foreign-stamp', 'foreign-target', 'sibling-target', 'source-table']) {
      await check(`${kind} ${poison} existing mapping is refused without rewriting history`, () => {
        const x = seed(), c = json(service(container(x, kind))), receipt = json(service(item(x, kind, c.id)));
        if (poison === 'foreign-stamp') command(`update public.sync_external_mappings set family_id=${q(seed().family)} where id=${q(receipt.mapping.id)};`);
        if (poison === 'foreign-target') command(`update public.${itemTable(kind)} set family_id=${q(seed().family)} where id=${q(receipt.mapping.local_id)};`);
        if (poison === 'sibling-target') {
          const sibling = json(service(container(x, kind, 'sibling')));
          command(`update public.${itemTable(kind)} set ${linkColumn(kind)}=${q(sibling.id)} where id=${q(receipt.mapping.local_id)};`);
        }
        if (poison === 'source-table') command(`update public.sync_external_mappings set metadata='{"sourceTable":"calendar_events"}' where id=${q(receipt.mapping.id)};`);
        const before = command(`select row_to_json(t) from public.sync_external_mappings t where id=${q(receipt.mapping.id)};`);
        failure(service(item(x, kind, c.id)), '42501');
        assert.equal(command(`select row_to_json(t) from public.sync_external_mappings t where id=${q(receipt.mapping.id)};`), before);
        assert.equal(count(itemTable(kind), `id=${q(receipt.mapping.local_id)}`), 1);
      });
    }
  }
  await check('both RPCs reject a null kind before choosing either table', () => {
    const x = seed(); failure(service(container(x).replace("'event'", 'null')), '22023');
    assert.equal(count('sync_reminder_lists', `account_id=${q(x.account)}`), 0);
    assert.equal(count('sync_calendars', `account_id=${q(x.account)}`), 0);
    const c = json(service(container(x)));
    failure(service(item(x, 'event', c.id).replace("'event'", 'null')), '22023'); emptyPair(x, 'event');
  });
  for (const mode of ['family', 'user', 'provider', 'inactive', 'disabled', 'manual', 'onboarding']) {
    await check(`invalid ${mode} account denies both container and item admission`, () => {
      const x = seed(), c = json(service(container(x))), bad = { ...x };
      if (mode === 'family') bad.family = seed().family;
      if (mode === 'user') bad.user = x.other;
      if (mode === 'provider') bad.provider = 'apple';
      if (mode === 'inactive') command(`update public.family_members set is_active=false where family_id=${q(x.family)} and user_id=${q(x.user)};`);
      if (mode === 'disabled' || mode === 'manual') command(`update public.sync_accounts set sync_direction=${q(mode)} where id=${q(x.account)};`);
      if (mode === 'onboarding') command(`update public.sync_accounts set metadata='{"onboardingCalendar":{"version":1,"state":"import","calendarExternalId":"primary"}}' where id=${q(x.account)};`);
      failure(service(container(bad)), '42501'); failure(service(item(bad, 'event', c.id)), '42501');
      emptyPair(x, 'event'); assert.equal(count('sync_calendars', `account_id=${q(x.account)}`), 1);
    });
  }
  for (const kind of ['event', 'reminder']) {
    await check(`${kind} concurrent first writes return one identity and preserve first content`, async () => {
      const x = seed(), first = session('first'), second = session('second');
      try {
        const firstContainer = JSON.parse((await first.run(transaction(service(container(x, kind))))).split(/\r?\n/).at(-1));
        const a = JSON.parse((await first.run(item(x, kind, firstContainer.id))).split(/\r?\n/).at(-1));
        const pending = second.run(transaction(service(container(x, kind)
          + item(x, kind, firstContainer.id, 'remote', { ...fields(kind), title: 'Raced different content' }, 'b'.repeat(64)))) + 'commit;').catch(error => error);
        await waiting(second, first); await first.run('commit;');
        const result = await pending; assert(!(result instanceof Error), String(result));
        const b = JSON.parse(result.split(/\r?\n/).at(-1));
        assert.equal(b.created, false); assert.deepEqual(b.mapping, a.mapping);
        assert.equal(json(service(container(x, kind))).id, firstContainer.id);
        assert.equal(command(`select title from public.${itemTable(kind)} where id=${q(a.mapping.local_id)};`), fields(kind).title);
        assert.equal(count(containerTable(kind), `account_id=${q(x.account)}`), 1);
        assert.equal(count(itemTable(kind), `family_id=${q(x.family)}`), 1);
        assert.equal(count('sync_external_mappings', `account_id=${q(x.account)}`), 1);
      } finally { await Promise.all([first.close(), second.close()]); }
    });
    for (const label of ['family', 'auth-user', 'account']) for (const deletionFirst of [false, true]) {
      await check(`${kind} ${deletionFirst ? 'deletion-first refuses with 55P03' : 'import-first waits then retains/removes the actual rows'} ${label}`,
        () => pairedDeletion(kind, label, deletionFirst));
    }
  }
  assert.equal(createHash('sha256').update(readFileSync(join(ROOT, MIGRATION))).digest('hex'), migrationHash,
    'Migration source changed during verification; rerun against a frozen candidate.');
  console.log(`All ${completed} synthetic sync atomic pull checks passed on PostgreSQL ${version}; migration SHA256 ${migrationHash}.`);
} finally {
  await Promise.all([...clients].map(client => client.close()));
  if (created) {
    execFileSync(executable('dropdb'), [...connection, '--force', database], { cwd: ROOT, timeout: 15_000, stdio: 'pipe' });
    assert.equal(command(`select count(*) from pg_database where datname=${q(database)};`, 'postgres'), '0', 'Owned temporary DB was not removed.');
    console.log('Owned temporary sync database removed.');
  }
}
