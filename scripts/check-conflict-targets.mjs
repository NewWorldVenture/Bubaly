// scripts/check-conflict-targets.mjs
//
// Every `ON CONFLICT` target in the app, checked against the REAL catalog of a
// database that has had all the migrations replayed into it.
//
// `scripts/audit-supabase-queries.mjs` performs the same check by reading the
// migration files, and runs on every pull request without a database. This one
// exists because that reader can be fooled in the direction that matters: 0261
// drops a unique CONSTRAINT through `execute format(...)`, which no static
// reader can follow, so the file-based view still believes the index is there.
// Believing in an index that is gone means MISSING a defect, silently. The
// catalog cannot be fooled, so this is the authority, and the CI job that has
// already replayed the migrations is where it belongs.
//
// Usage (PG* environment variables select the database):
//   PGDATABASE=bubaly node scripts/check-conflict-targets.mjs
//
// Exit codes: 0 clean, 1 at least one target no index can satisfy.

import { execFileSync } from 'node:child_process';
import { collectConflictTargets, conflictTargetVerdict } from './audit-supabase-queries.mjs';

export const CATALOG_QUERY = `
select c.relname,
       i.relname,
       pg_get_indexdef(x.indexrelid),
       case when x.indpred is not null then 'partial' else 'total' end
from pg_index x
join pg_class i on i.oid = x.indexrelid
join pg_class c on c.oid = x.indrelid
join pg_namespace n on n.oid = c.relnamespace
where x.indisunique and n.nspname = 'public'
order by c.relname, i.relname`;

/**
 * Turn one `pg_get_indexdef` string into the facts inference cares about.
 *
 * The key list is balance-scanned, not matched: an expression key carries its
 * own parentheses. What follows the key list decides nothing except through
 * WHERE — `NULLS NOT DISTINCT` and an `INCLUDE` list leave an index perfectly
 * inferable, and reading either as a predicate would raise a false alarm on a
 * table that is fine.
 */
export function parseIndexDefinition(table, name, definition, partiality) {
  const marker = definition.indexOf('USING btree (');
  if (marker === -1) return null;
  const start = marker + 'USING btree ('.length;
  let depth = 1;
  let cursor = start;
  while (cursor < definition.length && depth > 0) {
    if (definition[cursor] === '(') depth += 1;
    else if (definition[cursor] === ')') depth -= 1;
    cursor += 1;
  }
  const body = definition.slice(start, cursor - 1);

  const keys = [];
  let current = '';
  let nested = 0;
  for (const character of body) {
    if (character === '(') nested += 1;
    if (character === ')') nested -= 1;
    if (character === ',' && nested === 0) { keys.push(current.trim()); current = ''; continue; }
    current += character;
  }
  if (current.trim()) keys.push(current.trim());

  return {
    name, table, keys,
    partial: partiality === 'partial' || /\bWHERE\b/.test(definition.slice(cursor)),
    expression: keys.some((key) => /[()]/.test(key) || key.includes('::')),
  };
}

export function readCatalog(run = (sql) => execFileSync('psql', ['-At', '-F', '|', '-c', sql], { encoding: 'utf8' })) {
  const byTable = new Map();
  for (const line of run(CATALOG_QUERY).trim().split('\n')) {
    if (!line) continue;
    const [table, name, definition, partiality] = line.split('|');
    const index = parseIndexDefinition(table, name, definition ?? '', partiality);
    if (!index) continue;
    const list = byTable.get(table) ?? [];
    list.push(index);
    byTable.set(table, list);
  }
  return byTable;
}

export function checkConflictTargets(catalog, sites = collectConflictTargets()) {
  const problems = [];
  for (const site of sites) {
    // A table the catalog has never heard of is somebody else's finding: the
    // query audit already reports `.from()` on a table no migration creates,
    // and repeating it here would just be noise.
    if (!catalog.has(site.table)) continue;
    const verdict = conflictTargetVerdict(site.target, catalog.get(site.table));
    if (!verdict.ok) problems.push({ ...site, reason: verdict.reason });
  }
  return problems;
}

function runCli() {
  const catalog = readCatalog();
  const sites = collectConflictTargets();
  const problems = checkConflictTargets(catalog, sites);
  console.log(`ON CONFLICT targets: ${sites.length} checked against ${catalog.size} tables in the live catalog.`);
  if (problems.length === 0) {
    console.log('Every target names a unique index Postgres can infer.');
    return 0;
  }
  for (const problem of problems) {
    console.error(`\n${problem.file}:${problem.line}`);
    console.error(`  ${problem.table} ON CONFLICT (${problem.target})`);
    console.error(`  ${problem.reason}`);
  }
  console.error(`\n${problems.length} target(s) no unique index can satisfy. Each fails with 42P10 at planning`);
  console.error('time — on the first row, against an empty table, every time.');
  return 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) process.exit(runCli());
