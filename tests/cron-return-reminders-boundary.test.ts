import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { at, bodyOf } from './helpers/source-order';

const returnReminders = readFileSync('app/api/cron/return-reminders/route.ts', 'utf8');
const modelRefresh = readFileSync('app/api/cron/model-refresh/route.ts', 'utf8');

describe('scheduled recovery persistence boundaries', () => {
  it('return reminders fail after listing, notification, or dedupe-stamp failures', () => {
    expect(returnReminders).toContain('listingError');
    // A notification that did not go out must COUNT as a failure, so the cron
    // reports 502 instead of a clean run — and it must not leave
    // `overdue_notified_at` / `due_reminder_sent_at` stamped on an order nobody
    // was told about, which would suppress the nudge forever. The stamp is now
    // a CLAIM taken before the send (fenced on the column being unset, so two
    // overlapping runs cannot both send) and handed back when the send did not
    // go out; the property — stamped only when told, failed when not — is what
    // matters, and both halves are pinned.
    expect(returnReminders).toMatch(/const notified = await notifyFamily\(/);
    // The claim is confirmed by its rows and precedes the send; a refused claim
    // is a failure, a lost one is another run's.
    expect(returnReminders).toMatch(/\.update\(stampPatch\(column, nowIso\)\)\.eq\('id', orderId\)\.is\(column, null\)\.select\('id'\)/);
    for (const column of ['overdue_notified_at', 'due_reminder_sent_at'] as const) {
      const branch = bodyOf(returnReminders, `const claim = await claimStamp('${column}', o.id);`, `await restoreStamp('${column}', o.id);`);
      expect(branch).toContain("if (claim === 'error') { failed++; continue; }");
      expect(branch).toContain("if (claim === 'taken') continue;");
      expect(branch).toContain('const notified = await notifyFamily(');
      // Not told → the claim is handed back AND the run fails.
      expect(branch).toMatch(/if \(!notified\) \{[\s\S]*?await restoreStamp\('/);
      expect(returnReminders.slice(at(returnReminders, `await restoreStamp('${column}', o.id);`)).split('\n').slice(0, 3).join('\n')).toContain('failed++;');
    }
    // The hand-back is fenced on this run's own stamp, and confirmed.
    expect(returnReminders).toMatch(/\.update\(stampPatch\(column, null\)\)\.eq\('id', orderId\)\.eq\(column, nowIso\)\.select\('id'\)/);
    // Delivered means a row for THIS identity exists, not merely that notify() answered ok.
    expect(returnReminders).toContain('return sent.ok && (sent.data.created > 0 || sent.data.duplicates > 0);');
    // The overdue alert has its own identity and is said once; the due-soon nudge its own.
    expect(returnReminders).toContain("relatedType: 'marketplace_orders', relatedId: `${o.id}:overdue`, once: true,");
    expect(returnReminders).toContain("relatedType: 'marketplace_orders', relatedId: `${o.id}:due`,");
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
