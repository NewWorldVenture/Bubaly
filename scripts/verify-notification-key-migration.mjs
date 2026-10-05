import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const migration0293 = resolve(root, 'supabase/migrations/0293_notifications_related_id_is_a_key.sql');
const migration0476 = resolve(root, 'supabase/migrations/0476_messaging_notifications_preferences.sql');
const disposableMarker = 'BUBALY_DISPOSABLE_PG';

function assertDisposableTarget() {
  if (process.env[disposableMarker] !== '1') {
    throw new Error(`${disposableMarker}=1 is required; this regression creates and drops disposable databases.`);
  }
  const host = process.env.PGHOST ?? 'localhost';
  if (!(host.startsWith('/') || ['localhost', '127.0.0.1', '::1'].includes(host))) {
    throw new Error(`Refusing non-local PostgreSQL host ${JSON.stringify(host)}.`);
  }
}

const psql = process.env.PSQL_BIN || 'psql';
const port = process.env.PGPORT || '5432';
const user = process.env.PGUSER || 'postgres';
const adminDatabase = process.env.PGADMIN_DATABASE || 'postgres';

function runPsql(database, { sql, file, allowFailure = false, transaction = false } = {}) {
  const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', process.env.PGHOST || 'localhost', '-p', port, '-U', user, '-d', database];
  if (transaction) args.push('--single-transaction');
  if (file) args.push('-f', file);
  else args.push('-c', sql);
  const run = spawnSync(psql, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (!allowFailure && run.status !== 0) {
    throw new Error(`psql failed in ${database} (exit ${run.status}):\n${run.stderr || run.stdout}`);
  }
  return { status: run.status, stdout: run.stdout.trim(), stderr: run.stderr.trim() };
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function bootstrapRoles() {
  runPsql(adminDatabase, { sql: `
    do $roles$ begin create role anon nologin; exception when duplicate_object then null; end $roles$;
    do $roles$ begin create role authenticated nologin; exception when duplicate_object then null; end $roles$;
    do $roles$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $roles$;
  ` });
}

function fixtureSql(relatedIdType) {
  assert.ok(['uuid', 'text', 'integer'].includes(relatedIdType));
  return `
    create schema auth;
    create table auth.users (id uuid primary key);
    create schema messaging_private;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;

    create type public.notification_type as enum ('system');
    create table public.family_conversations (
      id uuid primary key,
      family_id uuid not null,
      is_family_chat boolean not null default false,
      participant_ids uuid[] not null default '{}',
      member_ids uuid[] not null default '{}',
      created_by uuid
    );
    create table public.family_messages (
      id uuid primary key,
      conversation_id uuid not null,
      family_id uuid not null,
      sender_id uuid,
      read_by uuid[] not null default '{}',
      deleted_at timestamptz
    );
    create table public.family_members (
      id uuid primary key,
      family_id uuid not null,
      is_active boolean not null default true,
      user_id uuid
    );
    create table public.notifications (
      id uuid primary key,
      family_id uuid not null,
      user_id uuid not null,
      type public.notification_type not null,
      title text not null,
      body text not null,
      related_type text,
      related_id ${relatedIdType},
      is_read boolean not null default false
    );
    create or replace function messaging_private.can_access_conversation(p_conversation_id uuid)
      returns boolean language sql stable as $$
        select exists (
          select 1 from public.family_conversations c
          where c.id = p_conversation_id and auth.uid() = any(c.member_ids)
        )
      $$;
    alter table public.notifications enable row level security;
    grant usage on schema public, auth, messaging_private to anon, authenticated, service_role;
    grant select, insert, update, delete on public.notifications to authenticated;
    create policy test_notifications_select on public.notifications for select to authenticated using (true);
    create policy test_notifications_update on public.notifications for update to authenticated using (true) with check (true);
    create policy test_notifications_insert on public.notifications for insert to authenticated with check (true);
  `;
}

const policyDigestSql = `
  select md5(coalesce(string_agg(
    concat_ws('|', policyname, permissive, array_to_string(roles, ','), cmd, coalesce(qual, ''), coalesce(with_check, '')),
    E'\\n' order by policyname), ''))
  from pg_policies
  where schemaname = 'public' and tablename = 'notifications'
    and policyname in ('message_notice_current_access', 'message_notice_current_update', 'message_notice_server_authorship');
`;

const policyCountSql = `
  select count(*) from pg_policies
  where schemaname = 'public' and tablename = 'notifications' and policyname like 'message_notice_%';
`;

const typeSql = `
  select data_type from information_schema.columns
  where table_schema = 'public' and table_name = 'notifications' and column_name = 'related_id';
`;

function applyMigration(database, file) {
  runPsql(database, { file, transaction: true });
}

function assertPoliciesInstalled(database) {
  assert.equal(runPsql(database, {
    sql: `
      select count(*) || '|' ||
        count(*) filter (where permissive = 'RESTRICTIVE' and 'authenticated' = any(roles)) || '|' ||
        count(*) filter (where policyname = 'message_notice_current_access' and cmd = 'SELECT') || '|' ||
        count(*) filter (where policyname = 'message_notice_current_update' and cmd = 'UPDATE') || '|' ||
        count(*) filter (where policyname = 'message_notice_server_authorship' and cmd = 'INSERT')
      from pg_policies
      where schemaname = 'public' and tablename = 'notifications'
        and policyname in ('message_notice_current_access', 'message_notice_current_update', 'message_notice_server_authorship');
    `,
  }).stdout, '3|3|1|1|1', 'all three current 0476 restrictive authenticated policies must exist with their intended commands');
}

function verifyPolicyBehavior(database, suffix) {
  const ids = {
    family: '10000000-0000-4000-8000-000000000001',
    generic: '10000000-0000-4000-8000-000000000002',
    member: '20000000-0000-4000-8000-000000000001',
    familyId: '30000000-0000-4000-8000-000000000001',
    conversation: '40000000-0000-4000-8000-000000000001',
    message: '50000000-0000-4000-8000-000000000001',
    nonparticipant: '20000000-0000-4000-8000-000000000002',
  };
  runPsql(database, { sql: `
    insert into public.family_conversations (id, family_id, member_ids)
    values ('${ids.conversation}', '${ids.familyId}', array['${ids.member}'::uuid]);
    insert into public.family_messages (id, conversation_id, family_id, sender_id)
    values ('${ids.message}', '${ids.conversation}', '${ids.familyId}', '${ids.member}');
    insert into public.notifications (id, family_id, user_id, type, title, body, related_type, related_id)
    values
      ('${ids.family}', '${ids.familyId}', '${ids.member}', 'system', 'New message', 'Open your conversation in Bubaly.', 'family_message', '${ids.conversation}:${ids.message}'),
      ('${ids.generic}', '${ids.familyId}', '${ids.member}', 'system', 'Calendar', 'Calendar reminder.', 'calendar', 'calendar:${suffix}');
  ` });

  const familyNonparticipantRead = runPsql(database, { sql: `set request.jwt.claim.sub = '${ids.nonparticipant}'; set role authenticated; select count(*) from public.notifications where id = '${ids.family}';` }).stdout;
  const familyParticipantRead = runPsql(database, { sql: `set request.jwt.claim.sub = '${ids.member}'; set role authenticated; select count(*) from public.notifications where id = '${ids.family}';` }).stdout;
  const genericRead = runPsql(database, { sql: `set request.jwt.claim.sub = '${ids.nonparticipant}'; set role authenticated; select count(*) from public.notifications where id = '${ids.generic}';` }).stdout;
  assert.equal(familyNonparticipantRead, '0', 'authenticated nonparticipants must not read family-message notices');
  assert.equal(familyParticipantRead, '1', 'current conversation participants must retain family-message notice access');
  assert.equal(genericRead, '1', 'the messaging policy must not hide ordinary notifications');

  runPsql(database, { sql: `set request.jwt.claim.sub = '${ids.nonparticipant}'; set role authenticated; update public.notifications set is_read = true where id = '${ids.family}';` });
  const familyUpdated = runPsql(database, { sql: `select is_read::text from public.notifications where id = '${ids.family}';` }).stdout;
  assert.equal(familyUpdated, 'false', 'authenticated nonparticipants must not update family-message notices');
  runPsql(database, { sql: `set request.jwt.claim.sub = '${ids.member}'; set role authenticated; update public.notifications set is_read = true where id = '${ids.family}';` });
  const participantUpdated = runPsql(database, { sql: `select is_read::text from public.notifications where id = '${ids.family}';` }).stdout;
  assert.equal(participantUpdated, 'true', 'current conversation participants must retain family-message notice updates');

  const refusedInsert = runPsql(database, {
    sql: `set request.jwt.claim.sub = '${ids.member}'; set role authenticated; insert into public.notifications (id, family_id, user_id, type, title, body, related_type, related_id) values ('60000000-0000-4000-8000-000000000001', '${ids.familyId}', '${ids.member}', 'system', 'Forged chat notice', 'no', 'family_message', 'forged:key');`,
    allowFailure: true,
  });
  assert.notEqual(refusedInsert.status, 0, 'authenticated users must not author family-message notices');
  assert.match(refusedInsert.stderr, /row-level security/i, 'forged family-message notice must be rejected by RLS');

  runPsql(database, { sql: `set request.jwt.claim.sub = '${ids.member}'; set role authenticated; insert into public.notifications (id, family_id, user_id, type, title, body, related_type, related_id) values ('60000000-0000-4000-8000-000000000002', '${ids.familyId}', '${ids.member}', 'system', 'Calendar', 'ordinary', 'calendar', 'calendar:inserted-${suffix}');` });
}

function runScenario(name, relatedIdType, suffix) {
  const database = `bubaly_0293_${name}_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const quoted = quoteIdentifier(database);
  runPsql(adminDatabase, { sql: `create database ${quoted};` });
  try {
    runPsql(database, { sql: fixtureSql(relatedIdType) });
    return { database, quoted, suffix };
  } catch (error) {
    runPsql(adminDatabase, { sql: `drop database if exists ${quoted} with (force);`, allowFailure: true });
    throw error;
  }
}

assertDisposableTarget();
bootstrapRoles();
const scenarios = [];
try {
  // The forward path: 0293 converts the uuid column, then 0476 builds on text.
  const fresh = runScenario('fresh', 'uuid', 'fresh');
  scenarios.push(fresh);
  applyMigration(fresh.database, migration0293);
  assert.equal(runPsql(fresh.database, { sql: typeSql }).stdout, 'text', 'fresh UUID schema must convert to text');
  applyMigration(fresh.database, migration0476);
  assertPoliciesInstalled(fresh.database);
  verifyPolicyBehavior(fresh.database, fresh.suffix);
  console.log('PASS 0293 fresh UUID -> text; current 0476 policy behavior holds.');

  // 0476 checks related_id itself: on a uuid column it converts exactly as
  // 0293 does instead of building its key index and policies on a uuid.
  const selfChecked = runScenario('self', 'uuid', 'self');
  scenarios.push(selfChecked);
  applyMigration(selfChecked.database, migration0476);
  assert.equal(runPsql(selfChecked.database, { sql: typeSql }).stdout, 'text', '0476 must convert a uuid related_id to text itself');
  assertPoliciesInstalled(selfChecked.database);
  verifyPolicyBehavior(selfChecked.database, selfChecked.suffix);
  console.log('PASS 0476 converts a uuid related_id to text on its own; its policy behavior holds.');

  // Replay: 0293 is main's file, unchanged, and re-issues ALTER TYPE. That must
  // still apply over a schema carrying 0476, which is why 0476's policies do
  // not name related_id.
  const populated = runScenario('populated', 'text', 'populated');
  scenarios.push(populated);
  applyMigration(populated.database, migration0476);
  assertPoliciesInstalled(populated.database);
  const before = runPsql(populated.database, { sql: policyDigestSql }).stdout;
  applyMigration(populated.database, migration0293);
  assert.equal(runPsql(populated.database, { sql: typeSql }).stdout, 'text', 'populated text schema must remain text');
  assert.equal(runPsql(populated.database, { sql: policyDigestSql }).stdout, before, 'replaying 0293 must preserve all current 0476 policy definitions and roles');
  applyMigration(populated.database, migration0476);
  assert.equal(runPsql(populated.database, { sql: policyDigestSql }).stdout, before, 'replaying 0476 must leave its own policies as they were');
  verifyPolicyBehavior(populated.database, populated.suffix);
  console.log('PASS 0293 replays over 0476; 0476 replays over itself; all current 0476 policies and behavior remain intact.');

  const unexpected = runScenario('unexpected', 'integer', 'unexpected');
  scenarios.push(unexpected);
  const refused = runPsql(unexpected.database, { file: migration0476, transaction: true, allowFailure: true });
  assert.notEqual(refused.status, 0, 'an unexpected related_id type must fail closed');
  assert.match(refused.stderr, /0476 FAILED: notifications\.related_id has unexpected type integer/, 'unexpected type failure should identify the actual type');
  assert.equal(runPsql(unexpected.database, { sql: typeSql }).stdout, 'integer', 'unexpected type failure must not alter the column');
  assert.equal(runPsql(unexpected.database, { sql: policyCountSql }).stdout, '0', 'a refused 0476 must install no notice policy');
  console.log('PASS 0476 refuses unexpected related_id types without changing the column.');
} finally {
  for (const scenario of scenarios) {
    runPsql(adminDatabase, { sql: `drop database if exists ${scenario.quoted} with (force);`, allowFailure: true });
  }
}
