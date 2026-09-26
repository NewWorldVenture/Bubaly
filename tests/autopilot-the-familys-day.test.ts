import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { defaultReminderIso, runAutopilotScan, scanWindow } from '@/lib/autopilot/scan';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// The Autopilot scan opened with `new Date().toISOString().slice(0, 10)` and
// spent that one Greenwich key three ways: as a DATE-column bound, as a
// timestamptz bound spelled `${today}T00:00:00Z`, and as `snapshot.today`, from
// which the engine measures every "is it today or tomorrow?".
//
// Every case below FIXES BOTH THE INSTANT AND THE ZONE, because "unbound" is
// not a zone — it is whatever the host is set to, and a suite that leaves it
// unbound passes on a laptop in London and says nothing at all. Each zone is
// named, and for each one there is an instant where the family's day and
// Greenwich's day are DIFFERENT DAYS, which is the only situation in which the
// defect is visible:
//
//   America/Los_Angeles at 23:00 — Greenwich has already turned over, the
//                                  family has not. Their today is YESTERDAY's
//                                  Greenwich day.
//   Asia/Tokyo at 05:00          — the family has turned over, Greenwich has
//                                  not. Their today is TOMORROW's Greenwich day.
//
// UTC is kept as a control: the contract must hold there too, unchanged, or
// the fix has merely moved the error rather than removed it.
type Case = {
  tz: string;
  /** The instant the scan runs at. */
  now: string;
  /** The day on the family's kitchen wall at that instant. */
  familyToday: string;
  /** The day at Greenwich at the same instant — what the scan used to answer. */
  greenwichToday: string;
  /** A renewal expiring on the family's own today. */
  expiresToday: string;
  /** A renewal expiring exactly 30 of the FAMILY's days out — the edge of the window. */
  expiresIn30: string;
  /** A chore due at 20:00 on the family's YESTERDAY, as an instant. */
  choreDueLastNight: string;
  /**
   * An appointment on the family's TODAY, at an hour whose GREENWICH day is a
   * different day — late evening west of UTC, early morning east of it. This is
   * the half the engine consumes: `starts_at.slice(0, 10)` answers the day at
   * Greenwich, so "is it today?" came back "tomorrow", or came back nothing at
   * all because the day count went negative.
   */
  apptToday: string;
};

const CASES: Case[] = [
  {
    tz: 'UTC', now: '2026-09-21T06:00:00Z',
    familyToday: '2026-09-21', greenwichToday: '2026-09-21',
    expiresToday: '2026-09-21', expiresIn30: '2026-10-21',
    choreDueLastNight: '2026-09-20T20:00:00Z',
    apptToday: '2026-09-21T19:00:00Z', // 19:00 UTC — the control: one day, one answer
  },
  {
    // 23:00 on the 20th, PDT (UTC-7). Greenwich is already on the 21st.
    tz: 'America/Los_Angeles', now: '2026-09-21T06:00:00Z',
    familyToday: '2026-09-20', greenwichToday: '2026-09-21',
    expiresToday: '2026-09-20', expiresIn30: '2026-10-20',
    choreDueLastNight: '2026-09-20T03:00:00Z', // 20:00 on the 19th, PDT
    apptToday: '2026-09-21T02:00:00Z',        // 19:00 on the 20th, PDT — Greenwich calls it the 21st
  },
  {
    // 05:00 on the 22nd, JST (UTC+9). Greenwich is still on the 21st.
    tz: 'Asia/Tokyo', now: '2026-09-21T20:00:00Z',
    familyToday: '2026-09-22', greenwichToday: '2026-09-21',
    expiresToday: '2026-09-22', expiresIn30: '2026-10-22',
    choreDueLastNight: '2026-09-21T11:00:00Z', // 20:00 on the 21st, JST
    apptToday: '2026-09-21T22:00:00Z',        // 07:00 on the 22nd, JST — Greenwich calls it the 21st
  },
  // Both zones at an instant where they AGREE with Greenwich, so a "fix" that
  // simply shifted everything by a day cannot pass this file.
  {
    tz: 'America/Los_Angeles', now: '2026-09-21T20:00:00Z',
    familyToday: '2026-09-21', greenwichToday: '2026-09-21',
    expiresToday: '2026-09-21', expiresIn30: '2026-10-21',
    choreDueLastNight: '2026-09-21T03:00:00Z', // 20:00 on the 20th, PDT
    apptToday: '2026-09-22T02:00:00Z',        // 19:00 on the 21st, PDT — Greenwich calls it the 22nd
  },
];

/**
 * The test's own ruler: the wall clock in `tz` for an instant, read straight
 * from Intl rather than through the helper under test.
 */
function wall(instant: string, tz: string): { day: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number.parseInt(get('hour'), 10) % 24,
    minute: Number.parseInt(get('minute'), 10),
  };
}

/** Whole calendar days between two `YYYY-MM-DD` keys. Date-only, so no zone is involved. */
function daysBetween(from: string, to: string): number {
  const ms = (key: string) => {
    const [y, m, d] = key.split('-').map((part) => Number.parseInt(part, 10));
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

const HOUR = 3_600_000;

describe('the Autopilot scan window is the family’s, not Greenwich’s', () => {
  it.each(CASES)('$tz at $now — today is $familyToday', (c) => {
    const w = scanWindow(c.tz, new Date(c.now));
    expect(w.todayKey).toBe(c.familyToday);
    // The case is only worth anything if the two days really do differ, so
    // state which of the four cases are exercising the defect.
    expect(wall(c.now, c.tz).day).toBe(c.familyToday);
    expect(new Date(c.now).toISOString().slice(0, 10)).toBe(c.greenwichToday);
  });

  it.each(CASES)('$tz — every DATE bound counts whole days from the family’s today', (c) => {
    const w = scanWindow(c.tz, new Date(c.now));
    // Day-key arithmetic, so these are exact in every zone and on both sides of
    // a DST transition: they never touch an instant.
    expect(daysBetween(w.todayKey, w.in30Key)).toBe(30);
    expect(daysBetween(w.todayKey, w.horizonEndKey)).toBe(4);
    expect(daysBetween(w.since8Key, w.todayKey)).toBe(8);
    expect(daysBetween(w.since90Key, w.todayKey)).toBe(90);
  });

  it.each(CASES)('$tz — every timestamptz bound is a real midnight on the family’s clock', (c) => {
    const w = scanWindow(c.tz, new Date(c.now));
    for (const iso of [w.startIso, w.in3Iso, w.since90Iso]) {
      const at = wall(iso, c.tz);
      expect({ hour: at.hour, minute: at.minute }, iso).toEqual({ hour: 0, minute: 0 });
    }
    expect(wall(w.startIso, c.tz).day).toBe(c.familyToday);
    expect(daysBetween(c.familyToday, wall(w.in3Iso, c.tz).day)).toBe(3);
    expect(daysBetween(wall(w.since90Iso, c.tz).day, c.familyToday)).toBe(90);

    // The instant the scan runs at lies inside the day the scan calls today:
    // at or after this local midnight, and less than one (possibly 25-hour) day later.
    const elapsed = Date.parse(c.now) - Date.parse(w.startIso);
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(25 * HOUR);
  });

  it.each(CASES)('$tz — the fallback reminder is nine in the family’s morning', (c) => {
    expect(wall(defaultReminderIso(c.familyToday, c.tz), c.tz))
      .toEqual({ day: c.familyToday, hour: 9, minute: 0 });
  });
});

describe('a horizon crosses a 23- or 25-hour day without slipping', () => {
  // US DST in 2026: forward on 8 March, back on 1 November. Adding
  // 3 × 86_400_000 ms to a local midnight lands at 01:00 or 23:00 on the far
  // side of one of these, and formats as the wrong day exactly when the family
  // is most likely to notice.
  it.each([
    { label: 'fall back (a 25-hour day)', now: '2026-10-30T12:00:00Z', todayKey: '2026-10-30', endKey: '2026-11-02', hours: 73 },
    { label: 'spring forward (a 23-hour day)', now: '2026-03-06T12:00:00Z', todayKey: '2026-03-06', endKey: '2026-03-09', hours: 71 },
  ])('America/Los_Angeles, $label', ({ now, todayKey, endKey, hours }) => {
    const tz = 'America/Los_Angeles';
    const w = scanWindow(tz, new Date(now));
    expect(w.todayKey).toBe(todayKey);
    expect(wall(w.in3Iso, tz)).toEqual({ day: endKey, hour: 0, minute: 0 });
    // The proof that this is day-key arithmetic and not `+ 3 * 86_400_000`:
    // three local days here are NOT 72 hours.
    expect((Date.parse(w.in3Iso) - Date.parse(w.startIso)) / HOUR).toBe(hours);
  });
});

describe('the scan answers the family’s day end to end', () => {
  it.each(CASES)('$tz at $now', async (c) => {
    const db = createInMemorySupabase<SupabaseClient<Database>>({
      uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']] },
    });
    db.seed('renewals', [
      // `renewals.expires_at` is a DATE column (0033_renewals.sql:20): it holds
      // the day on the family's wall and is compared as it arrives.
      { id: 'r-today', family_id: 'f1', title: 'Passport', status: 'active', expires_at: c.expiresToday },
      { id: 'r-edge', family_id: 'f1', title: 'Car registration', status: 'active', expires_at: c.expiresIn30 },
    ]);
    db.seed('appointments', [
      // `appointments.starts_at` is timestamptz (0002_tables.sql:93). The day it
      // falls on is a question only the family's zone can answer.
      { id: 'a-today', family_id: 'f1', title: 'Dentist', starts_at: c.apptToday, member_id: null },
    ]);
    db.seed('chore_assignments', [
      // `chore_assignments.due_at` is timestamptz (0002_tables.sql:169): an
      // instant, overdue only once the family's own midnight has passed it.
      { id: 'c-late', family_id: 'f1', status: 'todo', due_at: c.choreDueLastNight, member_id: null, chore_id: null },
    ]);

    await runAutopilotScan(db, 'f1', 'u1', c.tz, new Date(c.now));
    const titles = db.table('autopilot_suggestions').map((row) => String(row.title));

    // A DATE column that says the family's today means TODAY. Read against
    // Greenwich's today this was "expires in 1 day" in Tokyo and had already
    // fallen out of the window altogether in Los Angeles.
    expect(titles).toContain('Passport expires today');
    // The far edge of the 30-day window is 30 of the FAMILY's days out. The
    // Greenwich bound cut a day off it east of UTC, so this row was never read.
    expect(titles).toContain('Car registration expires in 30 days');
    // A chore due during the family's own evening is overdue the next morning.
    // Bounded at Greenwich midnight it was still "not yet due" in Tokyo.
    expect(titles).toContain('Overdue: Chore');
    // The consumer half. This appointment is on the family's today at an hour
    // that belongs to a DIFFERENT Greenwich day, so an engine that slices the
    // instant instead of resolving it announces it as tomorrow's — or, east of
    // UTC, as yesterday's and therefore not at all.
    expect(titles).toContain('Dentist is today');
    expect(titles).not.toContain('Dentist is tomorrow');

    // The auto-created reminder fires at nine on the family's clock, not at
    // 09:00Z — which is two in the morning in Los Angeles.
    const reminders = db.table('reminders');
    expect(reminders).toHaveLength(1);
    expect(wall(String(reminders[0].remind_at), c.tz))
      .toEqual({ day: c.familyToday, hour: 9, minute: 0 });
  });
});
