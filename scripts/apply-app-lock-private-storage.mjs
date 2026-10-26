import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PROJECT = 'ltcxlbipiihclxwioyqj';
export const VERSION = '20261025234230';
export const NAME = 'app_lock_credentials_are_server_private';
export const MIGRATION_SHA256 = '52f72f1f3160402b6d416d4180945aeeb9e9550242b2d5a52ab00ee14db22bc6';
// Kept outside automatic migration discovery: production source must be live
// before this exact copy/scrub transaction can run.
const FILE = new URL(`../supabase/reserved/${VERSION}_${NAME}.sql`, import.meta.url);
const MAIN = 'https://api.github.com/repos/NewWorldVenture/Bubaly/git/ref/heads/main';
const LIVE = 'https://www.bubaly.com/api/build-info';
const digest = value => createHash('sha256').update(value).digest('hex');
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;

function assertFile(file) {
  if (file?.version !== VERSION || file?.name !== NAME || file?.sha256 !== MIGRATION_SHA256
    || typeof file.sql !== 'string' || digest(file.sql) !== MIGRATION_SHA256) {
    throw new Error('The fixed reviewed App Lock migration checksum or identity changed.');
  }
}

export function readAppLockMigration(read = file => readFileSync(file, 'utf8')) {
  const file = { sql: read(FILE), version: VERSION, name: NAME, sha256: MIGRATION_SHA256 };
  assertFile(file);
  return file;
}

// Catalog/aggregate metadata only. No user identifiers, credential material or
// SQL statements leave the database. Hash other ledger rows to fence drift.
export const SNAPSHOT_SQL = `select jsonb_build_object(
  'schemaReady', exists(select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls))
    and has_schema_privilege(current_user,'public','CREATE')
    and has_database_privilege(current_user,current_database(),'TEMPORARY')
    and has_column_privilege(current_user,'auth.users','id','REFERENCES')
    and has_table_privilege(current_user,'public.user_preferences','SELECT')
    and has_table_privilege(current_user,'public.user_preferences','UPDATE')
    and has_table_privilege(current_user,'public.user_preferences','TRIGGER')
    and has_table_privilege(current_user,'supabase_migrations.schema_migrations','SELECT')
    and has_table_privilege(current_user,'supabase_migrations.schema_migrations','INSERT')
    and has_table_privilege(current_user,'supabase_migrations.schema_migrations','UPDATE,DELETE,TRUNCATE')
    and exists(select 1 from pg_class where oid='public.user_preferences'::regclass and relkind='r' and relrowsecurity)
    and exists(select 1 from pg_attribute where attrelid='public.user_preferences'::regclass and attname='user_id' and atttypid='uuid'::regtype and not attisdropped)
    and exists(select 1 from pg_attribute where attrelid='public.user_preferences'::regclass and attname='notification_prefs' and atttypid='jsonb'::regtype and not attisdropped)
    and exists(select 1 from pg_attribute where attrelid='auth.users'::regclass and attname='id' and atttypid='uuid'::regtype and not attisdropped)
    and (select count(*)=3 from pg_attribute where attrelid='supabase_migrations.schema_migrations'::regclass and not attisdropped
      and ((attname in ('version','name') and atttypid='text'::regtype) or (attname='statements' and atttypid='text[]'::regtype)))
    and exists(select 1 from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attname='version'
      where c.conrelid='supabase_migrations.schema_migrations'::regclass and c.contype='p' and c.conkey=array[a.attnum]),
  'privateTable', to_regclass('public.app_lock_credentials') is not null,
  'rejectFunction', to_regprocedure('public.reject_app_lock_preferences()') is not null,
  'rejectTrigger', exists(select 1 from pg_trigger where tgrelid='public.user_preferences'::regclass and tgname='user_preferences_reject_app_lock'),
  'historyConflict', exists(select 1 from supabase_migrations.schema_migrations where name='${NAME}' and version<>'${VERSION}'),
  'otherLedgerHash', encode(sha256(convert_to(coalesce((select jsonb_agg(jsonb_build_array(version,name,
      encode(sha256(convert_to(coalesce(to_jsonb(statements)::text,'null'),'UTF8')),'hex')) order by version)::text
      from supabase_migrations.schema_migrations where version<>'${VERSION}'),'[]'),'UTF8')),'hex'),
  'migration', (select jsonb_build_object('name',name,'statementCount',cardinality(statements),
    'sha256',encode(sha256(convert_to(statements[1],'UTF8')),'hex')) from supabase_migrations.schema_migrations where version='${VERSION}'),
  'legacy', (select jsonb_build_object(
    'keys',count(*) filter(where notification_prefs ? 'appLock'),
    'records',count(*) filter(where notification_prefs ? 'appLock' and notification_prefs->'appLock'<>'null'::jsonb),
    'enabled',count(*) filter(where notification_prefs->'appLock'->>'enabled'='true'),
    'malformed',count(*) filter(where notification_prefs ? 'appLock' and notification_prefs->'appLock'<>'null'::jsonb
      and not coalesce(jsonb_typeof(notification_prefs->'appLock')='object'
        and jsonb_typeof(notification_prefs->'appLock'->'enabled')='boolean'
        and jsonb_typeof(notification_prefs->'appLock'->'salt')='string'
        and notification_prefs->'appLock'->>'salt' ~ '^[0-9a-f]{32}$'
        and jsonb_typeof(notification_prefs->'appLock'->'hash')='string'
        and notification_prefs->'appLock'->>'hash' ~ '^[0-9a-f]{64}$',false))) from public.user_preferences)
) as snapshot`;

export const VERIFICATION_SQL = `select jsonb_build_object(
  'privateRls',(select relrowsecurity from pg_class where oid='public.app_lock_credentials'::regclass and relkind='r'),
  'privateForceRls',(select relforcerowsecurity from pg_class where oid='public.app_lock_credentials'::regclass and relkind='r'),
  'policyCount',(select count(*) from pg_policy where polrelid='public.app_lock_credentials'::regclass),
  'browserPrivileges',exists(select 1 from unnest(array['anon','authenticated']) as roles(role)
    where has_table_privilege(role,'public.app_lock_credentials','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(role,'public.app_lock_credentials','SELECT,INSERT,UPDATE,REFERENCES')),
  'servicePrivileges',has_table_privilege('service_role','public.app_lock_credentials','SELECT')
    and has_table_privilege('service_role','public.app_lock_credentials','INSERT')
    and has_table_privilege('service_role','public.app_lock_credentials','UPDATE')
    and has_table_privilege('service_role','public.app_lock_credentials','DELETE')
    and not has_table_privilege('service_role','public.app_lock_credentials','TRUNCATE,REFERENCES,TRIGGER'),
  'triggerProtected',exists(select 1 from pg_trigger t join pg_attribute a on a.attrelid=t.tgrelid and a.attname='notification_prefs'
    where t.tgrelid='public.user_preferences'::regclass and t.tgname='user_preferences_reject_app_lock'
      and t.tgenabled='O' and t.tgtype=23 and not t.tgisinternal and t.tgqual is null and t.tgnargs=0
      and t.tgattr::text=a.attnum::text and t.tgfoid='public.reject_app_lock_preferences()'::regprocedure),
  'functionProtected',exists(select 1 from pg_proc where oid='public.reject_app_lock_preferences()'::regprocedure
    and not prosecdef and proconfig=array['search_path=""']::text[]
    and prolang=(select oid from pg_language where lanname='plpgsql')
    and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='ed18ade6a54371b1f8b8aba98ef1e8a1359873ff75880fe44647efa2951e90dc')
    and not has_function_privilege('anon','public.reject_app_lock_preferences()','EXECUTE')
    and not has_function_privilege('authenticated','public.reject_app_lock_preferences()','EXECUTE')
    and not has_function_privilege('service_role','public.reject_app_lock_preferences()','EXECUTE'),
  'publicKeys',(select count(*) from public.user_preferences where notification_prefs ? 'appLock'),
  'privateRecords',(select count(*) from public.app_lock_credentials),
  'enabledPrivate',(select count(*) from public.app_lock_credentials where enabled)
) as verification`;

function assertSnapshot(value) {
  const legacy = value?.legacy;
  if (value?.schemaReady !== true || value?.historyConflict !== false || !hash(value?.otherLedgerHash)
    || !['privateTable','rejectFunction','rejectTrigger'].every(key => typeof value[key] === 'boolean')
    || !legacy || !['keys','records','enabled','malformed'].every(key => count(legacy[key]))
    || legacy.keys < legacy.records || legacy.records < legacy.enabled || legacy.records < legacy.malformed
    || legacy.malformed !== 0) throw new Error('App Lock schema/history preflight failed or legacy credentials are malformed.');
  if (value.migration === null) {
    if (value.privateTable || value.rejectFunction || value.rejectTrigger) {
      throw new Error('Unrecorded App Lock schema exists; no replay is allowed.');
    }
    return false;
  }
  if (!value.privateTable || !value.rejectFunction || !value.rejectTrigger || legacy.keys !== 0
    || value.migration?.name !== NAME || value.migration?.statementCount !== 1
    || value.migration?.sha256 !== MIGRATION_SHA256) {
    throw new Error('The App Lock migration ledger checksum or released schema does not match.');
  }
  return true;
}

function assertVerification(value) {
  if (!value || !['privateRls','privateForceRls','servicePrivileges','triggerProtected','functionProtected'].every(key => value[key] === true)
    || value.policyCount !== 0 || value.browserPrivileges !== false || value.publicKeys !== 0
    || !count(value.privateRecords) || !count(value.enabledPrivate) || value.enabledPrivate > value.privateRecords) {
    throw new Error('App Lock private ACL, rejection trigger, or public scrub verification failed.');
  }
}

export function buildAppLockReleaseSql(file, otherLedgerHash) {
  assertFile(file);
  if (!hash(otherLedgerHash)) throw new Error('App Lock release requires the preflight ledger fingerprint.');
  // The reviewed file has exactly these outer transaction delimiters. Its DO
  // blocks keep their own BEGIN/END; a global replacement would corrupt them.
  const match = /^(?:--[^\n]*\n|\s)*begin;\n([\s\S]*)\ncommit;\s*$/.exec(file.sql);
  if (!match) throw new Error('The reviewed App Lock transaction envelope changed.');
  return `begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
lock table supabase_migrations.schema_migrations in share row exclusive mode;
lock table public.user_preferences in share row exclusive mode;
do $app_lock_release_guard$
declare observed jsonb;
begin
  select snapshot into observed from (${SNAPSHOT_SQL}) s;
  if observed->>'otherLedgerHash' is distinct from ${literal(otherLedgerHash)}
    or observed->'migration' <> 'null'::jsonb
    or observed->>'schemaReady' is distinct from 'true'
    or observed->>'historyConflict' is distinct from 'false'
    or observed->>'privateTable' is distinct from 'false'
    or observed->>'rejectFunction' is distinct from 'false'
    or observed->>'rejectTrigger' is distinct from 'false'
    or observed->'legacy'->>'malformed' is distinct from '0'
  then raise exception 'App Lock release preflight changed'; end if;
end;
$app_lock_release_guard$;
create temporary table app_lock_release_before on commit drop as
  select count(*) as records, count(*) filter(where notification_prefs->'appLock'->>'enabled'='true') as enabled
  from public.user_preferences where notification_prefs ? 'appLock' and notification_prefs->'appLock'<>'null'::jsonb;
${match[1]}
do $app_lock_release_verify$
declare observed jsonb;
begin
  select verification into observed from (${VERIFICATION_SQL}) v;
  if observed->>'privateRls' is distinct from 'true' or observed->>'privateForceRls' is distinct from 'true'
    or observed->>'servicePrivileges' is distinct from 'true' or observed->>'triggerProtected' is distinct from 'true'
    or observed->>'functionProtected' is distinct from 'true' or observed->>'policyCount' is distinct from '0'
    or observed->>'browserPrivileges' is distinct from 'false' or observed->>'publicKeys' is distinct from '0'
    or (observed->>'privateRecords')::bigint is distinct from (select records from app_lock_release_before)
    or (observed->>'enabledPrivate')::bigint is distinct from (select enabled from app_lock_release_before)
  then raise exception 'App Lock release verification failed'; end if;
end;
$app_lock_release_verify$;
insert into supabase_migrations.schema_migrations(version,name,statements)
values (${literal(VERSION)},${literal(NAME)},ARRAY[${literal(file.sql)}]::text[]);
notify pgrst, 'reload schema';
commit;`;
}

async function readJson(fetchImpl, url, options, label) {
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), ...options });
    if (!response.ok || response.redirected) throw new Error();
    const text = await response.text();
    if (text.length > 65_536) throw new Error();
    return JSON.parse(text);
  } catch { throw new Error(`${label} failed; remote error details were withheld.`); }
}

export async function runAppLockRelease({ projectRef, token, expectedRevision, githubSha, githubRef, githubToken,
  apply = false, fetchImpl = fetch, file = readAppLockMigration() }) {
  assertFile(file);
  if (projectRef !== PROJECT || typeof token !== 'string' || !token) throw new Error('The audited App Lock project and access token are required.');
  if (typeof apply !== 'boolean') throw new Error('App Lock apply must be an explicit boolean.');
  if (!sha(expectedRevision) || githubSha !== expectedRevision || githubRef !== 'refs/heads/main') {
    throw new Error('App Lock release requires the exact reviewed main revision.');
  }
  const endpoint = `https://api.supabase.com/v1/projects/${PROJECT}/database/query`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const query = async (sql, field) => {
    const rows = await readJson(fetchImpl, endpoint, { method: 'POST', headers,
      body: JSON.stringify({ query: sql, read_only: true }) }, 'App Lock read-only database check');
    if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]?.[field]) throw new Error('App Lock database metadata response is malformed.');
    return rows[0][field];
  };
  const before = await query(SNAPSHOT_SQL, 'snapshot');
  const applied = assertSnapshot(before);
  const result = status => ({ status, version: VERSION, migrationSha256: MIGRATION_SHA256, revision: expectedRevision,
    legacy: before.legacy, otherLedgerHash: before.otherLedgerHash });
  if (applied) {
    assertVerification(await query(VERIFICATION_SQL, 'verification'));
    return result('already_applied');
  }
  if (!apply) return result('preview');
  if (typeof githubToken !== 'string' || !githubToken) throw new Error('GitHub read authentication is required to verify current main.');
  const checkMain = async () => {
    const main = await readJson(fetchImpl, MAIN, { headers: { Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Cache-Control': 'no-cache' } }, 'Current GitHub main verification');
    if (main?.object?.sha !== expectedRevision) throw new Error('Current GitHub main is not the reviewed App Lock revision.');
  };
  await checkMain();
  const live = await readJson(fetchImpl, LIVE, { headers: { 'Cache-Control': 'no-cache' }, cache: 'no-store' }, 'Live App Lock revision verification');
  if (live?.revision !== expectedRevision) throw new Error('Production is not running the reviewed server-private App Lock revision.');
  // Detect a main update during the live-build read before making the one write.
  await checkMain();
  let response;
  try {
    response = await fetchImpl(endpoint, { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({ query: buildAppLockReleaseSql(file, before.otherLedgerHash), read_only: false }) });
  } catch { throw new Error('App Lock release outcome is uncertain. Read the ledger before any retry.'); }
  if (!response.ok || response.redirected) {
    await response.body?.cancel().catch(() => {});
    throw new Error('App Lock release failed; database details were withheld. Read the ledger before any retry.');
  }
  await response.body?.cancel().catch(() => {});
  const after = await query(SNAPSHOT_SQL, 'snapshot');
  if (!assertSnapshot(after) || after.otherLedgerHash !== before.otherLedgerHash) throw new Error('App Lock release ledger was not confirmed or unrelated history changed.');
  assertVerification(await query(VERIFICATION_SQL, 'verification'));
  return result('applied');
}

export function releaseModeFromArgs(args) {
  if (args.length > 1 || args.some(arg => arg !== '--apply')) throw new Error('Use only --apply, or no option for read-only preview.');
  return { apply: args.length === 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runAppLockRelease({ ...releaseModeFromArgs(process.argv.slice(2)),
      projectRef: process.env.SUPABASE_PROJECT_REF, token: process.env.SUPABASE_ACCESS_TOKEN,
      expectedRevision: process.env.EXPECTED_REVISION, githubSha: process.env.GITHUB_SHA,
      githubRef: process.env.GITHUB_REF, githubToken: process.env.GITHUB_TOKEN });
    mkdirSync('.next', { recursive: true });
    writeFileSync('.next/app-lock-private-storage-release.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
