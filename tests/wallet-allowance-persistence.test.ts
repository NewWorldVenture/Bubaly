import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/wallet/actions.ts', 'utf8');

describe('wallet allowance persistence boundaries', () => {
  it('fails closed when due rules cannot be read', () => {
    expect(source).toContain('const { data: rules, error: rulesError }');
    expect(source).toContain("return actionFailure(rulesError, t('actions.couldNotLoadDueAllowances'))");
  });

  // This assertion used to be the EXACT TEXT of the update, `.select('id').single()`
  // and all — which pinned the defect rather than the property. The action
  // advanced the schedule by id alone, with no `.lte('next_run_on', today)`, so
  // two overlapping runs both matched the row and both credited the same period.
  // The one-line fix for that would have turned this test red, which is the worst
  // thing a guard can do: make the fix look like the regression.
  //
  // What this file is actually about is persistence — the advance is checked and
  // rolled back when crediting fails. So it asserts that, in ordered pieces,
  // without re-pinning a formatting choice. The exclusivity predicate itself is
  // the subject of tests/allowance-cron-idempotency.test.ts, which now discovers
  // every site that advances a schedule rather than reading one hardcoded file.
  it('checks the schedule advance and rolls it back when crediting fails', () => {
    const advance = source.slice(source.indexOf('.update({ next_run_on: next'));
    expect(advance.slice(0, 400)).toContain(".eq('id', rule.id)");
    expect(advance.slice(0, 400)).toContain(".eq('family_id', familyId)");
    expect(advance.slice(0, 400)).toContain('.select(');
    expect(source).toContain("const { error: rollbackError } = await supabase.from('allowance_rules').update({ next_run_on: rule.next_run_on, last_run_on: rule.last_run_on })");
    expect(source).toContain("return { ok: false, error: res.error, ranCount, paidCents };");
  });

  it('only counts an allowance after its wallet credit succeeds', () => {
    const runSection = source.slice(source.indexOf('export async function runDueAllowancesAction'), source.indexOf('/** Create a savings goal'));
    expect(runSection).toContain('if (!res.ok)');
    expect(runSection).toContain('ranCount++;');
    expect(runSection).toContain('paidCents += rule.amount_cents;');
  });
});
