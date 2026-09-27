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

  /**
   * The family's zone has to be resolved BEFORE the due-date decision, not just
   * before the send. This job is cross-family — one query, no family filter — so
   * a host-day answer decided for every household at once, and the dedupe stamps
   * are one-shot: a nudge sent against the wrong day does not arrive late, it
   * spends the only nudge that order will ever get.
   *
   * Pinned by ORDER, because the version this replaced already resolved the
   * scope — just one step too late to be the thing that answered "is this due
   * today".
   */
  it('return reminders decide the due date in the family\u2019s zone, before notifying', () => {
    expect(returnReminders).toContain("dayKeyInTz");
    expect(returnReminders).toMatch(/const todayKey = dayKeyInTz\(now, scope\.tz\)/);
    // Every due-date judgement takes the day key; none takes a raw instant.
    expect(returnReminders).toMatch(/needsOverdueAlert\(order, todayKey\)/);
    expect(returnReminders).toMatch(/needsDueReminder\(order, todayKey\)/);
    expect(returnReminders).not.toMatch(/needs(OverdueAlert|DueReminder)\(order, now\)/);
    expect(returnReminders).not.toMatch(/daysUntilDue\(o\.ends_on, now\)/);
    // And the resolve precedes the first decision in the file.
    const resolved = returnReminders.indexOf('const todayKey = dayKeyInTz');
    const firstDecision = returnReminders.indexOf('needsOverdueAlert(order,');
    expect(resolved).toBeGreaterThan(-1);
    expect(resolved).toBeLessThan(firstDecision);
    // A family whose zone cannot be read is a FAILURE, not a guess against UTC.
    expect(returnReminders).toMatch(/if \(!scope\) \{[\s\S]*?failed\+\+;[\s\S]*?continue;/);
  });

  it('model refresh fails when dirty-state reads or writes fail', () => {
    expect(modelRefresh).toContain('dirtyRowsError');
    expect(modelRefresh).toContain('dirtyWriteError');
    expect(modelRefresh).toContain('dirtyWriteFailed');
  });
});
