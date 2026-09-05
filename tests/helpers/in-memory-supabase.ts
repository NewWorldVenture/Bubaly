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
  /** Per-table unique column sets; a violating insert answers 23505 like Postgres. */
  uniques?: Record<string, string[][]>;
  /** Per-table column defaults applied on insert when the row leaves the column unset (what the migrations' `default` clauses do). */
  defaults?: Record<string, Row>;
  /** RPC handlers by function name. Unknown functions answer an error. */
  rpc?: Record<string, (args: Record<string, unknown>, db: InMemorySupabase) => unknown | Promise<unknown>>;
  /** Auth user id for `auth.getUser()`. */
  userId?: string | null;
};

function pgError(code: string, message: string): PostgrestError {
  return { code, message, details: null, hint: null };
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

function operatorPredicate(column: string, op: string, wanted: unknown): Predicate {
  switch (op) {
    case 'eq': return (row) => looseEq(row[column], wanted);
    case 'neq': return (row) => !looseEq(row[column], wanted);
    case 'is': return (row) => (row[column] ?? null) === wanted;
    case 'gt': return (row) => row[column] != null && compare(row[column], wanted) > 0;
    case 'gte': return (row) => row[column] != null && compare(row[column], wanted) >= 0;
    case 'lt': return (row) => row[column] != null && compare(row[column], wanted) < 0;
    case 'lte': return (row) => row[column] != null && compare(row[column], wanted) <= 0;
    case 'in': {
      const values = Array.isArray(wanted)
        ? wanted
        : String(wanted).replace(/^\(/, '').replace(/\)$/, '').split(',').map((v) => parseFilterValue(v.trim().replace(/^"|"$/g, '')));
      return (row) => values.some((v) => looseEq(row[column], v));
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
          return Object.entries(wanted as Row).every(([k, v]) => looseEq((value as Row)[k], v));
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

/** `a.eq.1,b.is.null,c.in.(x,y)` — the flat form `.or()` is called with in this repository. */
function parseOr(expression: string): Predicate {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of expression) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current) parts.push(current);
  const predicates = parts.map((part) => {
    const trimmed = part.trim();
    const negated = trimmed.startsWith('not.');
    const body = negated ? trimmed.slice(4) : trimmed;
    const first = body.indexOf('.');
    const second = body.indexOf('.', first + 1);
    if (first < 0 || second < 0) throw new Error(`[in-memory-supabase] cannot parse or() clause "${part}"`);
    const column = body.slice(0, first);
    const op = body.slice(first + 1, second);
    const raw = body.slice(second + 1);
    const wanted = op === 'in' ? raw : parseFilterValue(raw);
    const predicate = operatorPredicate(column, op, wanted);
    return negated ? (row: Row) => !predicate(row) : predicate;
  });
  return (row) => predicates.some((p) => p(row));
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
    const embed = /^(?:([\w]+):)?([\w]+)(?:!\w+)?\((.*)\)$/.exec(part);
    if (embed) {
      const alias = embed[1] ?? embed[2];
      const table = embed[2];
      const inner = embed[3] || '*';
      const fkCandidates = [`${alias}_id`, `${table.replace(/s$/, '')}_id`, `${table}_id`];
      const fk = fkCandidates.find((c) => c in row);
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

class QueryBuilder implements PromiseLike<Reply> {
  private op: Op = 'select';
  private payload: Row[] = [];
  private upsertOn: string[] | null = null;
  private readonly predicates: Predicate[] = [];
  private selectList: string | null = null;
  private countMode: 'exact' | 'planned' | 'estimated' | null = null;
  private headOnly = false;
  private orderings: { column: string; ascending: boolean; nullsFirst: boolean | null }[] = [];
  private limitCount: number | null = null;
  private rangeBounds: { from: number; to: number } | null = null;
  private mode: 'many' | 'single' | 'maybeSingle' = 'many';

  constructor(private readonly db: InMemorySupabase, private readonly tableName: string) {}

  select(list = '*', opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }) {
    this.selectList = list;
    if (opts?.count) this.countMode = opts.count;
    if (opts?.head) this.headOnly = true;
    return this;
  }
  insert(rows: Row | Row[]) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }) {
    this.op = 'upsert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.upsertOn = opts?.onConflict ? opts.onConflict.split(',').map((c) => c.trim()) : ['id'];
    return this;
  }
  update(patch: Row) { this.op = 'update'; this.payload = [patch]; return this; }
  delete() { this.op = 'delete'; return this; }

  eq(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, value === null ? 'is' : 'eq', value)); return this; }
  neq(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'neq', value)); return this; }
  gt(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'gt', value)); return this; }
  gte(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'gte', value)); return this; }
  lt(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'lt', value)); return this; }
  lte(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'lte', value)); return this; }
  in(column: string, values: unknown[]) { this.predicates.push(operatorPredicate(column, 'in', values)); return this; }
  is(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'is', value)); return this; }
  like(column: string, pattern: string) { this.predicates.push(operatorPredicate(column, 'like', pattern)); return this; }
  ilike(column: string, pattern: string) { this.predicates.push(operatorPredicate(column, 'ilike', pattern)); return this; }
  contains(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'contains', value)); return this; }
  overlaps(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'overlaps', value)); return this; }
  not(column: string, op: string, value: unknown) {
    const wanted = op === 'in' && typeof value === 'string' ? value : value;
    const predicate = operatorPredicate(column, op, wanted);
    this.predicates.push((row) => !predicate(row));
    return this;
  }
  or(expression: string) { this.predicates.push(parseOr(expression)); return this; }
  filter(column: string, op: string, value: unknown) { this.predicates.push(operatorPredicate(column, op, value)); return this; }
  match(query: Row) { for (const [k, v] of Object.entries(query)) this.eq(k, v); return this; }

  order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orderings.push({ column, ascending: opts?.ascending ?? true, nullsFirst: opts?.nullsFirst ?? null });
    return this;
  }
  limit(count: number) { this.limitCount = count; return this; }
  range(from: number, to: number) { this.rangeBounds = { from, to }; return this; }
  abortSignal() { return this; }
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
      if (columns.some((c) => row[c] === null || row[c] === undefined)) continue;
      const clash = existing.find((other) => other !== row && columns.every((c) => looseEq(other[c], row[c])));
      if (clash) return pgError('23505', `duplicate key value violates unique constraint "${this.tableName}_${columns.join('_')}_key"`);
    }
    return null;
  }

  private execute(): Reply {
    const table = this.db.table(this.tableName);
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

  from(table: string): QueryBuilder {
    this.log.push({ table });
    return new QueryBuilder(this, table);
  }

  async rpc(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
    const handler = this.options.rpc?.[name];
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
    for (const row of rows) this.table(name).push(this.withDefaults(name, row));
  }

  replace(name: string, rows: Row[]): void { this.tables.set(name, rows); }

  /**
   * Empty every table, so one instance can serve a suite that seeds the same
   * household per case. The mocked `createServiceClient` closes over a single
   * client, so tests cannot simply build a new one between cases.
   */
  reset(): void { this.tables.clear(); this.log.length = 0; }

  uniquesFor(name: string): string[][] { return this.options.uniques?.[name] ?? []; }

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
