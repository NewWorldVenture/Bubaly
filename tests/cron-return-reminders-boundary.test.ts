import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const returnReminders = readFileSync('app/api/cron/return-reminders/route.ts', 'utf8');
const modelRefresh = readFileSync('app/api/cron/model-refresh/route.ts', 'utf8');

describe('scheduled recovery persistence boundaries', () => {
  it('return reminders fail after listing, notification, or dedupe-stamp failures', () => {
    expect(returnReminders).toContain('listingError');
    // A notification that did not go out must COUNT as a failure, so the cron
    // reports 502 instead of a clean run — and it must not stamp
    // `overdue_notified_at` / `due_reminder_sent_at` on an order nobody was told
    // about, which would suppress the nudge forever. This was pinned by the name
    // of a local (`notificationError`) and broke when the route moved to
    // notify() while still doing both; the property is what matters.
    expect(returnReminders).toMatch(/const notified = await notifyFamily\(/);
    expect(returnReminders).toMatch(/if \(!notified \|\| stampError\) \{/);
    // The stamp is only written when the notification actually went out.
    expect(returnReminders).toMatch(/notified\s*\n?\s*\? await admin\.from\('marketplace_orders'\)\.update/);
    expect(returnReminders).toContain('stampError');
    expect(returnReminders).toContain('const ok = failed === 0;');
    expect(returnReminders).toContain('{ status: ok ? 200 : 502 }');
  });

  it('model refresh fails when dirty-state reads or writes fail', () => {
    expect(modelRefresh).toContain('dirtyRowsError');
    expect(modelRefresh).toContain('dirtyWriteError');
    expect(modelRefresh).toContain('dirtyWriteFailed');
  });
});
