import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, between } from './helpers/source-order';

/**
 * Audit C1-S9-77 — client modules that report a write they cannot see.
 *
 * Under RLS a refused row is refused with NO error: zero rows come back, and
 * each of these modules said "Member removed", "Record updated", "Deleted".
 * The components ratchet (an-unconfirmed-write-in-components-ratchet) holds
 * that the writes now ASK for their rows; this holds that the answer is READ —
 * a `.select('id')` whose result nobody checks is the same lie with one more
 * round trip.
 */
const FIXED = [
  'components/modules/family-module.tsx',
  'components/modules/health-module.tsx',
  'components/modules/health-visits-module.tsx',
  'components/modules/immunizations-module.tsx',
  'components/modules/care-module.tsx',
  'components/modules/devices-module.tsx',
  'components/modules/reminders-module.tsx',
  'components/modules/concierge-module.tsx',
];

describe('a confirmed client write is read, not just requested (C1-S9-77)', () => {
  it.each(FIXED)('%s checks every row set it asks for', (file) => {
    const src = readFileSync(file, 'utf8');
    const bindings = [...src.matchAll(/const \{ data: (\w+), error(?:: \w+)? \} = [\s\S]{0,400}?\.select\('id'\)/g)].map((m) => m[1]);
    expect(bindings.length, 'no confirmed write found — the file changed shape').toBeGreaterThan(0);
    for (const b of bindings) {
      expect(src, `${b} is requested but never read`).toContain(`wroteNoRows(${b})`);
      // …and read AFTER it is bound, not in some earlier function.
      expect(at(src, `data: ${b}, error`)).toBeLessThan(at(src, `wroteNoRows(${b})`));
    }
  });

  it('a zero-row write says it was not saved, in the family\'s language', () => {
    const en = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
    expect(en['errors.thatChangeWasNotSaved']).toBe("That change wasn't saved — you may not have permission. Refresh and try again.");
    for (const file of FIXED.filter((f) => !f.endsWith('health-module.tsx'))) {
      expect(readFileSync(file, 'utf8'), file).toMatch(/\(['"]errors\.thatChangeWasNotSaved['"]\)/);
    }
  });
});

describe('a plan acceptance that never landed does not run the loop (C1-S9-77)', () => {
  it('the status move is confirmed and reverted on screen before planAcceptedAction can run', () => {
    const src = readFileSync('components/modules/concierge-module.tsx', 'utf8');
    const fn = between(src, 'async function updateStatus(status: string) {', 'planAcceptedAction(plan.id, prev, status)');
    expect(fn).toContain("if (wroteNoRows(moved)) { setEditStatus(prev); toastError(t('errors.thatChangeWasNotSaved')); return; }");
  });

  it('the server acts on the persisted status, not the caller\'s claim', () => {
    const src = readFileSync('app/(app)/dashboard/concierge/actions.ts', 'utf8');
    const fn = between(src, 'export async function planAcceptedAction(', 'export async function executeQueuedRunAction(');
    expect(fn).toContain("select('id, title, description, location, planned_for, budget_cents, status')");
    expect(at(fn, 'if (plan.status !== nextStatus)')).toBeLessThan(at(fn, 'const { decision, approvalId } = await evaluateTrust('));
  });
});

describe('completing a recurring reminder schedules its next occurrence once (C1-S9-77)', () => {
  const src = readFileSync('components/modules/reminders-module.tsx', 'utf8');
  const fn = between(src, 'function complete(reminder: Reminder) {', 'function toggleSubtask(');

  it('a completion that matched nothing returns before the next occurrence is built', () => {
    expect(at(fn, 'if (wroteNoRows(completedRows))')).toBeLessThan(at(fn, 'nextRemindAt('));
    expect(at(fn, 'if (wroteNoRows(completedRows))')).toBeLessThan(at(fn, ".from('family_reminders').insert(nextRow)"));
  });

  it('an already-completed reminder matches nothing; a snoozed one can still be completed', () => {
    expect(fn).toContain(".neq('status', 'completed').select('id')");
    // Not eq('active'): a snoozed reminder shows the same button.
    expect(fn).not.toContain(".eq('status', 'active')");
  });
});
