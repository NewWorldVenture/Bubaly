import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const decisionsSource = readFileSync('components/modules/decisions-module.tsx', 'utf8');
const visitsSource = readFileSync('components/modules/health-visits-module.tsx', 'utf8');
const announcementsSource = readFileSync('components/modules/announcements-module.tsx', 'utf8');
const contactsSource = readFileSync('components/modules/contacts-module.tsx', 'utf8');
const screenTimeSource = readFileSync('components/modules/screen-time-module.tsx', 'utf8');
const celebrationsSource = readFileSync('components/modules/celebrations-module.tsx', 'utf8');
const binderSource = readFileSync('components/modules/binder-module.tsx', 'utf8');

describe('household read boundaries', () => {
  it('coordinates decision and option failures before the Decision Engine empty state', () => {
    expect(decisionsSource).toContain('error: decisionsError, refresh: refreshDecisions');
    expect(decisionsSource).toContain('error: optionsError, refresh: refreshOptions');
    expect(decisionsSource).toContain('Could not load decision data. Refresh and try again.');
    expect(decisionsSource).toContain('void refreshDecisions(); void refreshOptions();');
  });

  it('surfaces health-visit read failures before the empty history state', () => {
    expect(visitsSource).toContain('error, refresh } = useRealtimeQuery');
    expect(visitsSource).toContain('Could not load health visits. Refresh and try again.');
    expect(visitsSource).toContain('onRetry={refresh}');
  });

  it('coordinates announcements and read receipts with one retry action', () => {
    expect(announcementsSource).toContain('error: announcementsError, refresh: refreshAnnouncements');
    expect(announcementsSource).toContain('error: readsError, refresh: refreshReads');
    expect(announcementsSource).toContain('void refreshAnnouncements(); void refreshReads();');
    expect(announcementsSource).toContain('Could not load announcements. Refresh and try again.');
  });

  it('surfaces contacts, screen-time, celebrations, and binder read failures', () => {
    expect(contactsSource).toContain('<ErrorState message={error} onRetry={refresh} />');
    expect(screenTimeSource).toContain('error: entriesError, refresh: refreshEntries');
    expect(screenTimeSource).toContain('error: limitsError, refresh: refreshLimits');
    expect(screenTimeSource).toContain('Could not load screen time data. Refresh and try again.');
    expect(celebrationsSource).toContain('Could not load celebrations. Refresh and try again.');
    expect(binderSource).toContain('Could not load household binder data. Refresh and try again.');
  });
});
