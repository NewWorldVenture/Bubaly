// scripts/audit-supabase-queries.mjs
//
// Static audit of every Supabase call the app makes, checked against the SQL
// migrations. It needs no database and no credentials, so it runs in CI on a
// plain checkout — which is the point. These are the failures TypeScript does
// not catch, because a wrong column name is still a valid string, and that only
// surface in production as a page that renders empty.
//
// It reports five things:
//
//   1. `.from('t')` naming a table no migration creates.
//   2. A column read in `.select()` / `.eq()` / `.order()` / … that the table
//      does not have. PostgREST rejects the whole query, so the caller gets
//      null data (or throws) with nothing wrong in the types.
//   3. A column written by `.insert()` / `.update()` / `.upsert()` that the
//      table does not have — the same failure on the write path.
//   4. `.rpc('fn')` with no matching `create function`.
//   5. A table with RLS enabled, no policy anywhere, and no `family_id` (so the
//      generic sweep in 0118 does not heal it) that is still read with the
//      user-scoped client. RLS with no policy is a deny-all: those reads return
//      zero rows forever, and `maybeSingle()` reports that as "nothing is
//      configured" rather than as an error, so nothing is logged.
//   6. An `.upsert(rows, { onConflict })` whose target no unique index can
//      satisfy. Postgres resolves an ON CONFLICT column list by INDEX
//      INFERENCE, which matches only a unique index over exactly those columns
//      that is neither an expression index nor partial. Nothing else is a
//      candidate — not a partial index over the same columns, not an expression
//      index that computes one of them. When none matches, the statement fails
//      at PLANNING time (`42P10`), so it fails on the first row of an empty
//      table, every time, forever. Five of these were live when this check was
//      written; each read perfectly well on its own, and so did the migration
//      that created the index. Only the pair was wrong.
//
//      The same check runs over `supabase/SEED_ALL.sql`, whose errors the
//      bootstrap deliberately swallows. It does NOT run over the DML inside the
//      migrations themselves: that already has a stronger proof, since CI
//      replays every migration and a failing ON CONFLICT aborts the replay. SQL
//      inside FUNCTION BODIES is checked by neither, and is the known gap here.
//
// Usage: node scripts/audit-supabase-queries.mjs   (exit 1 on any finding)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
const CODE_DIRS = ['app', 'components', 'lib'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git']);

// Column-first PostgREST filters: the first argument names a real column.
const FILTERS = [
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in',
  'contains', 'containedBy', 'order', 'not',
];
const WRITES = ['insert', 'update', 'upsert'];

// Words that open a table CONSTRAINT rather than a column definition.
const CONSTRAINT_WORDS = new Set([
  'primary', 'foreign', 'unique', 'check', 'constraint', 'exclude', 'like', 'partition',
]);

// A read made with a service-role client bypasses RLS, so it is not evidence of
// a deny-all problem. Classification is per CALL SITE, not per file: plenty of
// modules build both clients, and `app/(app)/marketplace/orders/page.tsx` reads
// most tables as the user but `stripe_settings` through createServiceClient().
const SERVICE_FACTORY = /createServiceClient|createAdmin|requireMarketingAdmin|serviceWriter|requireSuperAdmin/;
const USER_FACTORY = /createServer|createBrowserClient|useSupabase/;

/**
 * Which client a single `.from()` call runs on: 'service', 'user', or 'unknown'
 * when the receiver is a parameter and only the caller knows. 'unknown' is not
 * a finding — guessing there is what fills the report with false positives.
 */
function classifyReceiver(src, fromIndex) {
  const before = src.slice(Math.max(0, fromIndex - 240), fromIndex);
  const receiver = /([A-Za-z0-9_$.]+\s*\(\s*\)|[A-Za-z0-9_$.]+)\s*$/.exec(before)?.[1];
  if (!receiver) return 'unknown';

  const inline = receiver.replace(/\s+/g, '');
  if (inline.endsWith('()')) {
    if (SERVICE_FACTORY.test(inline)) return 'service';
    if (USER_FACTORY.test(inline)) return 'user';
    return 'unknown';
  }

  // A bare identifier (or `scope.db`): resolve it to its assignment in this file.
  const name = inline.split('.')[0];
  const assignment = new RegExp(
    `(?:const|let|var)\\s+(?:\\{[^}]*\\b${name}\\b[^}]*\\}|${name})\\s*(?::[^=]+)?=\\s*([^;\\n]+)`,
  ).exec(src);
  if (assignment) {
    if (SERVICE_FACTORY.test(assignment[1])) return 'service';
    if (USER_FACTORY.test(assignment[1])) return 'user';
  }
  return 'unknown';
}

const stripSql = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** Split a CREATE TABLE body on the commas that are not inside parentheses. */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * Is this index key a bare column, as opposed to an expression?
 *
 * Only a bare column can take part in inference. `coalesce(feed_id::text,
 * 'manual')` cannot, however sensible it is as a uniqueness rule — and 0284
 * shipped exactly that, which is how `library_items` came to have a unique
 * index that no upsert could name.
 */
function isPlainIndexKey(key) {
  const bare = key
    .trim()
    .replace(/\s+(asc|desc)$/i, '')
    .replace(/\s+nulls\s+(first|last)$/i, '')
    .replace(/^"|"$/g, '')
    .trim();
  return /^[a-z_][a-z0-9_]*$/i.test(bare);
}

const indexKeyName = (key) => key
  .trim()
  .replace(/\s+(asc|desc)$/i, '')
  .replace(/\s+nulls\s+(first|last)$/i, '')
  .replace(/^"|"$/g, '')
  .trim()
  .toLowerCase();

const sortedKeys = (keys) => keys.map(indexKeyName).sort().join(',');

/**
 * Can `ON CONFLICT (target)` be inferred from one of `indexes`?
 *
 * Exported because the interesting cases are the ones a reader would get wrong:
 * `NULLS NOT DISTINCT` is inferable (it is not a predicate), a partial index is
 * not, and an expression index is not even when its columns look right.
 */
export function conflictTargetVerdict(target, indexes) {
  const want = sortedKeys(String(target).split(','));
  if (indexes.some((index) => !index.partial && !index.expression && sortedKeys(index.keys) === want)) {
    return { ok: true };
  }
  const sameColumns = indexes.filter((index) => sortedKeys(index.keys) === want);
  if (sameColumns.some((index) => index.partial)) {
    return { ok: false, reason: `only a PARTIAL unique index covers those columns (${sameColumns.filter((i) => i.partial).map((i) => i.name).join(', ')}); a partial index is inferable only when the statement repeats its predicate, which PostgREST cannot emit` };
  }
  if (sameColumns.some((index) => index.expression)) {
    return { ok: false, reason: `only an EXPRESSION unique index covers those columns (${sameColumns.filter((i) => i.expression).map((i) => i.name).join(', ')})` };
  }
  const expressionNear = indexes.filter((index) => index.expression);
  if (expressionNear.length > 0) {
    return { ok: false, reason: `no plain unique index on those columns; the nearest is the expression index ${expressionNear.map((i) => `${i.name}(${i.keys.join(', ')})`).join(', ')}` };
  }
  return { ok: false, reason: `no unique index on those columns at all (present: ${indexes.map((i) => `${i.name}(${i.keys.join(', ')})`).join('; ') || 'none'})` };
}

/** Read the whole migration set into a table -> columns map plus RLS facts. */
export function readSchema(directory = MIGRATIONS_DIR) {
  const columns = new Map();
  const views = new Set();
  const withPolicy = new Set();
  const functions = new Set();
  // Keyed by index name so a later `drop index` removes exactly the one it
  // names. Constraint- and column-level uniques get a synthetic key, since
  // Postgres names those itself and nothing ever drops them here.
  const indexes = new Map();
  let synthetic = 0;
  const recordIndex = (name, table, keys, { partial = false } = {}) => {
    const trimmed = keys.map((key) => key.trim()).filter(Boolean);
    if (trimmed.length === 0) return;
    indexes.set(name, {
      name, table: table.toLowerCase(), keys: trimmed, partial,
      expression: !trimmed.every(isPlainIndexKey),
    });
  };

  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = stripSql(readFileSync(join(directory, file), 'utf8'));
    let match;

    const createTable = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi;
    while ((match = createTable.exec(sql))) {
      const table = match[1].toLowerCase();
      let index = createTable.lastIndex;
      let depth = 1;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '(') depth += 1;
        else if (sql[index] === ')') depth -= 1;
        index += 1;
      }
      const cols = columns.get(table) ?? new Set();
      for (const part of splitTopLevel(sql.slice(createTable.lastIndex, index - 1))) {
        const text = part.trim();
        const first = text.split(/\s+/)[0]?.replace(/"/g, '').toLowerCase();
        if (first && !CONSTRAINT_WORDS.has(first) && /^[a-z0-9_]+$/.test(first)) cols.add(first);

        // Table-level UNIQUE / PRIMARY KEY, named or not.
        const tableLevel = /^(?:constraint\s+"?([a-z0-9_]+)"?\s+)?(?:unique|primary\s+key)\s*\(([^)]*)\)/i.exec(text);
        if (tableLevel) {
          synthetic += 1;
          recordIndex(tableLevel[1] ?? `${table}_unique_${synthetic}`, table, tableLevel[2].split(','));
          continue;
        }
        // Column-level `col type ... unique` / `... primary key`.
        if (first && !CONSTRAINT_WORDS.has(first) && /\b(unique|primary\s+key)\b/i.test(text.slice(first.length))) {
          synthetic += 1;
          recordIndex(`${table}_${first}_unique_${synthetic}`, table, [first]);
        }
      }
      columns.set(table, cols);
    }

    const alterTable = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s+([\s\S]*?);/gi;
    while ((match = alterTable.exec(sql))) {
      const table = match[1].toLowerCase();
      const addColumn = /add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/gi;
      let added;
      while ((added = addColumn.exec(match[2]))) {
        const cols = columns.get(table) ?? new Set();
        cols.add(added[1].toLowerCase());
        columns.set(table, cols);
      }
    }

    const createView = /create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi;
    while ((match = createView.exec(sql))) views.add(match[1].toLowerCase());

    // Policy names may be quoted, capitalised, and contain spaces.
    const createPolicy = /create\s+policy\s+(?:if\s+not\s+exists\s+)?(?:"[^"]+"|[a-z0-9_]+)\s+on\s+(?:public\.)?"?([a-z0-9_]+)"?/gi;
    while ((match = createPolicy.exec(sql))) withPolicy.add(match[1].toLowerCase());

    const createFunction = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z0-9_]+)"?/gi;
    while ((match = createFunction.exec(sql))) functions.add(match[1].toLowerCase());

    // CREATE UNIQUE INDEX. The key list is balance-scanned rather than matched,
    // because an expression key contains its own parentheses. Everything from
    // the closing paren to the semicolon decides `partial`: a WHERE clause makes
    // it partial, while NULLS NOT DISTINCT and an INCLUDE list do not.
    const createUnique = /create\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?\s+on\s+(?:"?([a-z0-9_]+)"?\s*\.\s*)?"?([a-z0-9_]+)"?\s*(?:using\s+[a-z0-9_]+\s*)?\(/gi;
    while ((match = createUnique.exec(sql))) {
      const [, name, schemaName, table] = match;
      // storage.buckets and friends are the platform's, not ours.
      if (schemaName && schemaName.toLowerCase() !== 'public') continue;
      let cursor = createUnique.lastIndex;
      let depth = 1;
      while (cursor < sql.length && depth > 0) {
        if (sql[cursor] === '(') depth += 1;
        else if (sql[cursor] === ')') depth -= 1;
        cursor += 1;
      }
      const body = sql.slice(createUnique.lastIndex, cursor - 1);
      const semicolon = sql.indexOf(';', cursor);
      const tail = sql.slice(cursor, semicolon === -1 ? sql.length : semicolon);
      recordIndex(name.toLowerCase(), table, splitTopLevel(body), { partial: /\bwhere\b/i.test(tail) });
    }

    const addUnique = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s+add\s+constraint\s+"?([a-z0-9_]+)"?\s+unique\s*\(([^)]*)\)/gi;
    while ((match = addUnique.exec(sql))) recordIndex(match[2].toLowerCase(), match[1], match[3].split(','));

    const dropIndex = /drop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi;
    while ((match = dropIndex.exec(sql))) indexes.delete(match[1].toLowerCase());

    // A UNIQUE declared as a table constraint is dropped by name as a
    // CONSTRAINT, not as an index. Only the literal form is visible here: 0261
    // drops home_briefs' old `(family_id, as_of_date)` unique through
    // `execute format(...)`, and no static reader can follow that. This is the
    // reason `scripts/check-conflict-targets.mjs` exists and runs against the
    // real catalog in CI — a parser that cannot see a drop believes an index is
    // still there, which is the direction that MISSES a defect.
    const dropConstraint = /alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:public\.)?"?[a-z0-9_]+"?\s+drop\s+constraint\s+(?:if\s+exists\s+)?"?([a-z0-9_]+)"?/gi;
    while ((match = dropConstraint.exec(sql))) indexes.delete(match[1].toLowerCase());
  }

  const uniqueIndexes = new Map();
  for (const index of indexes.values()) {
    const list = uniqueIndexes.get(index.table) ?? [];
    list.push(index);
    uniqueIndexes.set(index.table, list);
  }

  return { columns, views, withPolicy, functions, uniqueIndexes };
}

/** Every API route path that exists under app/api. */
function readApiRoutes() {
  const routes = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/^route\.(ts|tsx|js)$/.test(entry)) {
        routes.push(`/${relative(join(ROOT, 'app'), dir).split(sep).join('/')}`);
      }
    }
  })(join(ROOT, 'app', 'api'));
  return routes;
}

function listSourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (['.ts', '.tsx'].includes(extname(path))) files.push(path);
    }
  };
  for (const dir of CODE_DIRS) walk(join(ROOT, dir));
  return files;
}

/**
 * Walk the PostgREST chain that follows `.from('t')`, consuming
 * `.method(<balanced args>)` links and stopping at the first thing that is not
 * one. A fixed-size text window instead bleeds into the NEXT query of a
 * Promise.all array and invents columns that were never read from `t`.
 */
function readChain(src, start) {
  const links = [];
  let index = start;
  for (;;) {
    while (index < src.length && /\s/.test(src[index])) index += 1;
    if (src[index] !== '.') break;
    let cursor = index + 1;
    while (cursor < src.length && /[a-zA-Z0-9_$]/.test(src[cursor])) cursor += 1;
    const method = src.slice(index + 1, cursor);
    while (cursor < src.length && /\s/.test(src[cursor])) cursor += 1;
    if (src[cursor] !== '(') break;

    let depth = 0;
    let end = cursor;
    let quote = null;
    for (; end < src.length; end += 1) {
      const ch = src[end];
      if (quote) {
        if (ch === '\\') { end += 1; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth += 1;
      else if (ch === ')') { depth -= 1; if (depth === 0) break; }
    }
    if (end >= src.length) break;
    links.push({ method, args: src.slice(cursor + 1, end) });
    index = end + 1;
  }
  return links;
}

/** Top-level column names in a select() string, ignoring embedded relations. */
function selectColumns(selection) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of selection) {
    if (ch === '(') depth += 1;
    if (ch === ')') { depth -= 1; current = ''; continue; }
    if (ch === ',' && depth === 0) { out.push(current); current = ''; continue; }
    if (depth === 0) current += ch;
  }
  if (current) out.push(current);
  return out
    .map((column) => column.trim())
    .filter(Boolean)
    .map((column) => (column.includes(':') ? column.split(':').pop().trim() : column))
    .filter((column) => column !== '*' && /^[a-z0-9_]+$/.test(column));
}

/**
 * Top-level keys of the first object literal in a write payload. Returns []
 * when the payload is a variable — `insert(rows, { count: 'exact' })` must not
 * be read as a payload of `{ count }`.
 */
function payloadKeys(args) {
  const start = args.indexOf('{');
  if (start === -1) return [];
  if (args.slice(0, start).trim() !== '') return [];

  let depth = 0;
  let end = -1;
  let quote = null;
  for (let i = start; i < args.length; i += 1) {
    const ch = args[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return [];

  const parts = [];
  let current = '';
  let inner = 0;
  quote = null;
  const body = args.slice(start + 1, end);
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (ch === '\\') { current += body[i + 1] ?? ''; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if ('{(['.includes(ch)) inner += 1;
    if ('})]'.includes(ch)) inner -= 1;
    if (ch === ',' && inner === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);

  const keys = [];
  for (const part of parts) {
    const text = part.trim();
    if (!text || text.startsWith('...')) continue;
    const named = /^(?:'([a-z0-9_]+)'|([a-zA-Z0-9_$]+))\s*(?::|,|$)/.exec(text);
    if (!named) continue;
    const key = named[1] ?? named[2];
    if (/^[a-z][a-z0-9_]*$/.test(key)) keys.push(key);
  }
  return keys;
}

/**
 * Every `onConflict` target in the app, plus the ones in SEED_ALL.sql.
 *
 * Exported so the static audit and the catalog-backed check in
 * `scripts/check-conflict-targets.mjs` scan for call sites ONE way and differ
 * only in where they get their index facts.
 */
export function collectConflictTargets() {
  const sites = [];

  for (const file of listSourceFiles()) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file).split(sep).join('/');
    const lineAt = (index) => src.slice(0, index).split('\n').length;
    // The closing paren belongs in the match: readChain starts where this ends,
    // and it stops at the first character that is not `.`. Leaving the `)`
    // behind made this find nothing at all, silently — which reads exactly like
    // a clean bill of health.
    const fromCall = /\.from\(\s*'([a-z0-9_]+)'\s*\)/g;
    let match;
    while ((match = fromCall.exec(src))) {
      const table = match[1].toLowerCase();
      for (const { method, args } of readChain(src, match.index + match[0].length)) {
        if (method !== 'upsert') continue;
        const target = /onConflict:\s*['"`]([^'"`]+)['"`]/.exec(args);
        if (target) sites.push({ file: rel, line: lineAt(match.index), table, target: target[1] });
      }
    }
  }

  // SEED_ALL runs against the FINAL schema and its errors are swallowed by
  // pg-bootstrap.sh on purpose, so a broken conflict target there is silent.
  // The migrations' own DML is deliberately NOT scanned: CI replays every
  // migration in order and a bad ON CONFLICT aborts the replay, which is a
  // stronger proof than this one. SQL inside function bodies has neither.
  const seedPath = join(ROOT, 'supabase', 'SEED_ALL.sql');
  const seed = stripSql(readFileSync(seedPath, 'utf8'));
  const inserts = [...seed.matchAll(/\binsert\s+into\s+(?:(?:public)\.)?"?([a-z0-9_]+)"?(?!\s*\.)/gi)]
    .map((m) => ({ at: m.index, table: m[1].toLowerCase() }));
  for (const match of seed.matchAll(/\bon\s+conflict\s*\(([^)]*)\)/gi)) {
    const keys = match[1].split(',').map((key) => key.trim());
    if (keys.some((key) => /[()]/.test(key))) continue;
    const owner = inserts.filter((insert) => insert.at < match.index).pop();
    if (!owner) continue;
    sites.push({
      file: 'supabase/SEED_ALL.sql',
      line: seed.slice(0, match.index).split('\n').length,
      table: owner.table,
      target: keys.join(','),
    });
  }

  return sites;
}

export function auditSupabaseQueries() {
  const schema = readSchema();
  const routes = readApiRoutes();
  const findings = [];
  const readers = new Map();

  const routeMatchers = routes.map((route) => ({
    route,
    segments: route.split('/').filter(Boolean).map((segment) => (/^\[.*\]$/.test(segment) ? null : segment)),
    catchAll: route.split('/').filter(Boolean).some((segment) => /^\[\.\.\..*\]$/.test(segment)),
  }));

  const routeExists = (path) => {
    const segments = path.split('/').filter(Boolean);
    return routeMatchers.some((matcher) => {
      if (matcher.catchAll) {
        const fixed = matcher.segments.slice(0, matcher.segments.indexOf(null));
        return fixed.every((segment, i) => segments[i] === segment);
      }
      return matcher.segments.length === segments.length
        && matcher.segments.every((segment, i) => segment === null || segment === segments[i]);
    });
  };

  for (const file of listSourceFiles()) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file).split(sep).join('/');
    const lineAt = (index) => src.slice(0, index).split('\n').length;

    const fromCall = /\.from\(\s*'([a-z0-9_]+)'\s*\)/g;
    let match;
    while ((match = fromCall.exec(src))) {
      const table = match[1];
      const line = lineAt(match.index);
      if (schema.views.has(table)) continue;

      const client = classifyReceiver(src, match.index);
      if (!readers.has(table)) readers.set(table, []);
      readers.get(table).push({ file: rel, line, client });

      if (!schema.columns.has(table)) {
        findings.push({ kind: 'missing-table', file: rel, line, detail: table });
        continue;
      }
      const cols = schema.columns.get(table);

      for (const { method, args } of readChain(src, match.index + match[0].length)) {
        if (method === 'select') {
          const trimmed = args.trim();
          if (trimmed[0] !== "'" && trimmed[0] !== '`') continue;
          const open = args.indexOf(trimmed[0]);
          const close = args.indexOf(trimmed[0], open + 1);
          if (close === -1) continue;
          const selection = args.slice(open + 1, close);
          if (selection.includes('${')) continue;
          for (const column of selectColumns(selection)) {
            if (!cols.has(column)) {
              findings.push({ kind: 'missing-column', file: rel, line, detail: `${table}.${column}`, via: 'select' });
            }
          }
          continue;
        }
        if (WRITES.includes(method)) {
          for (const key of payloadKeys(args)) {
            if (!cols.has(key)) {
              findings.push({ kind: 'missing-column', file: rel, line, detail: `${table}.${key}`, via: method });
            }
          }
          continue;
        }
        if (!FILTERS.includes(method)) continue;
        const column = /^\s*'([a-z0-9_]+)'/.exec(args);
        if (column && !cols.has(column[1])) {
          findings.push({ kind: 'missing-column', file: rel, line, detail: `${table}.${column[1]}`, via: method });
        }
      }
    }

    const rpcCall = /\.rpc\(\s*'([a-z0-9_]+)'/g;
    while ((match = rpcCall.exec(src))) {
      if (!schema.functions.has(match[1])) {
        findings.push({ kind: 'missing-function', file: rel, line: lineAt(match.index), detail: match[1] });
      }
    }

    const fetchCall = /fetch\(\s*(['`])(\/api\/[^'`]*)\1/g;
    while ((match = fetchCall.exec(src))) {
      const path = match[2].split('?')[0].split('#')[0];
      const interpolation = path.indexOf('${');
      const reachable = interpolation === -1
        ? routeExists(path.replace(/\/$/, ''))
        : routeMatchers.some((matcher) => matcher.route.startsWith(path.slice(0, interpolation).replace(/\/$/, '')));
      if (!reachable) {
        findings.push({ kind: 'missing-route', file: rel, line: lineAt(match.index), detail: path });
      }
    }
  }

  for (const site of collectConflictTargets()) {
    if (!schema.columns.has(site.table)) continue;   // already reported as missing-table
    const verdict = conflictTargetVerdict(site.target, schema.uniqueIndexes.get(site.table) ?? []);
    if (!verdict.ok) {
      findings.push({
        kind: 'uninferable-conflict-target',
        file: site.file, line: site.line,
        detail: `${site.table} ON CONFLICT (${site.target}) — ${verdict.reason}`,
      });
    }
  }

  // Deny-all tables: RLS is on for every table (0118 enables it across the
  // schema), the generic family sweep skips anything without `family_id`, and a
  // table with no policy at all answers the user client with zero rows.
  for (const [table, cols] of schema.columns) {
    if (cols.has('family_id')) continue;
    if (schema.withPolicy.has(table)) continue;
    const seen = readers.get(table);
    if (!seen) continue;
    const userReaders = seen.filter((reader) => reader.client === 'user');
    if (userReaders.length === 0) continue;
    for (const reader of userReaders) {
      findings.push({ kind: 'deny-all-table', file: reader.file, line: reader.line, detail: table });
    }
  }

  return { findings, schema, routes };
}

const LABELS = {
  'missing-table': 'table does not exist',
  'missing-column': 'column does not exist',
  'missing-function': 'rpc function does not exist',
  'missing-route': 'no API route handles this fetch',
  'deny-all-table': 'RLS enabled with no policy — user-client reads return zero rows',
  'uninferable-conflict-target': 'ON CONFLICT target no unique index can satisfy — fails with 42P10 at planning time',
};

function runCli() {
  const { findings, schema, routes } = auditSupabaseQueries();
  console.log(
    `Supabase query audit: ${schema.columns.size} tables, ${schema.functions.size} functions, ${routes.length} API routes.`,
  );

  if (findings.length === 0) {
    console.log('Supabase query audit passed: every table, column, function and route resolves.');
    return;
  }

  const grouped = new Map();
  for (const finding of findings) {
    const key = `${finding.kind} ${finding.detail}`;
    if (!grouped.has(key)) grouped.set(key, { ...finding, sites: [] });
    grouped.get(key).sites.push(
      `${finding.file}${finding.line ? `:${finding.line}` : ''}${finding.via ? ` (${finding.via})` : ''}`,
    );
  }

  console.error(`\nSupabase query audit failed: ${grouped.size} problem(s).`);
  for (const entry of grouped.values()) {
    console.error(`\n  ${entry.detail} — ${LABELS[entry.kind]}`);
    for (const site of entry.sites.slice(0, 6)) console.error(`      ${site}`);
    if (entry.sites.length > 6) console.error(`      …and ${entry.sites.length - 6} more`);
  }
  console.error('\nFix the query, or add the migration that creates what it reads.');
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
