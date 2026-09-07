import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';

const syncSource = readUiSource('app/(app)/dashboard/sync/page.tsx');
const historySource = readUiSource('app/(app)/dashboard/sync/history/page.tsx');

describe('family sync read boundary', () => {
  it('fails closed when sync health or history reads fail', () => {
    expect(syncSource).toContain('const readError = connections.error ?? calendars.error ?? openConflicts.error ?? recentRuns.error');
    expect(syncSource).toContain('Could not load your sync status from Supabase');
    expect(syncSource).toContain('Refresh sync status');
    expect(historySource).toContain('const readError = runsRes.error ?? auditRes.error');
    expect(historySource).toContain('Could not load your sync history from Supabase');
    expect(historySource).toContain('Refresh sync history');
  });
});
