// Most of this product writes straight from the browser. There is no server
// action between `components/**/*.tsx` and PostgREST for medications,
// immunizations, visits, insurance policies, documents, the household binder or
// the password vault — the user's own JWT carries the write, so RLS is the
// entire authorization model and the UI is the only other thing that can
// decline. The two halves keep drifting apart, in both directions:
//
//   * gate on screen, none in the database → the button is hidden and the write
//     still works from any HTTP client. 0309 fixed that for `medications`,
//     saying it plainly: "a hidden button is not a boundary."
//   * guard in the database, none on screen → a child is shown Add and Delete,
//     taps them, and gets a refusal. 0326 found BOTH halves missing on
//     `immunizations` and `health_visits`; 0328 found the same on
//     `family_insurance_policies`, whose twin `insurance_policies` had been
//     manager-gated all along.
//
// This asserts the pairing rather than either half: whatever table the database
// decides is manager-only for writes, the client that writes it from the
// browser must say so too.
//
// Nine writers do not, and are named below rather than silently tolerated. They
// are not a security hole — the database holds, and `describeDbError` turns
// 42501 into "You don't have permission to do that" rather than a raw Postgres
// string — but a control that can never succeed is still a defect, and it sits
// on the password vault, the household binder and the document library. The
// list is a RATCHET: it may shrink, never grow. Audit C1-S8-03, C1-S8-07, C1-S8-08.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

/**
 * Tables whose INSERT/UPDATE/DELETE require a family manager, derived from a
 * replayed schema (all migrations applied) rather than guessed:
 *
 *   with w as (
 *     select tablename, permissive, coalesce(qual,'')||' '||coalesce(with_check,'') expr
 *       from pg_policies where schemaname='public' and cmd in ('INSERT','UPDATE','DELETE','ALL'))
 *   select tablename from w group by tablename having (
 *       (bool_and(case when permissive='PERMISSIVE' then expr ilike '%can_manage_family%' else true end)
 *        and bool_or(expr ilike '%can_manage_family%')
 *        and not bool_or(expr ilike '%auth.uid()%' or expr ilike '%is_self_member%'))
 *    or bool_or(permissive='RESTRICTIVE' and expr ilike '%can_manage_family%'));
 *
 * Both branches matter and the first draft of this query had only one: a
 * RESTRICTIVE manager guard ANDs over whatever the permissive policies allow,
 * so `medications` and friends are manager-only while every permissive policy
 * on them still reads `is_family_member`. Dropping the second branch lost seven
 * tables; keeping only the second lost thirty-one.
 *
 * A table whose manager rule is OR'd with a self path (`event_rsvps`,
 * `notifications`) is deliberately absent — there the member IS allowed to
 * write their own row, so a UI role gate would be wrong.
 */
const MANAGER_ONLY_WRITES = [
  'allowance_rules', 'assistant_links', 'bills', 'budgets', 'child_logins',
  'child_wallets', 'currency_transactions', 'documents', 'economy_rewards',
  'family_ai_settings', 'family_automation_rules', 'family_credentials',
  'family_currencies', 'family_facts', 'family_insurance_policies',
  'family_members', 'family_places', 'family_wallets', 'financial_accounts',
  'front_desk_settings', 'guardian_routing_rules', 'health_providers',
  'health_visits', 'household_info', 'immunizations', 'insurance_policies',
  'invest_holdings', 'invites', 'medical_profiles', 'medication_schedules',
  'medications', 'opportunities', 'renewals', 'rewards', 'rides',
  'savings_goals', 'transactions', 'trip_items', 'trips', 'wallet_buckets',
  'wallet_rules', 'wallet_transactions',
] as const;

/**
 * Browser writers that carry no role check today. A ratchet, not an amnesty:
 * removing an entry is the fix, adding one needs a reason in the audit.
 */
const KNOWN_UNGATED = new Set([
  'components/family/invite-form.tsx -> invites',
  'components/finance/bills-view.tsx -> bills',
  'components/modules/billing-module.tsx -> bills',
  'components/modules/billing-module.tsx -> financial_accounts',
  'components/modules/binder-module.tsx -> household_info',
  'components/modules/documents-module.tsx -> documents',
  'components/modules/finances-module.tsx -> financial_accounts',
  'components/modules/passwords-module.tsx -> family_credentials',
  'components/modules/settings-module.tsx -> family_members',
]);

// Two idioms mean the same thing in this codebase. `family-module.tsx` reaches
// MANAGER_ROLES directly and was a false positive until this accepted it — the
// third census in this audit to cry wolf by looking for one spelling.
const ROLE_CHECK = /\bisManager\s*\(|MANAGER_ROLES\.includes\s*\(/;

// Walked from disk, not from `git ls-files`: the first draft used git and
// silently skipped the migration that had just been written and not yet
// staged, reporting the tables it was added to protect as ungated. A scanner
// whose input depends on the index answers a different question.
function walk(...dirs: string[]): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) visit(child);
      else out.push(child);
    }
  };
  for (const d of dirs) visit(d);
  return out;
}

/** Tables any migration puts behind a restrictive `*_manager_*_guard`. */
function restrictivelyGuarded(): string[] {
  const found = new Set<string>();
  for (const rel of walk('supabase/migrations')) {
    if (!rel.endsWith('.sql')) continue;
    const sql = readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of sql.matchAll(
      /create\s+policy\s+[a-z_]+_manager_(?:insert|update|delete)_guard\s+on\s+public\.([a-z_]+)/gi,
    )) found.add(m[1]);
  }
  return [...found].sort();
}

const clientComponents = (): string[] =>
  walk('components', 'app')
    .filter((rel) => rel.endsWith('.tsx'))
    .filter((rel) => readFileSync(path.join(ROOT, rel), 'utf8').startsWith("'use client'"));

/** Client components that write `table` directly through the browser client. */
function clientWritersOf(table: string, files = clientComponents()): string[] {
  const write = new RegExp(`from\\(['"\`]${table}['"\`]\\)\\s*\\.\\s*(insert|update|delete|upsert)\\b`);
  return files.filter((rel) => write.test(readFileSync(path.join(ROOT, rel), 'utf8')));
}

describe('a manager-gated table is manager-gated on screen', () => {
  it('scans a real set of client components', () => {
    // A scan that silently matched nothing would pass forever — C4-S5-01's class.
    const files = clientComponents();
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain('components/modules/immunizations-module.tsx');
    expect(files).toContain('components/modules/insurance-module.tsx');
  });

  it('keeps the pinned table list honest against the migrations', () => {
    // The pin is derived from a replayed database, which this test cannot
    // reach. What it CAN check is that every table the migrations put behind a
    // restrictive manager guard is in the pin — so a new guard that never
    // reaches the pin is caught here rather than silently unscanned.
    const missing = restrictivelyGuarded().filter((t) => !MANAGER_ONLY_WRITES.includes(t as never));
    expect(missing, 'a restrictive manager guard exists for a table the pin does not list').toEqual([]);
    expect(MANAGER_ONLY_WRITES.length).toBeGreaterThanOrEqual(42);
  });

  it('finds the browser writers it is about', () => {
    expect(clientWritersOf('immunizations')).toContain('components/modules/immunizations-module.tsx');
    expect(clientWritersOf('family_insurance_policies')).toContain('components/modules/insurance-module.tsx');
    // And does not match a component that only READS the table.
    expect(clientWritersOf('immunizations')).not.toContain('components/medical/print-sheet.tsx');
  });

  it('every browser writer of a manager-only table declares a role check', () => {
    const files = clientComponents();
    const unguarded: string[] = [];
    for (const table of MANAGER_ONLY_WRITES) {
      for (const rel of clientWritersOf(table, files)) {
        if (ROLE_CHECK.test(readFileSync(path.join(ROOT, rel), 'utf8'))) continue;
        const entry = `${rel} -> ${table}`;
        if (!KNOWN_UNGATED.has(entry)) unguarded.push(entry);
      }
    }
    expect(unguarded, 'a new browser writer of a manager-only table has no role check').toEqual([]);
  });

  it('holds the known list as a ratchet — every entry is still real', () => {
    // Otherwise the exception list rots: a writer that was fixed, or a file
    // that moved, would leave a stale entry excusing a future offender.
    const files = clientComponents();
    const stale: string[] = [];
    for (const entry of KNOWN_UNGATED) {
      const [rel, table] = entry.split(' -> ');
      const stillWrites = clientWritersOf(table, files).includes(rel);
      const stillUngated = stillWrites
        && !ROLE_CHECK.test(readFileSync(path.join(ROOT, rel), 'utf8'));
      if (!stillUngated) stale.push(entry);
    }
    expect(stale, 'these are fixed or gone — remove them from KNOWN_UNGATED').toEqual([]);
  });
});
