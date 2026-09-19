import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A write RLS refused must not be reported as a write that happened.
 *
 * Pass T swept these tables at the RLS layer and found them sound. They are:
 *
 *   health_providers / insurance_policies / medical_profiles
 *     SELECT  is_family_member(family_id)     ← every member reads
 *     UPDATE  can_manage_family(family_id)    ← only parents/adults write
 *     DELETE  can_manage_family(family_id)
 *
 * That is the gate working. The defect is on the client side of it, which is
 * what section C of the audit says was never examined. A teen, child or
 * caregiver sees the provider list, the insurance cards and the medical
 * profile, and can press Delete on any of them. RLS does not refuse the
 * statement — it matches ZERO ROWS and returns no error — so every handler in
 * medical-records-module read
 *
 *     if (err) { toastError(...); return; }
 *     success('Deleted');
 *
 * and told them the record was gone. It was not. On a medical profile the same
 * shape said "Profile saved" over allergies and emergency contacts that never
 * changed, which is the version of this that could matter to somebody.
 *
 * docs/audit/health-write-gate-check.sql measures the database half against the
 * real replayed schema: a teen's DELETE affects 0 rows and raises nothing, and
 * a parent's affects 1. This asserts the client half — that every manager-gated
 * write asks how many rows it changed before it claims anything.
 *
 * An INSERT blocked by RLS DOES raise, so the insert paths need no row check;
 * they carry `.select('id')` only because they share the statement with update.
 */

const source = readFileSync('components/modules/medical-records-module.tsx', 'utf8');

/** The five manager-gated writes this module performs. */
const WRITES = [
  { what: 'saving a provider', table: 'health_providers', verb: 'update' },
  { what: 'deleting a provider', table: 'health_providers', verb: 'delete' },
  { what: 'saving an insurance policy', table: 'insurance_policies', verb: 'update' },
  { what: 'deleting an insurance policy', table: 'insurance_policies', verb: 'delete' },
  { what: 'saving a medical profile', table: 'medical_profiles', verb: 'upsert' },
];

describe('medical-records writes report what actually happened', () => {
  for (const { what, table, verb } of WRITES) {
    it(`asks for the affected rows when ${what}`, () => {
      // Every write on these tables must come back with its rows, or a refusal
      // is indistinguishable from a success.
      const pattern = new RegExp(`from\\('${table}'\\)[\\s\\S]{0,240}?\\.${verb}\\(`);
      expect(source, `${what}: no ${verb} on ${table} found`).toMatch(pattern);
    });
  }

  it('never claims success without checking the row count', () => {
    // The shape of the defect: a success() reached with only `if (err)` behind
    // it. Each of the five now passes through a `!rows?.length` refusal first.
    const refusals = source.match(/if \(!rows\?\.length\)/g) ?? [];
    expect(refusals).toHaveLength(WRITES.length);
  });

  it('tells the reader WHY, in their own language', () => {
    // Not a generic failure: the row count distinguishes "refused" from
    // "broken", so the message can say which. This key already exists in all
    // seven locales, so no half-translated string ships with the fix.
    expect(source).toContain("t('actions.onlyAParentGuardianCan16')");
    for (const locale of ['en-US', 'nl-NL', 'fr-FR', 'de-DE', 'es-ES', 'it-IT', 'pt-PT']) {
      const messages = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8'));
      expect(messages['actions.onlyAParentGuardianCan16'], `${locale} is missing the refusal message`).toBeTruthy();
    }
  });

  it('still surfaces a real error separately from a refusal', () => {
    // The control: adding the row check must not swallow the error branch that
    // was already there.
    expect(source).toContain("if (err) { toastError(t('medicalRecordsModule.couldNotDelete')); return; }");
    expect(source).toContain("if (err) { toastError(t('medicalRecordsModule.couldNotSaveProfile')); return; }");
  });
});
