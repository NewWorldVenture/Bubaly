import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every client write on a manager-gated table asks how many rows it changed.
 *
 * 33 tables are `SELECT is_family_member` / `UPDATE,DELETE can_manage_family`.
 * A non-manager sees those rows and can press the button. RLS does not refuse
 * the statement with an error — it matches ZERO ROWS and returns success — so
 * `if (error) … else success(…)` announces a change that did not happen.
 *
 * `docs/audit/health-write-gate-check.sql` measures the database half: a teen's
 * DELETE affects 0 rows and raises nothing while that teen can still SELECT the
 * row, and a parent's affects 1. This pins the client half across every module
 * that writes one of these tables, so the next one added has to answer for it.
 *
 * Only UPDATE/DELETE/UPSERT need the count. An INSERT blocked by RLS DOES
 * raise, so insert-only handlers are not listed here.
 */

/** Module → the manager-gated tables it updates, deletes or upserts. */
const GATED_WRITES: Record<string, string[]> = {
  'components/modules/medical-records-module.tsx': ['health_providers', 'insurance_policies', 'medical_profiles'],
  'components/modules/medications-module.tsx': ['medications', 'medication_schedules'],
  'components/modules/rewards-module.tsx': ['rewards'],
  'components/modules/billing-module.tsx': ['bills', 'financial_accounts'],
  'components/finance/bills-view.tsx': ['bills'],
  'components/modules/family-module.tsx': ['family_members'],
  'components/modules/settings-module.tsx': ['families', 'family_members'],
};

/** A write statement that asks for nothing back cannot tell refused from done. */
const BLIND_WRITE = (table: string) =>
  new RegExp(`from\\('${table}'\\)\\s*\\n?\\s*\\.(update|delete|upsert)\\([^;]*?;`, 'g');

describe('a manager-gated write never claims success on a refusal', () => {
  for (const [file, tables] of Object.entries(GATED_WRITES)) {
    const source = readFileSync(file, 'utf8');

    for (const table of tables) {
      it(`${file.split('/').pop()} · ${table}: every write returns its rows`, () => {
        const statements = source.match(BLIND_WRITE(table)) ?? [];
        expect(statements.length, `no update/delete/upsert on ${table} found — did the module change?`).toBeGreaterThan(0);
        const blind = statements.filter((s) => !s.includes(".select('id')"));
        expect(blind, `${table}: a write with no row count`).toEqual([]);
      });
    }

    it(`${file.split('/').pop()}: refuses out loud when zero rows changed`, () => {
      // Two sessions found this class independently and converged on
      // `wroteNoRows` from lib/supabase/errors (whose header records the
      // Postgres 16 measurement: `using` FILTERS an update/delete to zero rows
      // while `with check` RAISES on an insert). The property asserted here is
      // the zero-row check plus a message — not one spelling of it.
      // Three forms make a refusal visible, and all three are in this codebase:
      //   - `wroteNoRows(rows)` / `!rows?.length` after `.select('id')`
      //   - `.select('id').single()`, which turns ZERO rows into a PGRST116
      //     error, routed through a handler that throws on `error` (the
      //     `mutate()` helper main adopted, which also reads the row back).
      const counted = /wroteNoRows\(\w+\)|![\w]*[Rr]ows\?\.length/.test(source);
      const singled = /\.select\('id'\)\.single\(\)/.test(source) && /if \((\w+)\) throw \1\b/.test(source);
      expect(counted || singled, 'a refused write would still read as a success').toBe(true);
    });
  }

  it('uses a refusal message that exists in every locale', () => {
    // A guard that ships a missing translation key just moves the lie.
    for (const locale of ['en-US', 'nl-NL', 'fr-FR', 'de-DE', 'es-ES', 'it-IT', 'pt-PT']) {
      const messages = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8'));
      expect(messages['errors.thatChangeWasNotSaved'], `${locale}`).toBeTruthy();
    }
  });
});

// `notifications` is gated per row, not per table: SELECT and UPDATE are
// "own row OR family-wide", DELETE is "own row OR can_manage_family". So every
// member is shown a bin on a family-wide notice that only a manager can empty.
// Mark-read stays uncounted on purpose (zero rows there means nothing was
// unread); the delete is the write that can be refused.
describe('deleting a notification the member cannot delete', () => {
  const source = readFileSync('components/modules/notifications-module.tsx', 'utf8');

  it('asks how many rows the delete removed, and says so when none', () => {
    const deletes = source.match(/from\('notifications'\)\.delete\(\)[^;]*;/g) ?? [];
    expect(deletes.length, 'no notification delete found — did the module change?').toBeGreaterThan(0);
    expect(deletes.filter((s) => !s.includes(".select('id')")), 'a delete with no row count').toEqual([]);
    expect(source).toMatch(/if \(wroteNoRows\(rows\)\) toastError\(t\('errors\.thatChangeWasNotSaved'\)\)/);
  });
});
