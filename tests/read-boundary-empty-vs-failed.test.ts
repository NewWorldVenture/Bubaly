// Three more pages that answered a failed read with an empty state.
//
// Same defect as the four money pages, in three places where the false claim
// costs something different:
//
//   Calendar sync   "No calendars subscribed yet."  → the family's feeds look
//                   deleted, and the obvious response is to subscribe again,
//                   duplicating every one they already had.
//   Listing Q&A     "No questions yet"              → a seller stops checking a
//                   question a buyer really did ask.
//   Moments         "Nothing on the horizon"        → the page whose entire job
//                   is "what to get ready for" says there is nothing.
//
// Rendered through the query hook's states rather than grepped, so what is
// under test is what the page puts on screen.
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

type QueryState = { data: unknown[]; loading: boolean; error: string | null };
const state = vi.hoisted(() => ({ current: { data: [], loading: false, error: null } as QueryState }));
const refreshes = vi.hoisted(() => ({ count: 0 }));
const probeRetry = vi.hoisted(() => ({ on: false }));

vi.mock('@/components/app/app-context', () => ({
  useApp: () => ({
    familyId: 'fam-1',
    userId: 'user-1',
    members: [{ id: 'mem-1', display_name: 'Alex', color: '#7c3aed', role: 'parent' }],
    selfMember: { id: 'mem-1', display_name: 'Alex' },
  }),
}));
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: () => ({
    ...state.current,
    refresh: () => { refreshes.count += 1; },
    setData: () => {},
  }),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ success: () => {}, error: () => {}, info: () => {}, show: () => {} }),
}));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => (key: string) => MESSAGES[key] ?? key,
  useLocale: () => 'en-US',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, back: () => {} }),
  usePathname: () => '/dashboard/moments',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/moments/use-default-forecast', () => ({ useDefaultForecast: () => ({}) }));
vi.mock('@/app/(app)/dashboard/sync/feeds/actions', () => ({
  addCalendarFeed: async () => ({ ok: true }),
  syncCalendarFeed: async () => ({ ok: true }),
  removeCalendarFeed: async () => ({ ok: true }),
}));
vi.mock('@/app/(app)/dashboard/moment-actions', () => ({
  loadMomentPrep: async () => ({ ok: true, done: [] }),
  setMomentPrepDoneAction: async () => ({ ok: true }),
  createMomentReminderAction: async () => ({ ok: true }),
  addMomentGroceryAction: async () => ({ ok: true }),
  removeMomentGroceryAction: async () => ({ ok: true }),
}));
vi.mock('@/components/ui/states', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/states')>();
  return {
    ...actual,
    ErrorState: ({ message, onRetry }: { message: string; onRetry?: () => void }) => {
      if (probeRetry.on) onRetry?.();
      return actual.ErrorState({ message, onRetry });
    },
  };
});

const { CalendarSyncPanel } = await import('@/components/dashboard/calendar-sync-panel');
const { ListingQuestions } = await import('@/components/marketplace/listing-questions');
const { MomentsView } = await import('@/components/moments/moments-view');

function render(element: React.ReactElement, next: QueryState) {
  state.current = next;
  return renderToStaticMarkup(element);
}

const PAGES = [
  {
    name: 'Calendar sync',
    element: React.createElement(CalendarSyncPanel),
    errorKey: 'calendarSync.couldNotLoadCalendars',
    english: 'Could not load subscribed calendars. Refresh and try again.',
    emptyKey: 'calendarSync.noCalendarsSubscribedYet',
  },
  {
    name: 'Listing questions',
    element: React.createElement(ListingQuestions, { listingId: 'listing-1', isOwner: true }),
    errorKey: 'listingQuestions.couldNotLoadQuestions',
    english: 'Could not load questions. Refresh and try again.',
    emptyKey: 'listingQuestions.noQuestionsYet',
  },
  {
    name: 'Moments',
    element: React.createElement(MomentsView),
    errorKey: 'momentsView.couldNotLoadMoments',
    english: 'Could not load upcoming moments. Refresh and try again.',
    emptyKey: 'moments.nothingOnTheHorizon',
  },
];

describe('a failed read is not an empty list', () => {
  it.each(PAGES)('$name says the read failed', ({ element, errorKey, english }) => {
    expect(MESSAGES[errorKey], `${errorKey} should still say "${english}"`).toBe(english);
    const html = render(element, { data: [], loading: false, error: 'network down' });
    expect(html, `${errorKey} never reached the page`).toContain(english);
    expect(html, 'a failed read must offer a way back').toContain('Try again');
  });

  it.each(PAGES)('$name does not also claim emptiness', ({ element, emptyKey }) => {
    const empty = MESSAGES[emptyKey];
    expect(empty, `${emptyKey} is missing from the catalogue`).toBeTruthy();
    const html = render(element, { data: [], loading: false, error: 'network down' });
    expect(html, `"${empty}" is a claim the page cannot support`).not.toContain(empty);
  });

  it.each(PAGES)('$name still shows its empty state when the read succeeds', ({ element, emptyKey, english }) => {
    // The distinction is only worth anything if a real empty list still says so.
    const html = render(element, { data: [], loading: false, error: null });
    expect(html, 'a genuinely empty list must still say so').toContain(MESSAGES[emptyKey]);
    expect(html, 'nothing failed, so nothing should be reported as failed').not.toContain(english);
  });

  it.each(PAGES)('$name hands ErrorState a retry that calls refresh', ({ element }) => {
    probeRetry.on = true;
    const before = refreshes.count;
    try {
      render(element, { data: [], loading: false, error: 'network down' });
    } finally {
      probeRetry.on = false;
    }
    expect(refreshes.count, 'the retry did not reach the query hook').toBeGreaterThan(before);
  });
});
