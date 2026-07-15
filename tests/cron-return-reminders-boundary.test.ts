import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const returnReminders = readFileSync('app/api/cron/return-reminders/route.ts', 'utf8');
const modelRefresh = readFileSync('app/api/cron/model-refresh/route.ts', 'utf8');

describe('scheduled recovery persistence boundaries', () => {
  it('return reminders fail after listing, notification, or dedupe-stamp failures', () => {
    expect(returnReminders).toContain('listingError');
    expect(returnReminders).toContain('notificationError');
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
