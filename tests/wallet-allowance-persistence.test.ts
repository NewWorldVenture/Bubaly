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
    // The rollback's PROPERTY, not one spelling of its declaration. It restores
    // both dates, and it now reads the row back — RLS filters an UPDATE rather
    // than refusing it, so the `console.error` that was this rollback's only
    // trace never fired for the case where nothing changed, leaving the rule
    // advanced while the credit had failed and the child skipped for a period.
    expect(source).toContain(".update({ next_run_on: rule.next_run_on, last_run_on: rule.last_run_on })");
    expect(source).toMatch(/const \{ data: rolledBack, error: rollbackError \}/);
    expect(source).toContain("console.error('[wallet allowances] schedule rollback changed no row'");
    expect(source).toContain("return { ok: false, error: res.error, ranCount, paidCents };");
  });

  it('only counts an allowance after its wallet credit succeeds', () => {
    const runSection = source.slice(source.indexOf('export async function runDueAllowancesAction'), source.indexOf('/** Create a savings goal'));
    expect(runSection).toContain('if (!res.ok)');
    expect(runSection).toContain('ranCount++;');
    expect(runSection).toContain('paidCents += rule.amount_cents;');
  });
});
