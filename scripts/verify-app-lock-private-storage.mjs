// Own disposable PostgreSQL 17 container only. No production URL or credentials.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import {
  buildAppLockReleaseSql, readAppLockMigration, runAppLockRelease, SNAPSHOT_SQL, VERIFICATION_SQL,
  MIGRATION_SHA256, NAME, PROJECT,
} from './apply-app-lock-private-storage.mjs';

const container = `bubaly-app-lock-proof-${randomUUID().slice(0, 8)}`;
const migration = readFileSync(resolve('supabase/reserved/20261025234230_app_lock_credentials_are_server_private.sql'), 'utf8');
const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', timeout: 45_000, stdio: ['pipe', 'pipe', 'pipe'] });
const args = database => ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database];
const sql = (source, database = 'postgres') => docker(args(database), source).trim();
const one = '10000000-0000-4000-8000-000000000001';
const two = '10000000-0000-4000-8000-000000000002';
const three = '10000000-0000-4000-8000-000000000003';
const salt = 'a'.repeat(32);
const hash = 'b'.repeat(64);
const lock = JSON.stringify({ enabled: true, salt, hash });
const bootstrap = `
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
create table public.user_preferences (user_id uuid primary key references auth.users(id), notification_prefs jsonb not null default '{}');
alter table public.user_preferences enable row level security;
grant all on public.user_preferences to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create policy prefs_all on public.user_preferences for all using (user_id = auth.uid()) with check (user_id = auth.uid());
insert into auth.users values ('${one}'), ('${two}'), ('${three}');
insert into public.user_preferences values
  ('${one}', jsonb_build_object('email', true, 'appLock', '${lock}'::jsonb)),
  ('${two}', jsonb_build_object('email', false, 'appLock', '${lock}'::jsonb || '{"enabled":false}'::jsonb)),
  ('${three}', '{"email":true}');
`;

function runAsync(source, database = 'postgres') {
  const child = spawn('docker', args(database), { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const done = new Promise((accept, reject) => {
    child.on('error', reject);
    child.on('close', code => accept({ code, output, errors }));
  });
  child.stdin.end(source);
  return { child, done, output: () => output };
}

let started = false;
try {
  docker(['run', '-d', '--rm', '--network', 'none', '--name', container, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17']);
  started = true;
  for (let attempt = 0; ; attempt++) {
    // The image first starts a temporary socket-only initialization server.
    // TCP readiness identifies the final server, after that server shuts down.
    try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); break; }
    catch { if (attempt >= 30) throw new Error('Disposable database did not start'); await new Promise(r => setTimeout(r, 200)); }
  }
  sql('create role anon; create role authenticated; create role service_role bypassrls;');
  sql(bootstrap);

  // Actual original exploit under the browser's database role, rolled back.
  assert.equal(sql(`begin; set local role authenticated; set local request.jwt.claim.sub = '${one}';
    select notification_prefs->'appLock'->>'hash' = '${hash}' from public.user_preferences;
    update public.user_preferences set notification_prefs = notification_prefs - 'appLock' where user_id = '${one}';
    select not (notification_prefs ? 'appLock') from public.user_preferences; rollback;`), 't\nt');

  // A malformed enabled credential aborts the whole migration, without scrub.
  sql('create database malformed;');
  sql(bootstrap, 'malformed');
  sql(`update public.user_preferences set notification_prefs = jsonb_set(notification_prefs, '{appLock,hash}', '"bad"') where user_id = '${one}';`, 'malformed');
  let malformedRejected = false;
  try { sql(migration, 'malformed'); } catch (error) {
    malformedRejected = String(error.stderr).includes('refused malformed legacy credentials');
  }
  assert.equal(malformedRejected, true);
  assert.equal(sql("select to_regclass('public.app_lock_credentials') is null; select count(*) from public.user_preferences where notification_prefs ? 'appLock';", 'malformed'), 't\n2');

  // Hold the migration's own lock briefly so a stale browser save queues behind
  // it. It must be refused AFTER commit, rather than restoring public secrets.
  const held = migration.replace('lock table public.user_preferences in share row exclusive mode;',
    "lock table public.user_preferences in share row exclusive mode;\n\\echo APP_LOCK_FENCE_HELD\nselect pg_sleep(2);");
  const migrating = runAsync(held);
  for (let attempt = 0; !migrating.output().includes('APP_LOCK_FENCE_HELD'); attempt++) {
    if (attempt > 100) throw new Error('Migration did not reach its lock');
    await new Promise(r => setTimeout(r, 20));
  }
  const writer = runAsync(`set application_name = 'app_lock_stale_writer'; set role authenticated;
    set request.jwt.claim.sub = '${one}'; update public.user_preferences
    set notification_prefs = '{"appLock":${lock}}' where user_id = '${one}';`);
  let blocked = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    blocked = sql("select exists(select 1 from pg_stat_activity where application_name='app_lock_stale_writer' and wait_event_type='Lock');") === 't';
    if (blocked) break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(blocked, true, 'Legacy writer must actually wait behind the migration lock');
  const [migrated, stale] = await Promise.all([migrating.done, writer.done]);
  assert.equal(migrated.code, 0, migrated.errors);
  assert.notEqual(stale.code, 0);
  assert.match(stale.errors, /private server endpoint/);

  assert.equal(sql(`select count(*) = 2 and bool_and(salt = '${salt}' and hash = '${hash}') from public.app_lock_credentials;
    select enabled from public.app_lock_credentials order by user_id;
    select count(*) = 0 from public.user_preferences where notification_prefs ? 'appLock';
    select bool_and(notification_prefs = case when user_id = '${two}' then '{"email":false}'::jsonb else '{"email":true}'::jsonb end) from public.user_preferences;
    select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.app_lock_credentials'::regclass;`), 't\nt\nf\nt\nt\nt');

  // Check both grants and executed queries. Own-row access must not retrieve or
  // overwrite material through any table privilege, including TRUNCATE.
  for (const role of ['anon', 'authenticated']) {
    for (const statement of [
      'select * from public.app_lock_credentials',
      `insert into public.app_lock_credentials(user_id,enabled,salt,hash) values ('${three}',false,null,null)`,
      `update public.app_lock_credentials set enabled = false where user_id = '${one}'`,
      `delete from public.app_lock_credentials where user_id = '${one}'`,
      'truncate public.app_lock_credentials',
    ]) {
      assert.equal(sql(`set role ${role}; set request.jwt.claim.sub = '${one}'; do $$ begin
        begin execute '${statement.replaceAll("'", "''")}'; raise exception 'unexpected credential access';
        exception when insufficient_privilege then null; end;
      end $$; select 'denied';`), 'denied');
    }
  }
  assert.equal(sql(`select count(*) = 0 from information_schema.role_table_grants
    where table_schema='public' and table_name='app_lock_credentials' and grantee in ('anon','authenticated','PUBLIC');
    select count(*) = 0 from pg_policies where schemaname='public' and tablename='app_lock_credentials';
    select not has_function_privilege('authenticated','public.reject_app_lock_preferences()','EXECUTE');`), 't\nt\nt');

  assert.equal(sql(`set role authenticated; set request.jwt.claim.sub = '${one}';
    select count(*) = 1 and bool_and(not (notification_prefs ? 'appLock')) from public.user_preferences;
    update public.user_preferences set notification_prefs = '{"email":false}' where user_id='${one}';
    do $$ begin
      begin update public.user_preferences set notification_prefs = '{"appLock":${lock}}' where user_id='${one}';
        raise exception 'unexpected preference injection'; exception when check_violation then null; end;
      begin insert into public.user_preferences values ('${one}', '{"appLock":${lock}}');
        raise exception 'unexpected preference insert'; exception when check_violation then null; end;
    end $$;
    delete from public.user_preferences where user_id='${one}'; reset role;
    select count(*) = 1 and bool_and(enabled) from public.app_lock_credentials where user_id='${one}';`), 't\nt');

  // The service can use a revision fence; a second stale request changes zero.
  assert.equal(sql(`set role service_role;
    select revision as old_revision from public.app_lock_credentials where user_id='${one}' \\gset
    with saved as (update public.app_lock_credentials set revision=gen_random_uuid() where user_id='${one}' and revision=:'old_revision' returning user_id) select count(*) from saved;
    with stale as (update public.app_lock_credentials set enabled=false where user_id='${one}' and revision=:'old_revision' returning user_id) select count(*) from stale;
    insert into public.app_lock_credentials(user_id,enabled,salt,hash) values ('${three}',false,null,null);
    select count(*) from public.app_lock_credentials;`), '1\n0\n3');

  // Execute the production runner's actual transaction envelope, including
  // its fixed ledger identity and catalog/body checks, on fresh owned DBs.
  const ledger = `create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key, name text, statements text[]);
    insert into supabase_migrations.schema_migrations values ('0001','prior',array['select 1;']);`;
  const releaseFile = readAppLockMigration();
  for (const database of ['release_success', 'release_rollback']) {
    sql(`create database ${database};`);
    sql(bootstrap + ledger, database);
  }
  // A role with every object privilege still cannot run the transition unless
  // it sees all legacy preferences through RLS. Prove that exact distinction
  // with actual catalog grants, and that the runner sends no write when denied.
  sql(`create role app_lock_limited;
    grant usage on schema auth, supabase_migrations to app_lock_limited;
    grant usage, create on schema public to app_lock_limited;
    grant temporary on database release_rollback to app_lock_limited;
    grant references(id) on auth.users to app_lock_limited;
    grant select, update, trigger on public.user_preferences to app_lock_limited;
    grant select, insert, update on supabase_migrations.schema_migrations to app_lock_limited;`, 'release_rollback');
  const asLimited = query => JSON.parse(sql(`set role app_lock_limited; ${query}`, 'release_rollback'));
  assert.equal(asLimited(SNAPSHOT_SQL).schemaReady, false);
  let deniedWrites = 0;
  await assert.rejects(runAppLockRelease({ projectRef: PROJECT, token: 'disposable', apply: true,
    expectedRevision: '1'.repeat(40), githubSha: '1'.repeat(40), githubRef: 'refs/heads/main',
    fetchImpl: async (_url, options) => {
      const input = JSON.parse(options.body);
      if (!input.read_only) deniedWrites++;
      assert.equal(input.read_only, true, 'An ineligible actor must be refused before any write');
      return new Response(JSON.stringify([{ snapshot: asLimited(input.query) }]), { status: 200 });
    } }), /schema\/history preflight failed/);
  assert.equal(deniedWrites, 0);
  sql('alter role app_lock_limited bypassrls;', 'release_rollback');
  assert.equal(asLimited(SNAPSHOT_SQL).schemaReady, true, 'Only BYPASSRLS differs from the denied actor');
  sql('alter role app_lock_limited nobypassrls;', 'release_rollback');
  const beforeRelease = JSON.parse(sql(SNAPSHOT_SQL, 'release_success'));
  assert.equal(beforeRelease.schemaReady, true);
  assert.deepEqual(beforeRelease.legacy, { keys: 2, records: 2, enabled: 1, malformed: 0 });
  sql(buildAppLockReleaseSql(releaseFile, beforeRelease.otherLedgerHash), 'release_success');
  const afterRelease = JSON.parse(sql(SNAPSHOT_SQL, 'release_success'));
  assert.equal(afterRelease.otherLedgerHash, beforeRelease.otherLedgerHash);
  assert.deepEqual(afterRelease.migration, { name: NAME, statementCount: 1, sha256: MIGRATION_SHA256 });
  const verified = JSON.parse(sql(VERIFICATION_SQL, 'release_success'));
  assert.deepEqual(verified, {
    privateRls: true, privateForceRls: true, policyCount: 0, browserPrivileges: false,
    servicePrivileges: true, triggerProtected: true, functionProtected: true,
    publicKeys: 0, privateRecords: 2, enabledPrivate: 1,
  });
  let replayWrites = 0;
  const repeated = await runAppLockRelease({ projectRef: PROJECT, token: 'disposable', apply: true,
    expectedRevision: '1'.repeat(40), githubSha: '1'.repeat(40), githubRef: 'refs/heads/main',
    fetchImpl: async (_url, options) => {
      const input = JSON.parse(options.body);
      if (!input.read_only) replayWrites++;
      assert.equal(input.read_only, true, 'Already applied must never attempt replay');
      const field = input.query === SNAPSHOT_SQL ? 'snapshot' : 'verification';
      return new Response(JSON.stringify([{ [field]: JSON.parse(sql(input.query, 'release_success')) }]), { status: 200 });
    } });
  assert.equal(repeated.status, 'already_applied');
  assert.equal(replayWrites, 0);

  const rollbackSnapshot = JSON.parse(sql(SNAPSHOT_SQL, 'release_rollback'));
  const brokenPostcheck = buildAppLockReleaseSql(releaseFile, rollbackSnapshot.otherLedgerHash)
    .replace('do $app_lock_release_verify$', 'alter table public.app_lock_credentials disable row level security;\ndo $app_lock_release_verify$');
  let rolledBack = false;
  try { sql(brokenPostcheck, 'release_rollback'); }
  catch (error) { rolledBack = String(error.stderr).includes('App Lock release verification failed'); }
  assert.equal(rolledBack, true);
  assert.deepEqual(JSON.parse(sql(SNAPSHOT_SQL, 'release_rollback')), rollbackSnapshot,
    'A failed postcheck must roll back the schema, preference scrub and ledger together');

  sql(`create or replace function public.reject_app_lock_preferences() returns trigger language plpgsql
    security invoker set search_path='' as $$ begin return new; end; $$;`, 'release_success');
  const bodyDrift = JSON.parse(sql(VERIFICATION_SQL, 'release_success'));
  assert.equal(bodyDrift.functionProtected, false, 'Trigger body drift must fail even when its ACL and search_path remain protected');
  assert.equal(bodyDrift.triggerProtected, true);

  console.log(JSON.stringify({ ok: true, postgres: sql('show server_version;'), proof: [
    'original owner-role hash read and lock removal reproduced',
    'malformed migration aborted with original data retained',
    'concurrent legacy write waited then failed after migration',
    'enabled and disabled PIN material preserved exactly',
    'unrelated preferences preserved and public PIN material removed',
    'anonymous and authenticated SELECT INSERT UPDATE DELETE TRUNCATE denied',
    'no browser grants, no RLS policies, no callable trigger function',
    'normal preferences remain writable; INSERT/UPDATE App Lock injection refused',
    'deleting own preferences cannot remove private lock',
    'service role revision compare-and-set accepts current and refuses stale writes',
    'production wrapper preserves exact migration ledger identity and unrelated history',
    'already-applied runner executes no migration write',
    'failed production postcheck rolls back schema, public scrub and ledger together',
    'changed rejection-trigger body fails production verification',
    'fully granted actor without BYPASSRLS is refused before any write',
  ] }, null, 2));
} finally {
  if (started) docker(['rm', '-f', container]);
}
