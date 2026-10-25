import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// `unserved` is the tail of families the generation budget never reached
// (lib/server/cron-family-sweep.ts): a failed run, not a quiet one.
const routes = [
  ['notifications', 'app/api/cron/notifications/route.ts', 'generationFailures + pushDispatchFailures + pushed.result.failed + pushed.result.skipped + emailDeliveryFailures + emailed.failed + unserved'],
  ['push-scan', 'app/api/cron/push-scan/route.ts', 'generationFailures + respawnFailures + pushDispatchFailures + pushed.result.failed + pushed.result.skipped + unserved'],
] as const;

describe('notification cron failure status contracts', () => {
  it.each(routes)('%s returns non-success status after delivery or generation failures', (_name, path, expression) => {
    const source = fs.readFileSync(path, 'utf8');
    expect(source).toContain(`const failed = ${expression};`);
    expect(source).toContain('const ok = failed === 0;');
    expect(source).toContain('{ status: ok ? 200 : 502 }');
  });
});
