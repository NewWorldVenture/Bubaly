// "Dismiss keeps a moment quiet for the rest of the day" is the promise made by
// the X on every card in the "Right now" band (components/moments/moment-organizer.tsx:6),
// by the action's own docstring ("Hide a moment for the rest of today") and by
// migration 0148's header ("a dismissed moment stays quiet for the day").
//
// The day the promise meant was the day at GREENWICH. `setMomentStatus` stamped
// `as_of_date` with `new Date().toISOString().slice(0, 10)` while the only reader
// of that table — /dashboard/moments — asks for
// `dayKeyInTz(now, family.timezone)`. Same feature, same unique key
// (0148: `unique (family_id, moment_key, as_of_date)`), two different days.
//
// Both signs bite, and differently:
//
//   WEST of Greenwich (an evening in New York or Los Angeles) the Greenwich day
//   is already TOMORROW. The dismissal lands in tomorrow's slot, so the card is
//   back on the next fresh load — and then it is wrongly SILENT for all of the
//   next local day, because the page's own log-back upsert passes
//   `ignoreDuplicates: true` (page.tsx:95-98) and cannot overwrite the stranded
//   'dismissed' row. That is the half that loses something: the family never
//   sees the moment on the day they did not dismiss it.
//
//   EAST of Greenwich (before dawn in Tokyo) the Greenwich day is still
//   YESTERDAY — a date the page will never query again — so the dismissal is
//   thrown away. `setMomentStatus` still returns `{ ok: true }`, so
//   moment-organizer.tsx shows no error toast and the card simply returns.
//
// What is asserted here is what a family sees on the screen: the band is
// RENDERED, the card is dismissed through the real server action, and the page
// is rendered again the way reopening it on a phone would. The Emergency card is
// used as the subject because `activeMoments` adds it unconditionally
// (lib/moments/organizer.ts:160), so the case does not depend on the host's
// clock — which matters, since page.tsx still feeds `activeMoments` the SERVER's
// wall-clock hour (a separate defect, not this one).
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'fam-1';
/** The Emergency card's reason line, as moment-organizer.tsx renders it. */
const EMERGENCY = 'Always one tap away';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  loadScheduleIntelligence: vi.fn(),
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/schedule/intelligence-server', () => ({
  loadScheduleIntelligence: mocks.loadScheduleIntelligence,
}));
// The event-prep list below the band is a different surface; keep it out of the
// markup so the only thing under test is the "Right now" band.
vi.mock('@/components/moments/moments-view', () => ({ MomentsView: () => null }));
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ success: () => {}, error: () => {}, info: () => {}, show: () => {} }),
}));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => ({ code: 'en-US' }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, back: () => {} }),
  usePathname: () => '/dashboard/moments',
  useSearchParams: () => new URLSearchParams(),
}));

const MomentsPage = (await import('@/app/(app)/dashboard/moments/page')).default;
const { dismissMomentAction } = await import('@/app/(app)/dashboard/moments/actions');

/**
 * The test's own ruler — straight from Intl, deliberately NOT the helper either
 * side of the code under test uses, so a defect in that helper cannot make the
 * expectation agree with it.
 */
function familyDayOf(instant: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(instant));
}

/** The Greenwich day for the same instant — the value the defect wrote. */
const greenwichDayOf = (instant: string) => new Date(instant).toISOString().slice(0, 10);

let db: ReturnType<typeof createInMemorySupabase>;

function useFamilyIn(tz: string) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1', email: 'parent@example.com' },
    memberships: [],
    active: {
      familyId: FAMILY,
      family: { id: FAMILY, timezone: tz },
      role: 'parent',
      member: { id: 'mem-1' },
    },
  });
}

/** One load of /dashboard/moments at a pinned instant, as HTML. */
async function openMomentsPageAt(instant: string): Promise<string> {
  vi.setSystemTime(new Date(instant));
  const tree = await MomentsPage();
  return renderToStaticMarkup(tree as React.ReactElement);
}

/** One tap of the X on a card, at a pinned instant. */
async function dismissAt(instant: string, momentKey: string) {
  vi.setSystemTime(new Date(instant));
  await expect(dismissMomentAction(momentKey), `dismiss at ${instant}`).resolves.toEqual({ ok: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({
    uniques: { moment_activations: [['family_id', 'moment_key', 'as_of_date']] },
  });
  mocks.createServer.mockResolvedValue(db);
  mocks.loadScheduleIntelligence.mockResolvedValue({ ok: true, data: { departures: {} } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a dismissed moment is quiet for the family's day", () => {
  it('stays gone for the rest of a New York evening, and comes back the next day', async () => {
    const tz = 'America/New_York';
    useFamilyIn(tz);

    const sundayEvening = '2026-09-21T00:40:00Z';   // Sunday 20:40 EDT
    const sundayLater = '2026-09-21T01:15:00Z';     // Sunday 21:15 EDT — same family day
    const mondayAfternoon = '2026-09-21T19:00:00Z'; // Monday 15:00 EDT — the NEXT family day

    // The preconditions that make this a real case rather than a tautology: the
    // evening falls on a family day the Greenwich clock has already left, and
    // Monday afternoon is the very day the Greenwich key would have claimed.
    expect(familyDayOf(sundayEvening, tz)).toBe('2026-09-20');
    expect(greenwichDayOf(sundayEvening)).toBe('2026-09-21');
    expect(familyDayOf(sundayLater, tz)).toBe('2026-09-20');
    expect(familyDayOf(mondayAfternoon, tz)).toBe('2026-09-21');

    expect(await openMomentsPageAt(sundayEvening), 'the card is there to dismiss').toContain(EMERGENCY);

    await dismissAt(sundayEvening, 'emergency');

    // Reopening the page half an hour later, from a phone: the promise is "quiet
    // for the rest of the day", and the rest of the day is still Sunday.
    expect(
      await openMomentsPageAt(sundayLater),
      'a moment dismissed on Sunday evening must stay quiet for the rest of Sunday',
    ).not.toContain(EMERGENCY);

    // And Monday is a new day, so the moment is offered again. Under the
    // Greenwich key the dismissal had been filed HERE, and page.tsx's log-back
    // upsert (ignoreDuplicates) could not overwrite it, so the card was silent
    // all day on a day nobody dismissed it.
    expect(
      await openMomentsPageAt(mondayAfternoon),
      "yesterday's dismissal must not silence the moment on the family's next day",
    ).toContain(EMERGENCY);

    // The row itself is filed on the day the family lived, once.
    const filed = db.table('moment_activations').filter((r) => r.moment_key === 'emergency');
    expect(filed.find((r) => r.status === 'dismissed')?.as_of_date).toBe('2026-09-20');
    expect(filed.some((r) => r.as_of_date === '2026-09-21' && r.status === 'dismissed')).toBe(false);
  });

  it('is not thrown away when a Tokyo family dismisses it before 09:00', async () => {
    const tz = 'Asia/Tokyo';
    useFamilyIn(tz);

    const schoolRun = '2026-09-21T22:30:00Z';   // Tuesday 07:30 JST
    const afterDropOff = '2026-09-21T23:10:00Z'; // Tuesday 08:10 JST — same family day

    // East of Greenwich the UTC day runs BEHIND: the morning is misfiled onto
    // yesterday, a date /dashboard/moments will never ask for again.
    expect(familyDayOf(schoolRun, tz)).toBe('2026-09-22');
    expect(greenwichDayOf(schoolRun)).toBe('2026-09-21');

    expect(await openMomentsPageAt(schoolRun)).toContain(EMERGENCY);

    await dismissAt(schoolRun, 'emergency');

    expect(
      await openMomentsPageAt(afterDropOff),
      'a dismissal that reported ok must not be discarded onto yesterday',
    ).not.toContain(EMERGENCY);

    const filed = db.table('moment_activations').filter((r) => r.moment_key === 'emergency');
    expect(filed.find((r) => r.status === 'dismissed')?.as_of_date).toBe('2026-09-22');
    expect(filed.some((r) => r.as_of_date === '2026-09-21' && r.status === 'dismissed')).toBe(false);
  });

  it('agrees with the reader for a family that never set a zone (UTC)', async () => {
    useFamilyIn('UTC');

    const evening = '2026-09-21T20:40:00Z';
    const later = '2026-09-21T21:15:00Z';

    expect(await openMomentsPageAt(evening)).toContain(EMERGENCY);
    await dismissAt(evening, 'emergency');
    expect(await openMomentsPageAt(later)).not.toContain(EMERGENCY);
    expect(
      db.table('moment_activations').find((r) => r.status === 'dismissed')?.as_of_date,
    ).toBe('2026-09-21');
  });
});
