import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const helper = fs.readFileSync('lib/server/notification-emails.ts', 'utf8');
const route = fs.readFileSync('app/api/cron/notifications/route.ts', 'utf8');

describe('notification email failure contract', () => {
  it('returns sent, failed, and skipped counts', () => {
    expect(helper).toContain('export type NotificationEmailResult = { sent: number; failed: number; skipped: number };');
    expect(helper).toContain('return { sent, failed, skipped };');
    expect(helper).toContain('if (pendingError)');
    expect(helper).toContain('if (prefsError)');
    expect(helper).toContain('if (authUsersError)');
    expect(helper).toContain('if (resolveError)');
  });

  it('uses email failures in the cron status while preserving sent count', () => {
    expect(route).toContain('emailed.failed');
    expect(route).toContain('emailed: emailed.sent');
    expect(route).toContain('emailFailures: emailed.failed');
  });
});
