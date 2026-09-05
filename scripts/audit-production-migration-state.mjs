import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Catalog metadata only: no family records, secret tables, or general function
// bodies. The seven core definitions are the known functions replayed by 0003.
export const CATALOG_QUERY = `
select pg_catalog.jsonb_build_object(
  'hasMigrationLedger', pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null,
  'publicFunctionDefaults', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'schema', coalesce(n.nspname, '*'), 'owner', pg_catalog.pg_get_userbyid(d.defaclrole),
    'grantee', case when a.grantee = 0 then 'public' else pg_catalog.pg_get_userbyid(a.grantee) end,
    'privilege', a.privilege_type))
    from pg_catalog.pg_default_acl d
    left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral pg_catalog.aclexplode(d.defaclacl) a
    where d.defaclobjtype = 'f' and (d.defaclnamespace = 0 or n.nspname = 'public')), '[]'::jsonb),
  'workerRpc', (select pg_catalog.jsonb_build_object(
    'exists', oid is not null,
    'anonymousExecute', case when oid is not null then pg_catalog.has_function_privilege('anon', oid, 'EXECUTE') else null end,
    'authenticatedExecute', case when oid is not null then pg_catalog.has_function_privilege('authenticated', oid, 'EXECUTE') else null end,
    'serviceExecute', case when oid is not null then pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE') else null end)
    from (select pg_catalog.to_regprocedure('public.claim_ai_runs(integer,integer)') as oid) f),
  'tables', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'name', c.relname, 'rls', c.relrowsecurity) order by c.relname)
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')), '[]'::jsonb),
  'columns', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'table', table_name, 'name', column_name, 'type', udt_name, 'nullable', is_nullable)
    order by table_name, ordinal_position)
    from information_schema.columns where table_schema = 'public'), '[]'::jsonb),
  'policies', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'table', tablename, 'name', policyname, 'command', cmd, 'roles', roles,
    'permissive', permissive, 'usingHash', pg_catalog.md5(coalesce(qual,'')),
    'checkHash', pg_catalog.md5(coalesce(with_check,''))) order by tablename, policyname)
    from pg_catalog.pg_policies where schemaname = 'public'), '[]'::jsonb),
  'functions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'name', p.proname, 'arguments', pg_catalog.pg_get_function_identity_arguments(p.oid),
    'securityDefiner', p.prosecdef, 'definitionHash', pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)))
    order by p.proname, p.oid)
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'), '[]'::jsonb),
  'constraints', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'table', c.relname, 'name', k.conname, 'type', k.contype,
    'definitionHash', pg_catalog.md5(pg_catalog.pg_get_constraintdef(k.oid))) order by c.relname, k.conname)
    from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid = k.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'), '[]'::jsonb),
  'coreFunctions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'name', p.proname, 'definition', pg_catalog.pg_get_functiondef(p.oid)) order by p.proname)
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.proname in
      ('is_family_member','family_role','can_manage_family','is_family_admin',
       'set_updated_at','handle_new_user','handle_new_family')), '[]'::jsonb)
) as snapshot;
`;

export async function readProductionMigrationState({ projectRef, token, fetchImpl = fetch }) {
  if (!/^[a-z0-9]{20}$/.test(projectRef ?? '') || !token) {
    throw new Error('SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN are required.');
  }
  async function query(sql) {
    let response;
    try {
      response = await fetchImpl(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql, read_only: true }),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('The read-only production metadata request failed.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`The read-only production metadata request returned HTTP ${response.status}.`);
    }
    try { return await response.json(); }
    catch { throw new Error('The production metadata response was not valid JSON.'); }
  }
  const rows = await query(CATALOG_QUERY);
  const snapshot = rows?.[0]?.snapshot;
  if (!snapshot || !Array.isArray(snapshot.tables) || !Array.isArray(snapshot.policies)) {
    throw new Error('The production catalog response had an unexpected shape.');
  }
  const migrations = snapshot.hasMigrationLedger
    ? await query('select version, name from supabase_migrations.schema_migrations order by version;')
    : [];
  if (!Array.isArray(migrations)) throw new Error('The migration ledger response had an unexpected shape.');
  return { ...snapshot, migrations };
}

export function hasUnrecordedBaseline(snapshot) {
  return snapshot.policies.some((policy) => policy.table === 'profiles' && policy.name === 'profiles_insert_self')
    && !snapshot.migrations.some((migration) => migration.version === '0004');
}

export async function runProductionMigrationAudit() {
  const snapshot = await readProductionMigrationState({
    projectRef: process.env.SUPABASE_PROJECT_REF,
    token: process.env.SUPABASE_ACCESS_TOKEN,
  });
  mkdirSync('.next', { recursive: true });
  writeFileSync('.next/production-schema-audit.json', JSON.stringify(snapshot, null, 2));
  const requiresBaselineReview = hasUnrecordedBaseline(snapshot);
  console.log(JSON.stringify({
    migrationVersions: snapshot.migrations.map(({ version }) => version),
    tableCount: snapshot.tables.length,
    policyCount: snapshot.policies.length,
    requiresBaselineReview,
  }));
  if (process.argv.includes('--enforce-history') && requiresBaselineReview) {
    throw new Error('Existing production policies have no recorded baseline migration 0004. Historical replay is blocked; review the schema audit before repairing migration history.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runProductionMigrationAudit(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
