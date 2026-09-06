import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CATALOG_QUERY, readProductionMigrationState } from './audit-production-migration-state.mjs';

const PROJECT = 'ltcxlbipiihclxwioyqj';
const RELEASE_VERSIONS = Array.from({ length: 15 }, (_, index) => String(240 + index).padStart(4, '0'));
const canonical = (value) => JSON.stringify(value, (_, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const sameRows = (a, b) => canonical(a.map(canonical).sort()) === canonical(b.map(canonical).sort());
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const textArray = (values) => 'ARRAY[' + values.map(literal).join(',') + ']::text[]';

export function readReleaseFiles(manifest, read = (file) => readFileSync(file, 'utf8')) {
  if (manifest.projectRef !== PROJECT ||
      !sameRows(manifest.migrations.map(({ file }) => file.slice(0, 4)), RELEASE_VERSIONS)) {
    throw new Error('Only the pinned 0240-0254 production release is supported.');
  }
  return manifest.migrations.map(({ file, sha256 }) => {
    if (!/^0(?:24\d|25[0-4])_[a-z0-9_]+\.sql$/.test(file)) throw new Error('Invalid release filename.');
    const sql = read('supabase/migrations/' + file).replace(/\r\n/g, '\n');
    if (createHash('sha256').update(sql).digest('hex') !== sha256) {
      throw new Error('Reviewed migration checksum changed: ' + file);
    }
    return { file, sql, version: file.slice(0, 4), name: file.slice(5, -4) };
  }).sort((a, b) => a.version.localeCompare(b.version));
}

export function releaseModeFromArgs(args) {
  if (args.some((arg) => !['--apply', '--require-applied'].includes(arg))) {
    throw new Error('Unknown release option; use --apply or --require-applied, or omit both for preview.');
  }
  const apply = args.includes('--apply');
  const requireApplied = args.includes('--require-applied');
  if (apply && requireApplied) {
    throw new Error('--apply and --require-applied cannot be combined.');
  }
  return { apply, requireApplied };
}

export function assertNoNewerMigrations(migrationNames) {
  const latestReviewedVersion = Number(RELEASE_VERSIONS.at(-1));
  const newer = migrationNames.filter((file) => {
    const match = /^(\d+)_.*\.sql$/i.exec(file);
    return match && Number(match[1]) > latestReviewedVersion;
  }).sort();
  if (newer.length) {
    throw new Error('Production forward release is held: repository migrations outside the pinned 0240-0254 release: ' + newer.join(', '));
  }
}

export function releaseLedger(manifest) {
  return [...manifest.baseline, ...manifest.migrations.map(({ file }) =>
    ({ version: file.slice(0, 4), name: file.slice(5, -4) }))];
}

export function boundaryOf(snapshot, manifest) {
  return {
    columns: snapshot.columns.filter(({ table }) => manifest.boundaryTables.includes(table)),
    constraints: snapshot.constraints.filter(({ table }) => manifest.boundaryTables.includes(table)),
    policies: snapshot.policies.filter(({ table }) => manifest.policyBoundaryTables.includes(table)),
    functions: snapshot.functions.filter(({ name }) => manifest.functionNames.includes(name)),
  };
}

export function assertPreflight(snapshot, manifest) {
  if (!sameRows(snapshot.migrations, manifest.baseline)) {
    throw new Error('Unexpected or partially applied migration ledger; no replay is allowed.');
  }
  for (const table of manifest.requiredTables) {
    if (!snapshot.tables.some(({ name, rls }) => name === table && rls)) {
      throw new Error('Required protected table is unavailable: ' + table);
    }
  }
  if (manifest.newTables.some((table) => snapshot.tables.some(({ name }) => name === table))) {
    throw new Error('A release table already exists without its recorded migration.');
  }
  const actual = boundaryOf(snapshot, manifest);
  for (const key of Object.keys(manifest.boundary)) {
    if (!sameRows(actual[key], manifest.boundary[key])) {
      throw new Error('Production catalog drift requires review: ' + key);
    }
  }
}

export function assertReleased(snapshot, manifest) {
  if (!sameRows(snapshot.migrations, releaseLedger(manifest))) {
    throw new Error('The atomic release ledger has not been confirmed.');
  }
  for (const table of manifest.newTables) {
    if (!snapshot.tables.some(({ name, rls }) => name === table && rls)) {
      throw new Error('Released table is missing row-level security: ' + table);
    }
  }
  for (const table of [...manifest.policyTables, 'ai_requests']) {
    const writes = snapshot.policies.filter((p) => p.table === table && ['INSERT', 'ALL'].includes(p.command));
    if (writes.length !== 1 || writes[0].command !== 'INSERT' ||
        writes[0].name !== table + '_insert' || !sameRows(writes[0].roles, ['authenticated']) ||
        !writes[0].checkHash || writes[0].checkHash === 'd41d8cd98f00b204e9800998ecf8427e') {
      throw new Error('Released INSERT security boundary was not confirmed: ' + table);
    }
  }
  const rpc = snapshot.workerRpc;
  if (!rpc?.exists || rpc.anonymousExecute !== false || rpc.authenticatedExecute !== false || rpc.serviceExecute !== true) {
    throw new Error('Released worker RPC grants were not confirmed.');
  }
  for (const table of manifest.walletTables) {
    for (const command of ['INSERT', 'UPDATE', 'DELETE']) {
      const policy = snapshot.policies.find((p) =>
        p.table === table && p.name === table + '_manager_' + command.toLowerCase() + '_guard');
      if (!policy || policy.command !== command || policy.permissive !== 'RESTRICTIVE' ||
          !sameRows(policy.roles, ['authenticated'])) {
        throw new Error('Restrictive wallet manager boundary was not confirmed: ' + table);
      }
    }
  }
}

export function buildReleaseSql(manifest, files) {
  const catalog = CATALOG_QUERY.trim().replace(/;$/, '');
  const boundary = literal(JSON.stringify(manifest.boundary)) + '::jsonb';
  const baseline = literal(JSON.stringify(manifest.baseline)) + '::jsonb';
  const newTables = textArray(manifest.newTables);
  const required = textArray(manifest.requiredTables);
  const sections = [
    'begin;',
    "set local lock_timeout = '5s';",
    "set local statement_timeout = '90s';",
    'set local standard_conforming_strings = on;',
    'select pg_advisory_xact_lock(2402522026);',
    'lock table supabase_migrations.schema_migrations in share row exclusive mode;',
    // Recheck the catalog in the SAME transaction as the changes.
    'do $release_guard$',
    'declare s jsonb; actual jsonb; expected jsonb := ' + boundary + '; k text; t text;',
    'begin',
    '  select snapshot into s from (' + catalog + ') catalog;',
    "  select coalesce(jsonb_agg(jsonb_build_object('version', version, 'name', name) order by version), '[]'::jsonb)",
    '    into actual from supabase_migrations.schema_migrations;',
    '  if actual <> ' + baseline + " then raise exception 'Release ledger changed'; end if;",
    '  foreach t in array ' + required + ' loop',
    "    if not exists (select 1 from jsonb_array_elements(s->'tables') e where e->>'name' = t and e->>'rls' = 'true')",
    "      then raise exception 'Required protected table missing'; end if;",
    '  end loop;',
    '  foreach t in array ' + newTables + ' loop',
    "    if to_regclass(format('public.%I', t)) is not null then raise exception 'Unrecorded release table exists'; end if;",
    '  end loop;',
    "  foreach k in array ARRAY['columns','constraints','policies','functions'] loop",
    "    select coalesce(jsonb_agg(e), '[]'::jsonb) into actual from jsonb_array_elements(s->k) e",
    "      where case when k = 'functions' then e->>'name' = any(" + textArray(manifest.functionNames) + ')',
    "        when k = 'policies' then e->>'table' = any(" + textArray(manifest.policyBoundaryTables) + ')',
    "        else e->>'table' = any(" + textArray(manifest.boundaryTables) + ') end;',
    "    if not (actual @> (expected->k) and (expected->k) @> actual) then raise exception 'Release catalog changed: %', k; end if;",
    '  end loop;',
    'end $release_guard$;',
  ];
  for (const { sql, version, name } of files) {
    sections.push(
      sql,
      'insert into supabase_migrations.schema_migrations(version, name, statements) values (' +
        literal(version) + ', ' + literal(name) + ', ARRAY[' + literal(sql) + ']::text[]);',
    );
  }
  sections.push(
    'do $release_check$ declare t text; begin',
    '  foreach t in array ' + newTables + ' loop',
    "    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace",
    "      where n.nspname = 'public' and c.relname = t and c.relrowsecurity)",
    "      or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t)",
    "      then raise exception 'Release table security missing'; end if;",
    '  end loop;',
    "  if exists (select 1 from pg_policies where schemaname = 'public' and cmd = 'ALL'",
    '    and tablename = any(' + textArray([...manifest.policyTables, 'ai_requests']) + '))',
    "    then raise exception 'Broad approval write policy remains'; end if;",
    "  if has_function_privilege('anon', 'public.claim_ai_runs(integer,integer)', 'EXECUTE')",
    "    or has_function_privilege('authenticated', 'public.claim_ai_runs(integer,integer)', 'EXECUTE')",
    "    or not has_function_privilege('service_role', 'public.claim_ai_runs(integer,integer)', 'EXECUTE')",
    "    then raise exception 'AI worker RPC permissions are incorrect'; end if;",
    '  foreach t in array ' + textArray(manifest.walletTables) + ' loop',
    "    if (select count(*) from pg_policies where schemaname = 'public' and tablename = t",
    "      and permissive = 'RESTRICTIVE' and roles = ARRAY['authenticated']::name[]",
    "      and ((policyname = t || '_manager_insert_guard' and cmd = 'INSERT')",
    "        or (policyname = t || '_manager_update_guard' and cmd = 'UPDATE')",
    "        or (policyname = t || '_manager_delete_guard' and cmd = 'DELETE'))) <> 3",
    "      then raise exception 'Restrictive wallet manager boundary missing'; end if;",
    '  end loop;',
    'end $release_check$;',
    "notify pgrst, 'reload schema';",
    'commit;',
  );
  return sections.join('\n');
}

export async function runForwardRelease({
  manifest, files, projectRef, token, apply = false, requireApplied = false, fetchImpl = fetch,
  listMigrationFiles = () => readdirSync(new URL('../supabase/migrations/', import.meta.url)),
}) {
  if (apply && requireApplied) {
    throw new Error('--apply and --require-applied cannot be combined.');
  }
  // Preview and already-applied results must not conceal a newer unreviewed migration.
  assertNoNewerMigrations(listMigrationFiles());
  if (projectRef !== PROJECT || projectRef !== manifest.projectRef || !token) {
    throw new Error('This release requires the audited Bubaly production project and access token.');
  }
  const snapshot = await readProductionMigrationState({ projectRef, token, fetchImpl });
  if (sameRows(snapshot.migrations, releaseLedger(manifest))) {
    assertReleased(snapshot, manifest);
    return { status: 'already_applied', release: manifest.release };
  }
  if (requireApplied) {
    const observedVersions = snapshot.migrations.map(({ version }) => version).join(', ') || '(none)';
    throw new Error('Reviewed release is not applied: the exact baseline plus pinned release ledger is required; observed versions: ' + observedVersions + '.');
  }
  assertPreflight(snapshot, manifest);
  if (!apply) {
    return { status: 'preview', release: manifest.release, migrations: files.map(({ version }) => version), newTables: manifest.newTables.length };
  }
  let response;
  try {
    response = await fetchImpl('https://api.supabase.com/v1/projects/' + projectRef + '/database/query', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: buildReleaseSql(manifest, files), read_only: false }),
      redirect: 'error',
      signal: AbortSignal.timeout(180_000),
    });
  } catch {
    // A lost response is NOT permission to retry a production mutation.
    throw new Error('Release outcome is uncertain. Read the migration ledger before any retry.');
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const state = body.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1];
    const guard = [
      'Release ledger changed', 'Required protected table missing',
      'Unrecorded release table exists', 'Release catalog changed: columns',
      'Release catalog changed: constraints', 'Release catalog changed: policies',
      'Release catalog changed: functions', 'Release table security missing',
      'Broad approval write policy remains', 'AI worker RPC permissions are incorrect',
      'Restrictive wallet manager boundary missing',
    ].find((message) => body.includes(message));
    throw new Error('Release returned HTTP ' + response.status + (state ? ' (SQLSTATE ' + state + ')' : '') +
      (guard ? ' [' + guard + ']' : '') +
      '. Read the audit before any retry; private database error details were withheld.');
  }
  await response.body?.cancel();
  const after = await readProductionMigrationState({ projectRef, token, fetchImpl });
  assertReleased(after, manifest);
  return { status: 'applied', release: manifest.release, migrations: files.map(({ version }) => version), newTables: manifest.newTables.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = releaseModeFromArgs(process.argv.slice(2));
    const manifest = JSON.parse(readFileSync('supabase/production-forward-release.json', 'utf8'));
    const files = readReleaseFiles(manifest);
    const result = await runForwardRelease({
      manifest, files, projectRef: process.env.SUPABASE_PROJECT_REF,
      token: process.env.SUPABASE_ACCESS_TOKEN, ...mode,
    });
    mkdirSync('.next', { recursive: true });
    writeFileSync('.next/production-forward-release-result.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
