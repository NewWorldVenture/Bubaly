import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/wallet/actions.ts', 'utf8');

describe('wallet allowance persistence boundaries', () => {
  it('fails closed when due rules cannot be read', () => {
    expect(source).toContain('const { data: rules, error: rulesError }');
    expect(source).toContain("return actionFailure(rulesError, t('actions.couldNotLoadDueAllowances'))");
  });

  it('checks the schedule advance and rolls it back when crediting fails', () => {
    // This pinned the advance as a single blind statement ending `.single()`.
    // That WAS the bug: with no `.lte('next_run_on', today)` predicate the
    // update always matched, so two overlapping runs both advanced the rule and
    // both credited it. The intent — the advance is checked before the credit
    // and rolled back if the credit fails — is kept and strengthened: it is now
    // a CLAIM, matching the cron. See
    // tests/manual-allowance-run-claims-like-the-cron.test.ts.
    expect(source).toContain(".update({ next_run_on: next, last_run_on: today })");
    expect(source).toContain(".lte('next_run_on', today)");
    expect(source).toContain(".select('id').maybeSingle()");
    // Was pinned as an exact destructure. C1-S9-53 bound the rollback's ROWS as
    // well as its error — a rollback matching nothing leaves the schedule
    // advanced, so the child never receives that run — and the literal vanished
    // while the behaviour got stronger. Re-pointed at the behaviour, plus the
    // property the rewrite added so it cannot regress silently.
    expect(source).toContain("update({ next_run_on: rule.next_run_on, last_run_on: rule.last_run_on })");
    expect(source).toContain('error: rollbackError');
    expect(source).toContain('wroteNoRows(restored)');
    expect(source).toContain('a run may be skipped');
    expect(source).toContain("return { ok: false, error: res.error, ranCount, paidCents };");
  });

  it('only counts an allowance after its wallet credit succeeds', () => {
    const runSection = source.slice(source.indexOf('export async function runDueAllowancesAction'), source.indexOf('/** Create a savings goal'));
    expect(runSection).toContain('if (!res.ok)');
    expect(runSection).toContain('ranCount++;');
    expect(runSection).toContain('paidCents += rule.amount_cents;');
  });
});
