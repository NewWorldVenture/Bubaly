import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/wallet/actions.ts', 'utf8');

describe('wallet allowance persistence boundaries', () => {
  it('fails closed when due rules cannot be read', () => {
    expect(source).toContain('const { data: rules, error: rulesError }');
    expect(source).toContain("return actionFailure(rulesError, 'Could not load due allowances.')");
  });

  it('checks the schedule advance and rolls it back when crediting fails', () => {
    expect(source).toContain(".update({ next_run_on: next, last_run_on: today }).eq('id', rule.id).eq('family_id', familyId).select('id').single()");
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
