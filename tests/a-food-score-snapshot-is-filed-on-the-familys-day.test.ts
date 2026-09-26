// `snapshotFoodScoreAction` stamped `snapshot_date` with
// `new Date().toISOString().slice(0, 10)` — the day at GREENWICH, which is not
// the day on the family's kitchen wall for a large and predictable slice of
// every day (7h in Los Angeles, 10h in Sydney, with opposite signs).
//
// A wrong label would be bad enough. What makes this destructive is the write
// itself: `upsert(..., { onConflict: 'family_id,snapshot_date' })` against
// `UNIQUE (family_id, snapshot_date)` (supabase/migrations/0102_food_os.sql:57).
// A misdated row does not sit harmlessly beside the right one — it OCCUPIES A
// NEIGHBOURING DAY'S SLOT, and the next save on that neighbouring day overwrites
// it. Two calendar days of a once-a-day history collapse into one row, the
// survivor is mislabelled, and `FoodScoreCard.save()` toasts
// `kitchenDashboard.foodScoreSaved` for both of them
// (components/modules/kitchen-dashboard.tsx:179-187). `family_food_scores` is
// the only record of the Family Food Health Score, so the lost snapshot is gone
// for good.
//
// This asserts the outcome a family sees: two evenings of saving produce two
// snapshots, each carrying the day the family actually lived, and /dashboard/food
// (which reads the newest by `snapshot_date DESC LIMIT 1`, food/page.tsx:109-110)
// shows the one from today rather than one from a day nobody has reached yet.
//
// BOTH SIGNS ARE TESTED. West of Greenwich the UTC day runs AHEAD of the
// family's, so it is the EVENING save that is misfiled, onto tomorrow. East of
// it the UTC day runs BEHIND, so it is the MORNING save that is misfiled, onto
// yesterday. A suite that only checked Los Angeles would let the Sydney half of
// the defect through.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { snapshotFoodScoreAction } = await import('@/app/(app)/dashboard/kitchen/actions');

const FAMILY = 'fam-1';

/**
 * The test's own ruler, straight from Intl and deliberately NOT the helper the
 * action uses — so a defect in that helper cannot make the expectation agree
 * with it.
 */
function familyDayOf(instant: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(instant));
}

/** The Greenwich day for the same instant — the value the defect wrote. */
const greenwichDayOf = (instant: string) => new Date(instant).toISOString().slice(0, 10);

type Db = ReturnType<typeof createInMemorySupabase>;
let db: Db;

function useFamilyIn(tz: string) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'parent-1', email: 'parent@example.com' },
    active: { familyId: FAMILY, family: { id: FAMILY, timezone: tz }, role: 'parent', member: {} },
    memberships: [],
  });
}

/** One tap of Save on /dashboard/kitchen, at a pinned instant. */
async function saveAt(instant: string, overall: number) {
  vi.setSystemTime(new Date(instant));
  const result = await snapshotFoodScoreAction({
    overall, grade: overall >= 80 ? 'A' : 'D', subScores: [], coaching: [],
  });
  expect(result, `save at ${instant} should succeed`).toEqual({ ok: true });
}

/** What /dashboard/food reads: the newest snapshot, `snapshot_date DESC LIMIT 1`. */
function newestSnapshot() {
  return [...db.table('family_food_scores')]
    .sort((a, b) => String(b.snapshot_date).localeCompare(String(a.snapshot_date)))[0];
}

function snapshotOn(day: string) {
  return db.table('family_food_scores').find((r) => r.snapshot_date === day);
}

beforeEach(() => {
  vi.useFakeTimers();
  db = createInMemorySupabase({ uniques: { family_food_scores: [['family_id', 'snapshot_date']] } });
  mocks.createServer.mockResolvedValue(db);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a food score snapshot is filed on the family's day", () => {
  it('keeps Sunday evening and Monday morning as two snapshots in Los Angeles', async () => {
    const tz = 'America/Los_Angeles';
    useFamilyIn(tz);

    const sundayEvening = '2026-09-21T01:30:00Z';  // Sunday 18:30 PDT
    const mondayMorning = '2026-09-21T16:00:00Z';  // Monday 09:00 PDT

    // The precondition that makes this a real test rather than a tautology: the
    // two saves fall on DIFFERENT family days but the SAME Greenwich day, so the
    // old key collapsed them and the family key cannot.
    expect(familyDayOf(sundayEvening, tz)).toBe('2026-09-20');
    expect(familyDayOf(mondayMorning, tz)).toBe('2026-09-21');
    expect(greenwichDayOf(sundayEvening)).toBe(greenwichDayOf(mondayMorning));

    await saveAt(sundayEvening, 88);
    await saveAt(mondayMorning, 61);

    // Two days lived, two snapshots kept. Under the Greenwich key both saves hit
    // one row and Sunday's 88 was overwritten by Monday's 61.
    expect(db.table('family_food_scores')).toHaveLength(2);
    expect(snapshotOn('2026-09-20')?.overall).toBe(88);
    expect(snapshotOn('2026-09-21')?.overall).toBe(61);

    // And nothing is filed on a day the family has not reached.
    expect(snapshotOn('2026-09-22')).toBeUndefined();

    // /dashboard/food shows Monday's score, on Monday.
    expect(newestSnapshot()?.snapshot_date).toBe('2026-09-21');
    expect(newestSnapshot()?.overall).toBe(61);
  });

  it('keeps Monday afternoon and Tuesday morning as two snapshots in Sydney', async () => {
    const tz = 'Australia/Sydney';
    useFamilyIn(tz);

    const mondayAfternoon = '2026-09-21T05:00:00Z';  // Monday 15:00 AEST
    const tuesdayMorning = '2026-09-21T23:00:00Z';   // Tuesday 09:00 AEST

    expect(familyDayOf(mondayAfternoon, tz)).toBe('2026-09-21');
    expect(familyDayOf(tuesdayMorning, tz)).toBe('2026-09-22');
    // East of Greenwich the misfiling runs the other way: Tuesday morning's
    // Greenwich day is still MONDAY, so it landed on Monday's row.
    expect(greenwichDayOf(tuesdayMorning)).toBe('2026-09-21');

    await saveAt(mondayAfternoon, 74);
    await saveAt(tuesdayMorning, 90);

    expect(db.table('family_food_scores')).toHaveLength(2);
    expect(snapshotOn('2026-09-21')?.overall).toBe(74);
    expect(snapshotOn('2026-09-22')?.overall).toBe(90);
    expect(newestSnapshot()?.snapshot_date).toBe('2026-09-22');
    expect(newestSnapshot()?.overall).toBe(90);
  });

  it('still overwrites the same day when the family saves twice in one day', async () => {
    // The table is one row per family per day by design, so re-saving must
    // UPDATE. This is the half a fix could break by keying on something finer.
    const tz = 'America/Los_Angeles';
    useFamilyIn(tz);

    await saveAt('2026-09-21T16:00:00Z', 61);  // Monday 09:00 PDT
    await saveAt('2026-09-22T03:00:00Z', 77);  // Monday 20:00 PDT

    expect(db.table('family_food_scores')).toHaveLength(1);
    expect(snapshotOn('2026-09-21')?.overall).toBe(77);
  });

  // WHAT THIS CASE IS AND IS NOT. It is NOT evidence for the fix: with no usable
  // zone the only defensible day is Greenwich's, which is exactly what the old
  // code wrote, so this passes with the fix reverted — by construction, not by
  // accident. The three cases above carry the fix. This one guards a DIFFERENT
  // regression that a fix could introduce: resolving the zone by handing it to
  // Intl without a fallback. Intl throws RangeError for an unusable name (the
  // precondition below proves it for each input), and that would escape the
  // action and fail the parent's tap instead of saving.
  //
  // The two inputs reach two different branches, so both are pinned: '' is
  // turned into 'UTC' by the action's own `|| 'UTC'` and never reaches the
  // helper; a non-empty garbage name gets past that and lands in the helper's
  // catch. The page that computes the score (kitchen/page.tsx:30-31) falls back
  // the same way, so even here the snapshot is filed on the day it was scored for.
  it.each([
    ['an empty zone', ''],
    ['a zone name Intl rejects', 'Mars/Olympus_Mons'],
  ])('still saves, on the Greenwich day, for %s', async (_label, zone) => {
    expect(() => new Intl.DateTimeFormat('en-CA', { timeZone: zone })).toThrow(RangeError);
    useFamilyIn(zone);

    const instant = '2026-09-21T01:30:00Z';
    await saveAt(instant, 55);

    expect(db.table('family_food_scores')).toHaveLength(1);
    expect(snapshotOn(greenwichDayOf(instant))?.overall).toBe(55);
  });
});
