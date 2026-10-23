// An in-memory stand-in for the Supabase client, faithful enough to drive the
// whole AI loop (intake → planner → store → executor → tools → services →
// detail read) without a database.
//
// WHY THIS EXISTS: the per-module tests each hand their module a recording fake
// that replies from a fixed script, which is right for pinning one module's
// contract but cannot prove that the modules agree with each other — that the
// run the planner creates is the run the executor claims, that the step rows
// the store writes are the rows the executor reads, that a tool's ledger row
// and the service's household row both land under the same family. This fake
// keeps real tables, applies real filters and returns what was written, so a
// test can run the loop end to end and then read the tables back the way the
// run page does.
//
// It implements the PostgREST builder surface the repository's server code
// uses: from/select/insert/update/upsert/delete, the filter vocabulary
// (eq, neq, in, is, not, or, gt/gte/lt/lte, ilike/like, contains), order,
// limit, range, single, maybeSingle, thenable execution, and rpc through a
// handler map. Every result is `{ data, error, count }` — nothing throws, the
// way the real client behaves.
import { randomUUID } from 'node:crypto';

export type Row = Record<string, unknown>;

type PostgrestError = { code: string; message: string; details: string | null; hint: string | null };
type Reply = { data: unknown; error: PostgrestError | null; count: number | null; status: number; statusText: string };

type Op = 'select' | 'insert' | 'update' | 'upsert' | 'delete';
type Predicate = (row: Row) => boolean;

export type InMemoryOptions = {
  /**
   * Per-table unique column sets; a violating insert answers 23505 like
   * Postgres. A key may be a JSON path (`metadata->>occurrence`), read as the
   * expression index over it would be; a row with a NULL anywhere in the key
   * is not part of it, as in Postgres.
   */
  uniques?: Record<string, string[][]>;
  /**
   * Per-table columns the schema types `uuid`. Postgres casts every value bound
   * to such a column — a written row's and a filter's alike — and refuses one
   * that is not a uuid with 22P02 (`invalid input syntax for type uuid`) before
   * any row is touched. Without this, the fake stored whatever text it was
   * handed: a `<rule id>:<day>` key written to wallet_transactions.related_id
   * (uuid, 0088) read as a landed credit here and was refused in production,
   * every night, while the schedule had already moved on. Declare the typed
   * columns and the difference is visible. A seed row that breaks a declared
   * type throws, since a fixture the real table could not hold proves nothing.
   */
  uuidColumns?: Record<string, string[]>;
  /** Per-table column defaults applied on insert when the row leaves the column unset (what the migrations' `default` clauses do). */
  defaults?: Record<string, Row>;
  /** RPC handlers by function name. Unknown functions answer an error. */
  rpc?: Record<string, (args: Record<string, unknown>, db: InMemorySupabase) => unknown | Promise<unknown>>;
  /** Auth user id for `auth.getUser()`. */
  userId?: string | null;
  /**
   * PostgREST's `db-max-rows` — the server's own ceiling on ONE response,
   * 1,000 on a default Supabase project.
   *
   * The real server applies it silently: no error, no short-read signal, just
   * fewer rows than the table holds. Without it here, a fake answers every
   * unbounded select with the whole table and a job that reads the first
   * 1,000 households looks identical to one that reads them all. Set it and
   * the difference becomes visible. Unset means no cap, which is what every
   * existing test assumes.
   */
  maxRows?: number;
  /**
   * How `like`/`ilike` read their pattern. Unset keeps this fake's historical
   * reading: `%` and `_` are wildcards and every other character, a backslash
   * included, is literal. `'postgrest'` reads it as the real transport does:
   * PostgREST first turns EVERY `*` into `%` (its alias, escaped or not), then
   * PostgreSQL's LIKE applies, where `\` makes the next character literal — so
   * `escapeLike('50%')` matches "50%", and an escaped star matches a literal
   * percent sign, not a star (lib/supabase/escape-like.ts).
   */
  likeSyntax?: 'postgrest';
};

/**
 * Functions the real schema carries, served from the backing tables so a test
 * does not have to know they exist.
 *
 * `family_allergies` (0438) is the narrow door onto `medical_profiles`: after
 * that migration the table reads manager-or-self, and the meal planner and
 * grocery substituter — which need the WHOLE household's allergies, on the
 * caller's own client — go through this instead. Modelling it here rather than
 * in each test keeps the fake honest about the schema: a select on
 * `medical_profiles` and a call to this used to be interchangeable, and since
 * 0438 they are not.
 *
 * An explicit `rpc` option still wins, which is how a test says "this call
 * fails" or supplies rows the backing table does not hold.
 */
const BUILT_IN_RPC: Record<string, (args: Record<string, unknown>, db: InMemorySupabase) => unknown> = {
  family_allergies: (args, db) => db.table('medical_profiles')
    .filter((row) => row.family_id === args.p_family_id)
    .map((row) => ({ member_id: row.member_id, allergies: row.allergies ?? null })),
};

function pgError(code: string, message: string): PostgrestError {
  return { code, message, details: null, hint: null };
}

/** PostgreSQL's uuid input: 32 hex digits, hyphenated in the canonical groups or not, braces allowed. */
const UUID_INPUT = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i;

/** 22P02, the answer to a value a uuid column cannot hold (null is not such a value). */
function uuidRefusal(column: string, value: unknown): PostgrestError | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && UUID_INPUT.test(value)) return null;
  return pgError('22P02', `invalid input syntax for type uuid: "${typeof value === 'object' ? JSON.stringify(value) : String(value)}"`);
}

/**
 * A row's value at a plain column or a JSON path (`metadata->>occurrence`,
 * `payload->nested->>source`), as an expression index over it would read it:
 * `->>` yields text, a missing member is NULL.
 */
function columnValue(row: Row, column: string): unknown {
  if (!column.includes('->')) return row[column];
  const [root, ...steps] = column.split(/->>?/);
  let value: unknown = row[root];
  for (const step of steps) value = value && typeof value === 'object' && !Array.isArray(value) ? (value as Row)[step] : null;
  if (value === undefined || value === null) return null;
  return column.includes('->>') && typeof value === 'object' ? JSON.stringify(value) : value;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date || b instanceof Date) return new Date(a as string).getTime() - new Date(b as string).getTime();
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** A loose equality: PostgREST compares the column's text form with the filter's. */
function looseEq(value: unknown, wanted: unknown): boolean {
  if (value === wanted) return true;
  if (value === null || value === undefined || wanted === null || wanted === undefined) return false;
  return String(value) === String(wanted);
}

function parseFilterValue(raw: string): unknown {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

/** PostgreSQL jsonb @> contains nested objects, not object reference identities. */
function jsonContains(value: unknown, wanted: unknown): boolean {
  if (Array.isArray(value)) {
    return (Array.isArray(wanted) ? wanted : [wanted]).every((needle) => value.some((item) => jsonContains(item, needle)));
  }
  if (value && typeof value === 'object' && wanted && typeof wanted === 'object') {
    return Object.entries(wanted).every(([key, item]) => jsonContains((value as Row)[key], item));
  }
  return looseEq(value, wanted);
}

/** PostgREST's `*` alias, then PostgreSQL LIKE with `\` as its escape (InMemoryOptions.likeSyntax). */
function postgrestLike(column: string, pattern: string, flags: string): Predicate {
  const aliased = pattern.replace(/\*/g, '%');
  let source = '';
  for (let i = 0; i < aliased.length; i++) {
    const char = aliased[i];
    if (char === '\\' && i + 1 < aliased.length) source += aliased[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (char === '%') source += '[\\s\\S]*';
    else if (char === '_') source += '[\\s\\S]';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const re = new RegExp(`^${source}$`, flags);
  return (row) => typeof row[column] === 'string' && re.test(row[column] as string);
}

/** The members of an `in` filter: an array, or PostgREST's list text `(a,b,"c")`. */
function inListMembers(wanted: unknown): unknown[] {
  return Array.isArray(wanted)
    ? wanted
    : String(wanted).replace(/^\(/, '').replace(/\)$/, '').split(',').map((v) => parseFilterValue(v.trim().replace(/^"|"$/g, '')));
}

function operatorPredicate(column: string, op: string, wanted: unknown): Predicate {
  if (column.includes('->')) {
    const path = /^([a-zA-Z_]\w*)((?:->>?[a-zA-Z_]\w*)+)$/.exec(column);
    if (!path) throw new Error('[in-memory-supabase] unsupported JSON path');
    const steps = [...path[2].matchAll(/(->>?)([a-zA-Z_]\w*)/g)];
    if (steps.some((step, index) => step[1] === '->>' && index !== steps.length - 1)) throw new Error('[in-memory-supabase] unsupported JSON path');
    const predicate = operatorPredicate('__json_value', op, wanted);
    return row => {
      let value: unknown = row[path[1]];
      for (const step of steps) value = value && typeof value === 'object' && !Array.isArray(value) ? (value as Row)[step[2]] : null;
      return predicate({ __json_value: value == null ? null : steps.at(-1)?.[1] !== '->>' ? value
        : typeof value === 'object' ? JSON.stringify(value) : String(value) });
    };
  }
  switch (op) {
    case 'eq': return (row) => {
      const value = row[column];
      if (value && typeof value === 'object' && typeof wanted === 'string') {
        try { return equalJson(value, JSON.parse(wanted)); } catch { return false; }
      }
      return looseEq(value, wanted);
    };
    case 'neq': return (row) => !looseEq(row[column], wanted);
    case 'is': return (row) => (row[column] ?? null) === wanted;
    case 'gt': return (row) => row[column] != null && compare(row[column], wanted) > 0;
    case 'gte': return (row) => row[column] != null && compare(row[column], wanted) >= 0;
    case 'lt': return (row) => row[column] != null && compare(row[column], wanted) < 0;
    case 'lte': return (row) => row[column] != null && compare(row[column], wanted) <= 0;
    case 'in': {
      const values = inListMembers(wanted);
      return (row) => values.some((v) => looseEq(row[column], v));
    }
    case 'imatch': {
      // Only an escaped literal: anchored at both ends (CRM email lookups:
      // equal) or at neither (searches: contains). Unsupported ARE syntax must
      // fail rather than silently model a regex.
      if (typeof wanted !== 'string') throw new Error('[in-memory-supabase] unsupported imatch pattern');
      const anchored = wanted.startsWith('^') && wanted.endsWith('$') && !/(^|[^\\])(\\\\)*\\\$$/.test(wanted);
      const body = anchored ? wanted.slice(1, -1) : wanted;
      const specials = '.*+?^$' + '{}()|[]' + String.fromCharCode(92);
      let literal = '';
      for (let index = 0; index < body.length; index++) {
        const char = body[index];
        if (char === String.fromCharCode(92)) {
          const escaped = body[++index];
          if (escaped === undefined || !specials.includes(escaped)) {
            throw new Error('[in-memory-supabase] unsupported imatch pattern');
          }
          literal += escaped;
        } else {
          if (specials.includes(char)) throw new Error('[in-memory-supabase] unsupported imatch pattern');
          literal += char;
        }
      }
      return (row) => typeof row[column] === 'string' && (anchored
        ? (row[column] as string).toLowerCase() === literal.toLowerCase()
        : (row[column] as string).toLowerCase().includes(literal.toLowerCase()));
    }
    case 'like':
    case 'ilike': {
      const source = String(wanted).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
      const re = new RegExp(`^${source}$`, op === 'ilike' ? 'i' : '');
      return (row) => typeof row[column] === 'string' && re.test(row[column] as string);
    }
    case 'cs':
    case 'contains': {
      return (row) => {
        const value = row[column];
        if (Array.isArray(value)) {
          const needles = Array.isArray(wanted) ? wanted : [wanted];
          return needles.every((n) => value.some((v) => looseEq(v, n)));
        }
        if (value && typeof value === 'object' && wanted && typeof wanted === 'object') {
          return jsonContains(value, wanted);
        }
        return false;
      };
    }
    case 'ov':
    case 'overlaps': {
      return (row) => {
        const value = row[column];
        const needles = Array.isArray(wanted) ? wanted : [wanted];
        return Array.isArray(value) && needles.some((n) => value.some((v) => looseEq(v, n)));
      };
    }
    default:
      throw new Error(`[in-memory-supabase] unsupported filter operator "${op}"`);
  }
}

/** jsonb equality ignores object-key order but preserves array order and scalar types. */
function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => equalJson(value, right[index]));
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key)
    && equalJson((left as Row)[key], (right as Row)[key]));
}

/** `a.eq.1,b.is.null,c.in.(x,y)`, plus the nested `and(...)` groups used to
 *  filter typed calendar windows. A nested `or(...)` stays unsupported and
 *  throws — PostgREST's `.or()` already IS the or, and in-memory-supabase-logic
 *  pins that. */
function parseOr(expression: string, mode: 'or' | 'and' = 'or'): Predicate {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of expression) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth < 0) throw new Error('[in-memory-supabase] unbalanced or() group');
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (depth !== 0) throw new Error('[in-memory-supabase] unbalanced or() group');
  if (current) parts.push(current);
  if (!current.trim() || parts.some(part => !part.trim())) throw new Error('[in-memory-supabase] empty or() clause');
  const predicates = parts.map((part) => {
    const trimmed = part.trim();
    if (trimmed.startsWith('and(') && trimmed.endsWith(')')) return parseOr(trimmed.slice(4, -1), 'and');
    const negated = trimmed.startsWith('not.');
    const body = negated ? trimmed.slice(4) : trimmed;
    if (body.startsWith('and(') && body.endsWith(')')) {
      const predicate = parseOr(body.slice(4, -1), 'and');
      return negated ? (row: Row) => !predicate(row) : predicate;
    }
    if (body.startsWith('or(')) throw new Error('[in-memory-supabase] nested or() is unsupported');
    const first = body.indexOf('.');
    const second = body.indexOf('.', first + 1);
    if (first < 0 || second < 0) throw new Error(`[in-memory-supabase] cannot parse or() clause "${part}"`);
    const column = body.slice(0, first);
    // `col.not.op.value`, PostgREST's own negation of one filter. Like SQL's
    // NOT, it is NULL, so not true, on a NULL column (except `not.is`): an OR
    // that keeps NULL rows says so with its own `col.is.null` branch.
    if (body.slice(first + 1, second) === 'not') {
      const inner = parseOr(`${column}.${body.slice(second + 1)}`);
      const isTest = body.slice(second + 1).startsWith('is.');
      const keep = (row: Row) => !inner(row) && (isTest || (row[column] ?? null) !== null);
      return negated ? (row: Row) => !keep(row) : keep;
    }
    const op = body.slice(first + 1, second);
    const raw = body.slice(second + 1);
    // An array operator's value is a PostgreSQL array literal (`tags.cs.{beach}`),
    // which PostgREST hands to the database as an array; read it as one, or
    // `cs` would compare the whole `{beach}` string against each element.
    const arrayLiteral = (op === 'cs' || op === 'ov') && /^\{.*\}$/.test(raw);
    const wanted = op === 'in' ? raw
      : arrayLiteral ? raw.slice(1, -1).split(',').map((v) => v.trim().replace(/^"|"$/g, '')).filter((v) => v !== '')
        : parseFilterValue(raw);
    const predicate = operatorPredicate(column, op, wanted);
    return negated ? (row: Row) => !predicate(row) : predicate;
  });
  return (row) => mode === 'and' ? predicates.every((p) => p(row)) : predicates.some((p) => p(row));
}

/** Reuse the PostgREST filter parser in fixtures that implement their other filters. */
export function orPredicate(expression: string): (row: Row) => boolean {
  return parseOr(expression);
}

/** Split a select list on top-level commas; `a, b:c, d(e,f)` → three parts. */
function splitSelect(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * The row's column an embed joins through. A PostgREST hint naming a column on
 * the row (`families!family_id!inner(...)`, the form a table with two foreign
 * keys into one table needs) is that column; otherwise `<alias>_id`, then
 * `<table singular>_id` (both the `-s` and the `-ies` plural: `families` →
 * `family_id`), then `<table>_id`.
 */
function embedForeignKey(row: Row, alias: string, table: string, hints: string): string | undefined {
  const hinted = hints.split('!').filter((h) => h && h !== 'inner' && h !== 'left').find((h) => h in row);
  return hinted ?? [`${alias}_id`, `${table.replace(/s$/, '')}_id`, `${table.replace(/ies$/, 'y')}_id`, `${table}_id`].find((c) => c in row);
}

/**
 * Project a row onto a select list. Embedded resources (`member:family_members(display_name)`)
 * resolve through a foreign key named `<alias>_id` or `<table singular>_id` when
 * one exists on the row, and are null otherwise — enough for the display joins
 * the services make.
 */
function project(db: InMemorySupabase, row: Row, select: string): Row {
  const parts = splitSelect(select.replace(/\s+/g, ' '));
  if (parts.length === 1 && parts[0] === '*') return { ...row };
  const out: Row = {};
  for (const part of parts) {
    if (part === '*') { Object.assign(out, row); continue; }
    const embed = /^(?:([\w]+):)?([\w]+)((?:!\w+)*)\((.*)\)$/.exec(part);
    if (embed) {
      const alias = embed[1] ?? embed[2];
      const table = embed[2];
      const inner = embed[4] || '*';
      const fk = embedForeignKey(row, alias, table, embed[3]);
      const target = fk ? db.table(table).find((r) => looseEq(r.id, row[fk])) : undefined;
      out[alias] = target ? project(db, target, inner) : null;
      continue;
    }
    const aliased = /^([\w]+):([\w]+)(?:::\w+)?$/.exec(part);
    if (aliased) { out[aliased[1]] = row[aliased[2]] ?? null; continue; }
    const plain = part.replace(/::\w+$/, '');
    out[plain] = row[plain] ?? null;
  }
  return out;
}

/** Operators whose value Postgres casts to the column's type (not the pattern and array operators). */
const TYPED_OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in']);

/**
 * The values a filter binds to its column. An `in` given as PostgREST's list
 * text (`.not(col, 'in', '(a,b)')`, `.filter(col, 'in', '(a,b)')`) binds each
 * member, as the server does: the whole `(a,b)` is not one uuid, but a list of
 * valid ones is a valid filter.
 */
function typedMembers(op: string, value: unknown): unknown[] {
  if (op === 'in') return inListMembers(value);
  return Array.isArray(value) ? value : [value];
}

class QueryBuilder implements PromiseLike<Reply> {
  private op: Op = 'select';
  private payload: Row[] = [];
  private upsertOn: string[] | null = null;
  private ignoreDuplicates = false;
  private readonly predicates: Predicate[] = [];
  private selectList: string | null = null;
  private countMode: 'exact' | 'planned' | 'estimated' | null = null;
  private headOnly = false;
  private orderings: { column: string; ascending: boolean; nullsFirst: boolean | null }[] = [];
  private limitCount: number | null = null;
  private rangeBounds: { from: number; to: number } | null = null;
  private mode: 'many' | 'single' | 'maybeSingle' = 'many';
  /** The first filter value a typed column refused; answered when the query runs, as Postgres does. */
  private refused: PostgrestError | null = null;

  constructor(private readonly db: InMemorySupabase, private readonly tableName: string) {}

  /** Bind a filter value to its column's declared type (InMemoryOptions.uuidColumns). */
  private typed(column: string, values: unknown[]): void {
    if (this.refused || !this.db.isUuidColumn(this.tableName, column)) return;
    for (const value of values) {
      const refusal = uuidRefusal(column, value);
      if (refusal) { this.refused = refusal; return; }
    }
  }

  select(list = '*', opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }) {
    this.selectList = list;
    if (opts?.count) this.countMode = opts.count;
    if (opts?.head) this.headOnly = true;
    return this;
  }
  insert(rows: Row | Row[]) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = 'upsert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.upsertOn = opts?.onConflict ? opts.onConflict.split(',').map((c) => c.trim()) : ['id'];
    this.ignoreDuplicates = opts?.ignoreDuplicates === true;
    return this;
  }
  update(patch: Row, opts?: { count?: 'exact' | 'planned' | 'estimated' }) {
    this.op = 'update'; this.payload = [patch];
    if (opts?.count) this.countMode = opts.count;
    return this;
  }
  delete() { this.op = 'delete'; return this; }

  /**
   * A filter on an EMBEDDED resource's column (`family.closed_at`), named by the
   * embed's alias in the select list, as PostgREST names it. An `!inner` embed
   * also drops the parent row when the embedded row does not match; a plain
   * embed only filters the embedded value, which this fake does not model, so
   * it is left unfiltered. Null when the column is not an embed's.
   */
  private embedPredicate(column: string, op: string, value: unknown): Predicate | null {
    const dot = /^([\w]+)\.([\w]+)$/.exec(column);
    if (!dot || !this.selectList) return null;
    const part = splitSelect(this.selectList.replace(/\s+/g, ' '))
      .map((p) => /^(?:([\w]+):)?([\w]+)((?:!\w+)*)\((.*)\)$/.exec(p))
      .find((m) => m && (m[1] ?? m[2]) === dot[1]);
    if (!part) return null;
    if (!part[3].split('!').includes('inner')) return () => true;
    const alias = part[1] ?? part[2];
    const table = part[2];
    const hints = part[3];
    const inner = operatorPredicate(dot[2], op, value);
    return (row) => {
      const fk = embedForeignKey(row, alias, table, hints);
      const target = fk ? this.db.table(table).find((r) => looseEq(r.id, row[fk])) : undefined;
      return target !== undefined && inner(target);
    };
  }
  eq(column: string, value: unknown) { this.typed(column, [value]); const op = value === null ? 'is' : 'eq'; this.predicates.push(this.embedPredicate(column, op, value) ?? operatorPredicate(column, op, value)); return this; }
  neq(column: string, value: unknown) { this.typed(column, [value]); this.predicates.push(operatorPredicate(column, 'neq', value)); return this; }
  gt(column: string, value: unknown) { this.typed(column, [value]); this.predicates.push(operatorPredicate(column, 'gt', value)); return this; }
  gte(column: string, value: unknown) { this.typed(column, [value]); this.predicates.push(operatorPredicate(column, 'gte', value)); return this; }
  lt(column: string, value: unknown) { this.typed(column, [value]); this.predicates.push(operatorPredicate(column, 'lt', value)); return this; }
  lte(column: string, value: unknown) { this.typed(column, [value]); this.predicates.push(operatorPredicate(column, 'lte', value)); return this; }
  in(column: string, values: unknown[]) { this.typed(column, values); this.predicates.push(operatorPredicate(column, 'in', values)); return this; }
  is(column: string, value: unknown) { this.predicates.push(this.embedPredicate(column, 'is', value) ?? operatorPredicate(column, 'is', value)); return this; }
  like(column: string, pattern: string) { this.predicates.push(operatorPredicate(column, 'like', pattern)); return this; }
  ilike(column: string, pattern: string) {
    this.predicates.push(this.db.likeSyntax === 'postgrest' ? postgrestLike(column, pattern, 'i') : operatorPredicate(column, 'ilike', pattern));
    return this;
  }
  contains(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'contains', value)); return this; }
  overlaps(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'overlaps', value)); return this; }
  not(column: string, op: string, value: unknown) {
    if (TYPED_OPERATORS.has(op)) this.typed(column, typedMembers(op, value));
    const predicate = operatorPredicate(column, op, value);
    this.predicates.push((row) => !predicate(row));
    return this;
  }
  // `or()` is left unbound: its values are parsed from one expression and only
  // the direct filter methods are typed here.
  or(expression: string) { this.predicates.push(parseOr(expression)); return this; }
  filter(column: string, op: string, value: unknown) {
    if (TYPED_OPERATORS.has(op)) this.typed(column, typedMembers(op, value));
    this.predicates.push(operatorPredicate(column, op, value));
    return this;
  }
  match(query: Row) { for (const [k, v] of Object.entries(query)) this.eq(k, v); return this; }

  order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orderings.push({ column, ascending: opts?.ascending ?? true, nullsFirst: opts?.nullsFirst ?? null });
    return this;
  }
  limit(count: number) { this.limitCount = count; return this; }
  range(from: number, to: number) { this.rangeBounds = { from, to }; return this; }
  abortSignal() { return this; }
  // Execution is synchronous and never retried. Do not imply retry support.
  retry(enabled: boolean) { if (enabled) throw new Error('[in-memory-supabase] retries are unsupported'); return this; }
  throwOnError() { return this; }

  single(): Promise<Reply> { this.mode = 'single'; return Promise.resolve(this.execute()); }
  maybeSingle(): Promise<Reply> { this.mode = 'maybeSingle'; return Promise.resolve(this.execute()); }

  then<R1 = Reply, R2 = never>(
    onFulfilled?: ((value: Reply) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }

  private matching(): Row[] {
    return this.db.table(this.tableName).filter((row) => this.predicates.every((p) => p(row)));
  }

  private shape(rows: Row[]): Reply {
    let out = rows;
    if (this.orderings.length) {
      out = [...out].sort((a, b) => {
        for (const o of this.orderings) {
          const av = a[o.column] ?? null;
          const bv = b[o.column] ?? null;
          if (av === null && bv === null) continue;
          if (av === null) return (o.nullsFirst ?? !o.ascending) ? -1 : 1;
          if (bv === null) return (o.nullsFirst ?? !o.ascending) ? 1 : -1;
          const c = compare(av, bv);
          if (c !== 0) return o.ascending ? c : -c;
        }
        return 0;
      });
    }
    const total = out.length;
    if (this.rangeBounds) out = out.slice(this.rangeBounds.from, this.rangeBounds.to + 1);
    if (this.limitCount !== null) out = out.slice(0, this.limitCount);
    // Applied LAST and to every read alike: `db-max-rows` caps the response the
    // server is about to send, so it truncates a `.limit(5000)` exactly as
    // readily as an unbounded select. That is why `.limit()` is not a bound.
    const cap = this.db.maxRows;
    if (this.op === 'select' && cap !== undefined && out.length > cap) out = out.slice(0, cap);
    const projected = this.selectList ? out.map((row) => project(this.db, row, this.selectList as string)) : out.map((row) => ({ ...row }));
    const count = this.countMode ? total : null;
    if (this.headOnly) return { data: null, error: null, count, status: 200, statusText: 'OK' };
    if (this.mode === 'single') {
      if (projected.length !== 1) {
        return { data: null, error: pgError('PGRST116', `JSON object requested, multiple (or no) rows returned: ${projected.length}`), count, status: 406, statusText: 'Not Acceptable' };
      }
      return { data: projected[0], error: null, count, status: 200, statusText: 'OK' };
    }
    if (this.mode === 'maybeSingle') {
      if (projected.length > 1) {
        return { data: null, error: pgError('PGRST116', `JSON object requested, multiple (or no) rows returned: ${projected.length}`), count, status: 406, statusText: 'Not Acceptable' };
      }
      return { data: projected[0] ?? null, error: null, count, status: 200, statusText: 'OK' };
    }
    return { data: projected, error: null, count, status: 200, statusText: 'OK' };
  }

  private written(rows: Row[]): Reply {
    // Without an explicit `.select()`, PostgREST returns no representation.
    if (!this.selectList) return { data: null, error: null, count: null, status: 201, statusText: 'Created' };
    return this.shape(rows);
  }

  private uniqueViolation(row: Row, existing: Row[]): PostgrestError | null {
    for (const columns of this.db.uniquesFor(this.tableName)) {
      if (columns.some((c) => columnValue(row, c) === null || columnValue(row, c) === undefined)) continue;
      const clash = existing.find((other) => other !== row && columns.every((c) => looseEq(columnValue(other, c), columnValue(row, c))));
      if (clash) return pgError('23505', `duplicate key value violates unique constraint "${this.tableName}_${columns.map((c) => c.replace(/\W+/g, '_')).join('_')}_key"`);
    }
    return null;
  }

  /** The first value of a written row that its column's declared type refuses. */
  private typeViolation(rows: Row[]): PostgrestError | null {
    for (const row of rows) {
      for (const column of this.db.uuidColumnsFor(this.tableName)) {
        const refusal = uuidRefusal(column, row[column]);
        if (refusal) return refusal;
      }
    }
    return null;
  }

  private execute(): Reply {
    const table = this.db.table(this.tableName);
    // Postgres binds the statement's values before it runs it: one that its
    // column cannot hold fails the whole statement, and nothing is read or
    // written. A multi-row insert with one bad row writes no row.
    const refused = this.refused
      ?? (this.op === 'insert' || this.op === 'upsert' || this.op === 'update' ? this.typeViolation(this.payload) : null);
    if (refused) return { data: null, error: refused, count: null, status: 400, statusText: 'Bad Request' };
    switch (this.op) {
      case 'select':
        return this.shape(this.matching());
      case 'insert': {
        const inserted: Row[] = [];
        for (const raw of this.payload) {
          const row = this.db.withDefaults(this.tableName, raw);
          const violation = this.uniqueViolation(row, table);
          if (violation) return { data: null, error: violation, count: null, status: 409, statusText: 'Conflict' };
          table.push(row);
          inserted.push(row);
        }
        return this.written(inserted);
      }
      case 'upsert': {
        const touched: Row[] = [];
        for (const raw of this.payload) {
          const keys = this.upsertOn ?? ['id'];
          const existing = keys.every((k) => raw[k] !== undefined)
            ? table.find((other) => keys.every((k) => looseEq(other[k], raw[k])))
            : undefined;
          if (existing) {
            if (this.ignoreDuplicates) continue;
            Object.assign(existing, raw, { updated_at: new Date().toISOString() });
            touched.push(existing);
          } else {
            const row = this.db.withDefaults(this.tableName, raw);
            table.push(row);
            touched.push(row);
          }
        }
        return this.written(touched);
      }
      case 'update': {
        const rows = this.matching();
        const patch = this.payload[0] ?? {};
        for (const row of rows) Object.assign(row, patch);
        return this.written(rows);
      }
      case 'delete': {
        const rows = this.matching();
        this.db.replace(this.tableName, table.filter((row) => !rows.includes(row)));
        return this.written(rows);
      }
    }
  }
}

export class InMemorySupabase {
  private readonly tables = new Map<string, Row[]>();
  /** Every builder created, in order — a test can assert what was touched. */
  readonly log: { table: string }[] = [];

  constructor(private readonly options: InMemoryOptions = {}) {}

  /** The server's per-response row ceiling, or undefined for no cap. */
  get maxRows(): number | undefined { return this.options.maxRows; }
  get likeSyntax(): InMemoryOptions['likeSyntax'] { return this.options.likeSyntax; }

  from(table: string): QueryBuilder {
    this.log.push({ table });
    return new QueryBuilder(this, table);
  }

  async rpc(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
    const handler = this.options.rpc?.[name] ?? BUILT_IN_RPC[name];
    if (!handler) return { data: null, error: pgError('42883', `function ${name} does not exist`), count: null, status: 404, statusText: 'Not Found' };
    try {
      const data = await handler(args, this);
      return { data, error: null, count: null, status: 200, statusText: 'OK' };
    } catch (error) {
      return { data: null, error: pgError('P0001', error instanceof Error ? error.message : String(error)), count: null, status: 400, statusText: 'Bad Request' };
    }
  }

  readonly auth = {
    getUser: async () => ({ data: { user: this.options.userId ? { id: this.options.userId } : null }, error: null }),
  };

  /** Direct access for seeding and assertions. Rows are live objects. */
  table(name: string): Row[] {
    let rows = this.tables.get(name);
    if (!rows) { rows = []; this.tables.set(name, rows); }
    return rows;
  }

  seed(name: string, rows: Row[]): void {
    for (const row of rows) {
      for (const column of this.uuidColumnsFor(name)) {
        const refusal = uuidRefusal(column, row[column]);
        if (refusal) throw new Error(`[in-memory-supabase] seed ${name}.${column}: ${refusal.message}`);
      }
      this.table(name).push(this.withDefaults(name, row));
    }
  }

  replace(name: string, rows: Row[]): void { this.tables.set(name, rows); }

  /**
   * Empty every table, so one instance can serve a suite that seeds the same
   * household per case. The mocked `createServiceClient` closes over a single
   * client, so tests cannot simply build a new one between cases.
   */
  reset(): void { this.tables.clear(); this.log.length = 0; }

  uniquesFor(name: string): string[][] { return this.options.uniques?.[name] ?? []; }
  uuidColumnsFor(name: string): string[] { return this.options.uuidColumns?.[name] ?? []; }
  isUuidColumn(name: string, column: string): boolean { return this.uuidColumnsFor(name).includes(column); }

  /** The defaults every migration in this repository gives its tables: a uuid id and timestamps. */
  withDefaults(table: string, raw: Row): Row {
    const now = new Date().toISOString();
    const row: Row = { ...raw };
    for (const [column, value] of Object.entries(this.options.defaults?.[table] ?? {})) {
      if (row[column] === undefined) row[column] = typeof value === 'object' && value !== null ? structuredClone(value) : value;
    }
    if (row.id === undefined || row.id === null) row.id = randomUUID();
    if (row.created_at === undefined) row.created_at = now;
    if (row.updated_at === undefined) row.updated_at = now;
    return row;
  }
}

/** Build one, typed as the client the server code expects. */
export function createInMemorySupabase<T = unknown>(options: InMemoryOptions = {}): InMemorySupabase & T {
  return new InMemorySupabase(options) as InMemorySupabase & T;
}

/** One builder call, as `withFaults` records it. */
export type FaultCall = { method: string; args: unknown[] };

/**
 * The same client, with chosen calls answering an error instead of the
 * database — a refused read, a timeout, a column PostgREST does not know.
 *
 * `fault` sees the table and every builder call made on it, in order, when the
 * query is awaited; returning an error answers `{ data: null, error }`, the
 * way supabase-js resolves every failure (it never throws). Returning null lets
 * the in-memory database answer as usual.
 */
export function withFaults<T extends object>(
  db: T,
  fault: (table: string, calls: FaultCall[]) => { code?: string; message: string } | null,
): T {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'from') return Reflect.get(target, property, receiver);
      return (table: string) => {
        const builder = (target as unknown as InMemorySupabase).from(table);
        const calls: FaultCall[] = [];
        const proxy: object = new Proxy(builder, {
          get(object, key) {
            if (key === 'then') {
              return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
                const failure = fault(table, calls);
                if (failure) {
                  return Promise.resolve({
                    data: null, count: null, status: 400, statusText: 'Bad Request',
                    error: pgError(failure.code ?? 'XX000', failure.message),
                  }).then(resolve, reject);
                }
                return object.then(resolve as never, reject);
              };
            }
            const value = Reflect.get(object, key);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              calls.push({ method: String(key), args });
              const result = Reflect.apply(value, object, args);
              return result === object ? proxy : result;
            };
          },
        });
        return proxy;
      };
    },
  });
}
