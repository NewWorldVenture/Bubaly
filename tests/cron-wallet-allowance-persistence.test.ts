import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/api/cron/wallet-allowance/route.ts', 'utf8');

describe('cron wallet allowance persistence boundaries', () => {
  it('loads the prior schedule needed for recovery', () => {
    expect(source).toContain('next_run_on, last_run_on');
  });

  it('fails the run when plan gating cannot be read', () => {
    expect(source).toContain('subscriptionsError');
    expect(source).toContain('if (subscriptionsError) throw subscriptionsError;');
  });

  it('checks the schedule claim before crediting the wallet', () => {
    const creditIndex = source.indexOf('const res = await creditChildWallet');
    const scheduleIndex = source.indexOf(".select('id')");
    expect(scheduleIndex).toBeGreaterThan(-1);
    expect(scheduleIndex).toBeLessThan(creditIndex);
    expect(source).toContain(".eq('family_id', rule.family_id)");
    expect(source).toContain('if (scheduleError) throw scheduleError;');
  });

  it('restores the schedule when the wallet credit fails', () => {
    expect(source).toContain(".update({ next_run_on: rule.next_run_on, last_run_on: rule.last_run_on })");
  });

  // This used to assert `throw new Error(...)` as its proxy for "the failure is
  // not swallowed". The throw was the defect: the outer catch turned it into a
  // 500, and since the rollback above leaves the rule due and the rules are read
  // `.order('id')`, one unpayable rule stopped every rule after it, that night
  // and every night after. The intent is kept and made explicit — the failure
  // must still be recorded and surfaced, it just must not end the run. The
  // behaviour itself is covered by
  // tests/allowance-cron-isolates-one-bad-rule.test.ts.
  it('records the failure and surfaces it, without ending the run', () => {
    expect(source).toContain('failed++;');
    expect(source).toContain("console.error('Allowance credit failed; leaving it retryable.'");
    expect(source).toContain('const ok = failed === 0;');
    expect(source).toContain('{ status: ok ? 200 : 502 }');
    expect(source).not.toContain('throw new Error(`Allowance credit failed');
  });

  it('counts only successful credits', () => {
    const creditIndex = source.indexOf('const res = await creditChildWallet');
    const paidIndex = source.indexOf('paid++;', creditIndex);
    expect(paidIndex).toBeGreaterThan(creditIndex);
    expect(source.slice(creditIndex, paidIndex)).toContain('if (!res.ok)');
  });
});
