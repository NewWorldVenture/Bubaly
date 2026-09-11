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
  -- Money write policies, resolved rather than hashed.
  --
  -- Every other policy in this snapshot is reported as md5(qual) / md5(with_check):
  -- catalog metadata only, no expressions. That is the right default, but on the
  -- money tables it produced a loop. A reader could see "wallet_transactions has a
  -- permissive INSERT policy" and could NOT see whether it required manager role,
  -- because a hash of can_manage_family(family_id) and a hash of
  -- is_family_member(family_id) are equally opaque. Those two differ by whether a
  -- child can mint money, so the only safe response was to escalate — which is
  -- exactly what happened, three releases running.
  --
  -- This resolves the one bit that decides it, and only that bit: a boolean for
  -- whether the policy mentions can_manage_family. No expression text leaves the
  -- database, so the hashing posture above is unchanged. See docs/runbooks/LB-016.
  'moneyWritePolicies', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'table', c.relname, 'name', p.polname,
    'command', case p.polcmd when 'a' then 'INSERT' when 'w' then 'UPDATE'
                             when 'd' then 'DELETE' when '*' then 'ALL' end,
    'permissive', p.polpermissive,
    'managerGated', coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
                    coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')
                    like '%can_manage_family%')
    order by c.relname, p.polname)
    from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and p.polcmd in ('a','w','d','*')
      and c.relname = any (array[
        'family_wallets','child_wallets','wallet_buckets','wallet_transactions','wallet_rules',
        'financial_accounts','transactions','budgets','bills','savings_goals'])), '[]'::jsonb),
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

/**
 * Does a non-manager currently have a write into the household's money?
 *
 * Answers the question the hashes could not, in the two halves that actually
 * decide it:
 *
 *   openWrites  — a PERMISSIVE write policy that does not require manager role.
 *                 Permissive policies OR together, so one of these is enough to
 *                 grant the write on its own.
 *   unguarded   — a money table with no RESTRICTIVE write guard. Restrictive
 *                 policies AND, so a guarded table survives a stray permissive
 *                 policy; an unguarded one does not.
 *
 * `exploitable` is the conjunction, and it is the only line a responder needs:
 * an open write on a table with no backstop is a child able to move money.
 * An open write on a guarded table is reportable but not exploitable — that is
 * the wallet finding, and LB-016 explains why halting on it adds nothing.
 */
/** The ten tables the money boundary covers, in the order the SQL lists them. */
export const MONEY_TABLES = [
  'family_wallets', 'child_wallets', 'wallet_buckets', 'wallet_transactions', 'wallet_rules',
  'financial_accounts', 'transactions', 'budgets', 'bills', 'savings_goals',
];

/**
 * Can a non-manager write to a money table?
 *
 * This used to reason from `moneyWritePolicies` alone, which left two states
 * invisible — both of which report as clean:
 *
 *  1. RLS DISABLED. Every policy is inert, so the table has no ungated
 *     permissive write and is writable by anyone holding the table grant. The
 *     snapshot has carried `tables[].rls` all along; this never read it.
 *     Verified on PostgreSQL 16.13: a table with RLS off, three restrictive
 *     guards still present and zero ungated writes is CLEAN by a policy-only
 *     rule and open in fact.
 *
 *  2. NO WRITE POLICY AT ALL. `moneyWritePolicies` only contains tables that
 *     have at least one write policy, so a table with none never appeared in
 *     `unguarded` and `exploitable` stayed false. That state is genuinely
 *     closed when RLS is on — RLS denies what no policy allows — but it was
 *     being reported by omission rather than by decision, and it is why
 *     `unguarded: []` was glossed in the runbook as "every table has a guard"
 *     when it only ever meant "no table that has a write policy lacks a guard".
 *
 * The verdict vocabulary matches docs/audit/money-boundary-state.sql so the
 * automated check and the hand-run query say the same words.
 */
export function moneyWriteVerdict(snapshot) {
  const rows = snapshot.moneyWritePolicies ?? [];
  const tableList = Array.isArray(snapshot.tables) ? snapshot.tables : [];
  const rlsByTable = new Map(tableList.map((t) => [t.name, t.rls === true]));
  // An older snapshot predating the table list cannot answer the RLS question.
  // Say so rather than defaulting either way: claiming "RLS is on" would invent
  // a guarantee, and claiming "RLS is off" would invent a finding.
  const rlsKnown = tableList.length > 0;

  const openWrites = rows
    .filter((r) => r.permissive && !r.managerGated)
    .map((r) => `${r.table}.${r.name} (${r.command})`);
  const guarded = new Set(rows.filter((r) => !r.permissive).map((r) => r.table));
  const withWritePolicy = new Set(rows.map((r) => r.table));

  const present = rlsKnown
    ? MONEY_TABLES.filter((t) => rlsByTable.has(t))
    : [...withWritePolicy].filter((t) => MONEY_TABLES.includes(t));

  const rlsDisabled = rlsKnown ? present.filter((t) => !rlsByTable.get(t)).sort() : [];
  const unguarded = present.filter((t) => withWritePolicy.has(t) && !guarded.has(t)).sort();
  const noWritePolicy = present.filter((t) => !withWritePolicy.has(t)).sort();
  const absent = rlsKnown ? MONEY_TABLES.filter((t) => !rlsByTable.has(t)).sort() : [];

  const verdicts = Object.fromEntries(MONEY_TABLES.map((t) => {
    if (rlsKnown && !rlsByTable.has(t)) return [t, 'table absent'];
    if (rlsDisabled.includes(t)) return [t, 'OPEN - RLS DISABLED'];
    if (noWritePolicy.includes(t)) return [t, 'CLOSED - RLS on, no write policy grants access'];
    if (!openWrites.some((w) => w.startsWith(`${t}.`))) return [t, 'CLOSED - every write is manager-gated'];
    if (guarded.has(t)) return [t, 'closed by restrictive guard'];
    return [t, 'OPEN - non-manager can write'];
  }).filter(([, v]) => v !== undefined));

  return {
    openWrites,
    unguarded,
    rlsDisabled,
    noWritePolicy,
    absent,
    rlsKnown,
    verdicts,
    // RLS off is exploitable on its own: the policies below it do not apply.
    exploitable: rlsDisabled.length > 0 || openWrites.some((w) => unguarded.includes(w.split('.')[0])),
    runbook: 'docs/runbooks/LB-016-wallet-permissive-policy-finding.md',
  };
}

/**
 * The gate below is unchanged and must stay that way — it still throws, and
 * historical replay stays blocked. What it did not do is say where the answer
 * lives, so every responder re-derived it: three releases stopped here and each
 * one read the money verdict as the cause. It is not. This is the ledger, and
 * repairing it is a credentialed operator action rather than a code change.
 */
export function baselineBlockedMessage(runbook) {
  return [
    'Existing production policies have no recorded baseline migration 0004.',
    'Historical replay is blocked; review the schema audit before repairing migration history.',
    `This is the migration ledger, NOT the money boundary — read moneyWrites above for that (${runbook} §0).`,
    `Repairing it is a credentialed operator action: ${runbook} §4.`,
  ].join(' ');
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
  const moneyWrites = moneyWriteVerdict(snapshot);
  console.log(JSON.stringify({
    migrationVersions: snapshot.migrations.map(({ version }) => version),
    tableCount: snapshot.tables.length,
    policyCount: snapshot.policies.length,
    requiresBaselineReview,
    moneyWrites,
  }));
  if (process.argv.includes('--enforce-history') && requiresBaselineReview) {
    throw new Error(baselineBlockedMessage(moneyWrites.runbook));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runProductionMigrationAudit(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
