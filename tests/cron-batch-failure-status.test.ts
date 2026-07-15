import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const routes = [
  ['calendar-feeds', 'app/api/cron/calendar-feeds/route.ts', 'failed'],
  ['autopilot-scan', 'app/api/cron/autopilot-scan/route.ts', 'failures'],
  ['model-refresh', 'app/api/cron/model-refresh/route.ts', 'summary.failures'],
  ['close-auctions', 'app/api/cron/close-auctions/route.ts', 'failed'],
] as const;

describe('scheduled batch failure status contracts', () => {
  it.each(routes)('%s returns non-success status after batch failures', (_name, path, failureExpression) => {
    const source = fs.readFileSync(path, 'utf8');
    expect(source).toContain(`const ok = ${failureExpression} === 0;`);
    expect(source).toContain('{ status: ok ? 200 : 502 }');
  });
});
