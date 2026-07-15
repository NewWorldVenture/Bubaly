import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const routes = [
  ['notifications', 'app/api/cron/notifications/route.ts', 'generationFailures + pushDispatchFailures + pushed.result.failed + emailDeliveryFailures + emailed.failed'],
  ['push-scan', 'app/api/cron/push-scan/route.ts', 'generationFailures + pushDispatchFailures + pushed.result.failed'],
] as const;

describe('notification cron failure status contracts', () => {
  it.each(routes)('%s returns non-success status after delivery or generation failures', (_name, path, expression) => {
    const source = fs.readFileSync(path, 'utf8');
    expect(source).toContain(`const failed = ${expression};`);
    expect(source).toContain('const ok = failed === 0;');
    expect(source).toContain('{ status: ok ? 200 : 502 }');
  });
});
