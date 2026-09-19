import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { wroteNoRows } from '@/lib/supabase/errors';

// A browser-direct UPDATE or DELETE that row-level security refuses is NOT an
// error. Postgres applies a restrictive policy's `using` clause as a FILTER, so
// the statement matches nothing and succeeds.
//
// Measured on Postgres 16, with the exact policy shape migration 0309 installs,
// acting as a non-manager:
//
//     update medications set dosage = '40 mg' where id = 1;   UPDATE 0   dosage still 10 mg
//     delete from medications where id = 1;                   DELETE 0   row still present
//     insert into medications values (…);                     ERROR  42501
//
// That asymmetry is the whole defect. `with check` (INSERT) raises and the
// client sees it; `using` (UPDATE/DELETE) filters and the client sees success.
// So the RLS hardening 0254/0275/0306/0308/0309/0310 added is correct AND
// invisible, and twenty-five call sites went on to report "Medication deleted",
// "Bill marked as paid", "Trip updated" for writes that never happened.
//
// PostgREST only returns affected rows when asked: `.select()` is what appends
// `Prefer: return=representation` (postgrest-js PostgrestTransformBuilder).
// Without it `data` is null whether one row changed or none did — the call site
// could not tell even in principle.
//
// The rule: a browser-direct update/delete on a table carrying a restrictive
// manager guard must ask for its rows back and treat zero as a refusal.
const ROOTS = ['components'];

/** Tables given a restrictive manager UPDATE/DELETE guard by the migrations. */
export const GUARDED_TABLES = new Set([
  'allowance_rules', 'bills', 'budgets', 'child_wallets', 'family_wallets',
  'financial_accounts', 'medication_schedules', 'medications', 'opportunities',
  'renewals', 'rewards', 'rides', 'savings_goals', 'transactions', 'trip_items',
  'trips', 'wallet_buckets', 'wallet_rules', 'wallet_transactions',
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (extname(p) === '.tsx') out.push(p);
  }
  return out;
}

/** Browser-direct update/delete on a guarded table that never asks for its rows. */
export function unverifiedWrites(source: string): { table: string; op: string; line: number }[] {
  if (!source.includes('createClient')) return [];
  const hits: { table: string; op: string; line: number }[] = [];
  for (const m of source.matchAll(/\.from\('([a-z_]+)'\)\s*\.(update|delete)\(/g)) {
    if (!GUARDED_TABLES.has(m[1])) continue;
    const statement = source.slice(m.index, m.index + 400).split(';')[0];
    if (statement.includes('.select(')) continue;
    hits.push({ table: m[1], op: m[2], line: source.slice(0, m.index).split('\n').length });
  }
  return hits;
}

describe('a write RLS refused is not reported as a success', () => {
  const files = ROOTS.flatMap((r) => sourceFiles(r));

  it('scans a meaningful number of components', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('every browser-direct write on a guarded table asks for its rows back', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const hit of unverifiedWrites(readFileSync(file, 'utf8'))) {
        offenders.push(`${file}:${hit.line} — ${hit.op} on ${hit.table} without .select(); a refused write returns zero rows and no error`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('finds the call sites it is supposed to check (guards the guard)', () => {
    // Every one now passes because every one has `.select()`. Counting the
    // guarded writes themselves proves the scan still reaches them — without
    // this, deleting the module would satisfy the case above forever.
    const total = files.reduce((n, f) => {
      const src = readFileSync(f, 'utf8');
      if (!src.includes('createClient')) return n;
      return n + [...src.matchAll(/\.from\('([a-z_]+)'\)\s*\.(update|delete)\(/g)]
        .filter((m) => GUARDED_TABLES.has(m[1])).length;
    }, 0);
    expect(total).toBeGreaterThan(20);
  });

  it('recognises the shape it forbids', () => {
    const bad = "const sb = createClient();\nawait sb.from('medications').delete().eq('id', x);";
    expect(unverifiedWrites(bad).map((h) => h.table)).toEqual(['medications']);
    const good = "const sb = createClient();\nawait sb.from('medications').delete().eq('id', x).select('id');";
    expect(unverifiedWrites(good)).toEqual([]);
    // An unguarded table is not this rule's business, and neither is an insert
    // (a `with check` violation raises, so the client already sees it).
    expect(unverifiedWrites("createClient();\nawait sb.from('grocery_items').delete().eq('id', x);")).toEqual([]);
    expect(unverifiedWrites("createClient();\nawait sb.from('medications').insert({ a: 1 });")).toEqual([]);
  });

  it('zero rows reads as a refusal, and one row does not', () => {
    expect(wroteNoRows([])).toBe(true);
    expect(wroteNoRows(null)).toBe(true);
    expect(wroteNoRows(undefined)).toBe(true);
    expect(wroteNoRows([{ id: 'a' }])).toBe(false);
  });
});
