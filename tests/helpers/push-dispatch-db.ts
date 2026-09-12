import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

export type PushFixtureRow = Record<string, unknown>;
export const notificationId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function comparable(key: string, value: unknown): string | bigint {
  if (key.endsWith('_at') && typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    const fraction = value.match(/\.(\d+)/)?.[1] ?? '';
    return BigInt(Date.parse(value)) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3, 6));
  }
  return String(value);
}

function compare(key: string, left: unknown, right: unknown) {
  const a = comparable(key, left), b = comparable(key, right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function clauses(expression: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === '(') depth++;
    if (expression[i] === ')') depth--;
    if (expression[i] === ',' && depth === 0) { out.push(expression.slice(start, i)); start = i + 1; }
  }
  out.push(expression.slice(start));
  return out;
}

function contains(value: unknown, expected: unknown): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    return Boolean(value && typeof value === 'object' && Object.entries(expected).every(([key, child]) =>
      contains((value as PushFixtureRow)[key], child)));
  }
  return value === expected;
}

function matches(row: PushFixtureRow, expression: string): boolean {
  if (expression.startsWith('and(') && expression.endsWith(')')) return clauses(expression.slice(4, -1)).every(part => matches(row, part));
  if (expression.startsWith('or(') && expression.endsWith(')')) return clauses(expression.slice(3, -1)).some(part => matches(row, part));
  const match = expression.match(/^([a-z_]+)\.(eq|gt|gte|lt|lte)\.(.+)$/);
  if (!match) throw new Error(`Unsupported fixture filter: ${expression}`);
  const result = compare(match[1], row[match[1]], match[3]);
  return match[2] === 'eq' ? result === 0 : match[2] === 'gt' ? result > 0 : match[2] === 'gte' ? result >= 0 : match[2] === 'lt' ? result < 0 : result <= 0;
}

/** Stateful execution fixture: filters, multi-column ordering, limits, keysets and writes all apply. */
export function pushDispatchDb(tables: Record<string, PushFixtureRow[]>, options: { maxRows?: number } = {}) {
  tables.app_settings ??= [];
  const faults = new Set<string>();
  const thrownFaults = new Set<string>();
  const emptyWrites = new Set<string>();
  const stamps: string[] = [];
  const attempts = new Map<string, number>();
  const calls: { table: string; operation: string; count: number; limit: number; filter?: string }[] = [];
  const from = (table: string) => {
    let operation = 'select', patch: PushFixtureRow = {}, limit = Infinity, expression: string | undefined;
    const filters: ((row: PushFixtureRow) => boolean)[] = [];
    const orders: { key: string; ascending: boolean }[] = [];
    const execute = () => {
      const operationKey = `${table}:${operation}`;
      const attempt = (attempts.get(operationKey) ?? 0) + 1;
      attempts.set(operationKey, attempt);
      if (!(table in tables)) throw new Error(`Unexpected table ${table}`);
      if (thrownFaults.has(operationKey) || thrownFaults.has(`${operationKey}:${attempt}`)) throw new Error('Fixture connection failed');
      if (faults.has(operationKey) || faults.has(`${operationKey}:${attempt}`)) return { data: null, error: { message: 'Fixture database unavailable' } };
      if (emptyWrites.has(`${table}:${operation}`)) return { data: [], error: null };
      if (operation === 'upsert') {
        const existing = tables[table].find(row => row.key === patch.key);
        if (existing) Object.assign(existing, patch);
        else tables[table].push({ ...patch });
        calls.push({ table, operation, count: 1, limit });
        return { data: [{ ...patch }], error: null };
      }
      const rows = tables[table].filter(row => filters.every(filter => filter(row)))
        .sort((a, b) => {
          for (const order of orders) {
            const result = compare(order.key, a[order.key], b[order.key]);
            if (result) return order.ascending ? result : -result;
          }
          return 0;
        }).slice(0, operation === 'select' ? Math.min(limit, options.maxRows ?? Infinity) : limit);
      calls.push({ table, operation, count: rows.length, limit, filter: expression });
      if (operation === 'update') {
        for (const row of rows) { Object.assign(row, patch); if (table === 'notifications') stamps.push(String(row.id)); }
      } else if (operation === 'delete') tables[table] = tables[table].filter(row => !rows.includes(row));
      return { data: rows, error: null };
    };
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
      contains: (key: string, value: unknown) => { filters.push(row => contains(row[key], value)); return query; },
      is: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
      in: (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return query; },
      gt: (key: string, value: unknown) => { filters.push(row => compare(key, row[key], value) > 0); return query; },
      lte: (key: string, value: unknown) => { filters.push(row => compare(key, row[key], value) <= 0); return query; },
      or: (value: string) => { expression = value; filters.push(row => clauses(value).some(part => matches(row, part))); return query; },
      order: (key: string, options: { ascending: boolean }) => { orders.push({ key, ascending: options.ascending }); return query; },
      limit: (value: number) => { limit = value; return query; },
      update: (value: PushFixtureRow) => { operation = 'update'; patch = value; return query; },
      upsert: (value: PushFixtureRow) => { operation = 'upsert'; patch = value; return query; },
      delete: () => { operation = 'delete'; return query; },
      maybeSingle: async () => { const result = execute(); return { ...result, data: result.data?.[0] ?? null }; },
      then: (resolve: (result: ReturnType<typeof execute>) => unknown) => Promise.resolve(execute()).then(resolve),
    };
    return query;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, tables, faults, thrownFaults, emptyWrites, stamps, calls };
}
