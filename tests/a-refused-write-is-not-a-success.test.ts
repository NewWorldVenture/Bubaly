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

/**
 * Tables whose UPDATE/DELETE requires manager rights — the full set, not only
 * the `restrictive` ones.
 *
 * A first version of this list held 19 tables, taken from policies declared
 * `as restrictive`. That was too narrow by a factor of nearly three: a
 * PERMISSIVE policy whose `using` clause requires `can_manage_family` filters
 * a non-manager's update exactly as silently. Widening it exposed fourteen
 * more call sites — the health providers and insurance policies, the password
 * vault's soft delete, three document surfaces and the family name.
 *
 * `family_members` and `notifications` are deliberately ABSENT. Their policies
 * are "own row OR manager" (`user_id = auth.uid() or …`), so a member's own
 * write succeeds and zero rows is a normal outcome — "mark all read" with
 * nothing unread affects no rows and must not be reported as a refusal.
 */
export const GUARDED_TABLES = new Set([
  // gift_links, gift_payments, pay_handles and wallet_goals joined in 0329
  // (SEC-017): they are the rows a parent's money decision is made FROM.
  'allowance_rules', 'approval_requests', 'assistant_links', 'bills', 'budgets',
  'gift_links', 'gift_payments', 'pay_handles', 'wallet_goals',
  'child_wallets', 'currency_transactions', 'documents', 'driver_licenses',
  'economy_redemptions', 'economy_rewards', 'event_rsvps', 'families',
  'family_ai_settings', 'family_automation_rules', 'family_automation_runs',
  'family_credentials', 'family_currencies', 'family_facts', 'family_places',
  'family_wallets', 'financial_accounts', 'guardian_routing_rules',
  'health_providers', 'insurance_policies', 'invest_holdings', 'invest_orders',
  'invites', 'medical_profiles', 'medication_schedules', 'medications',
  'opportunities', 'parent_approvals', 'renewals', 'rewards', 'rides',
  'savings_goals', 'social_account_tokens', 'transactions', 'trip_items',
  'trips', 'wallet_buckets', 'wallet_rules', 'wallet_transactions',
]);

/** Tables where a manager check is one branch of an OR with a self clause. */
export const MANAGER_OR_SELF = new Set(['family_members', 'notifications']);

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
    expect(total).toBeGreaterThan(35);
  });

  it('recognises the shape it forbids', () => {
    const bad = "const sb = createClient();\nawait sb.from('medications').delete().eq('id', x);";
    expect(unverifiedWrites(bad).map((h) => h.table)).toEqual(['medications']);
    const good = "const sb = createClient();\nawait sb.from('medications').delete().eq('id', x).select('id');";
    expect(unverifiedWrites(good)).toEqual([]);
    // An unguarded table is not this rule's business, and neither is an insert
    // (a `with check` violation raises, so the client already sees it).
    expect(unverifiedWrites("createClient();\nawait sb.from('grocery_items').delete().eq('id', x);")).toEqual([]);
    // "own OR manager" tables are excluded: a member's own write succeeds, and
    // zero rows is a normal outcome there rather than a refusal.
    expect(unverifiedWrites("createClient();\nawait sb.from('notifications').update({ is_read: true }).eq('id', x);")).toEqual([]);
    expect(MANAGER_OR_SELF.has('family_members')).toBe(true);
    expect(unverifiedWrites("createClient();\nawait sb.from('medications').insert({ a: 1 });")).toEqual([]);
  });

  it('zero rows reads as a refusal, and one row does not', () => {
    expect(wroteNoRows([])).toBe(true);
    expect(wroteNoRows(null)).toBe(true);
    expect(wroteNoRows(undefined)).toBe(true);
    expect(wroteNoRows([{ id: 'a' }])).toBe(false);
  });
});
