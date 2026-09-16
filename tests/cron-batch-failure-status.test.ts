import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const routes = [
  ['calendar-feeds', 'app/api/cron/calendar-feeds/route.ts', 'failed'],
  ['autopilot-scan', 'app/api/cron/autopilot-scan/route.ts', 'failures'],
  ['model-refresh', 'app/api/cron/model-refresh/route.ts', 'summary.failures'],
  ['close-auctions', 'app/api/cron/close-auctions/route.ts', 'failed'],
  // The money one. It threw instead of counting, so a single unpayable rule
  // ended the platform's allowance run and every rule ordered after it went
  // unpaid — that night and, because the rollback leaves the rule due, every
  // night after.
  ['wallet-allowance', 'app/api/cron/wallet-allowance/route.ts', 'failed'],
] as const;

describe('scheduled batch failure status contracts', () => {
  it.each(routes)('%s returns non-success status after batch failures', (_name, path, failureExpression) => {
    const source = fs.readFileSync(path, 'utf8');
    expect(source).toContain(`const ok = ${failureExpression} === 0;`);
    expect(source).toContain('{ status: ok ? 200 : 502 }');
  });
});
