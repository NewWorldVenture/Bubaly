import { at } from './helpers/source-order';
import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import { readFileSync } from 'node:fs';

// A-13 — the Vacations list and calendar both read `vacations` (their primary
// source-of-truth) via useRealtimeQuery. Both previously dropped the hook's
// `error`, so a genuine (non-missing-table, online) failure rendered the list
// as the misleading "No trips yet" empty state and the calendar as an empty
// month (plus a silently-empty .ics export) — a family's planned trips appear
// to have vanished. Both must surface a retryable ErrorState.
const list = readFileSync('components/vacations/vacations-list.tsx', 'utf8');
const cal = readFileSync('components/vacations/vacations-calendar.tsx', 'utf8');

describe('vacations-list surfaces the primary read failure', () => {
  it('captures error + refresh from the vacations query', () => {
    expect(list).toMatch(/const \{ data: trips, loading, error, refresh \} = useRealtimeQuery/);
  });
  it('renders a retryable ErrorState before the empty state', () => {
    expect(list).toContain('readError ? (');
    expect(list).toContain("<ErrorState message={");
    expectSays(list, 'vacationsList.couldNotLoadYourTrips', "Could not load your trips. Refresh and try again.");
    // the error branch must precede the empty-state JSX (anchor on the
    // component, not the comment text which also mentions "No trips yet")
    expect(at(list, 'readError ? (')).toBeLessThan(at(list, '<EmptyState icon={Plane}'));
  });

  // The list also reads the members on each trip and the readiness score shown
  // on its ring. Those started out dropping their errors, so a card could
  // render a trip with no travellers and no readiness and look finished. The
  // gate above now covers all three, and the retry re-runs all three.
  it('gates on the members and readiness reads too', () => {
    expect(list).toMatch(/const readError = error \|\| vmembersError \|\| scoresError;/);
    expect(list).toMatch(/const \{ data: vmembers, error: vmembersError, refresh: refreshMembers \}/);
    expect(list).toMatch(/const \{ data: scores, error: scoresError, refresh: refreshScores \}/);
    expect(list).toContain('void refresh(); void refreshMembers(); void refreshScores();');
  });
});

describe('vacations-calendar surfaces the read failure', () => {
  it('captures error + refresh from the vacations query', () => {
    expect(cal).toMatch(/const \{ data: trips, error, refresh \} = useRealtimeQuery/);
  });
  it('gates the calendar on a retryable ErrorState', () => {
    expect(cal).toContain('if (error) {');
    expect(cal).toContain('onRetry={refresh}');
  });
});
