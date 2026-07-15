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
    expect(source).toContain("throw new Error(`Allowance credit failed: ${res.error}`);");
  });

  it('counts only successful credits', () => {
    const creditIndex = source.indexOf('const res = await creditChildWallet');
    const paidIndex = source.indexOf('paid++;', creditIndex);
    expect(paidIndex).toBeGreaterThan(creditIndex);
    expect(source.slice(creditIndex, paidIndex)).toContain('if (!res.ok)');
  });
});
