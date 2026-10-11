// A school or sports window given as a zone-less time is the FAMILY's time.
//
// The planner's prompt defines times as "ISO 8601 in the family's time zone"
// and every school/sports template feeds `listEventsBetween`, `listHomeworkDue`
// and `listPracticesBetween` a `localTime(dayKey, h, m)` — `2026-10-12T00:00:00`
// with no zone. `resolveWindow` read it with `Date.parse`, i.e. on the HOST's
// clock (UTC on Vercel), so a Los Angeles family's "school day" ran from 5pm the
// evening before to 5pm: a 5:30pm practice was missed and the previous
// evening's reported, and a date-only from/to of one day was a zero-width
// window at UTC midnight. `calendar.createEvent` already reads the same strings
// in the family zone; now the reads do too.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { resolveWindow } from '@/lib/services/school';
import { listPracticesBetween } from '@/lib/services/sports';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const scope = (tz: string, db: unknown = {}): ServiceScope => ({
  db: db as SupabaseClient<Database>, familyId: 'fam-1', userId: 'user-1', memberId: 'mem-1', role: 'parent', actorKind: 'member', tz,
  now: new Date('2026-10-10T12:00:00Z'),
});

describe('resolveWindow reads a zone-less edge on the family clock', () => {
  it('a Los Angeles school day is the Los Angeles day', () => {
    expect(resolveWindow(scope('America/Los_Angeles'), { from: '2026-10-12T00:00:00', to: '2026-10-12T23:59:00' }))
      .toEqual({ ok: true, data: { from: '2026-10-12T07:00:00.000Z', to: '2026-10-13T06:59:00.000Z' } });
  });

  it('a Tokyo evening is the Tokyo evening', () => {
    expect(resolveWindow(scope('Asia/Tokyo'), { from: '2026-10-12T17:30:00', to: '2026-10-12T19:00' }))
      .toEqual({ ok: true, data: { from: '2026-10-12T08:30:00.000Z', to: '2026-10-12T10:00:00.000Z' } });
  });

  it('a bare date spans the whole family day, not a single UTC instant', () => {
    expect(resolveWindow(scope('America/Los_Angeles'), { from: '2026-10-12', to: '2026-10-12' }))
      .toEqual({ ok: true, data: { from: '2026-10-12T07:00:00.000Z', to: '2026-10-13T06:59:59.999Z' } });
    expect(resolveWindow(scope('Asia/Tokyo'), { from: '2026-10-12', to: '2026-10-13' }))
      .toEqual({ ok: true, data: { from: '2026-10-11T15:00:00.000Z', to: '2026-10-13T14:59:59.999Z' } });
  });

  it('crosses the Los Angeles fall-back correctly', () => {
    // 1 November 2026 is 25 hours long in Los Angeles.
    expect(resolveWindow(scope('America/Los_Angeles'), { from: '2026-11-01', to: '2026-11-01' }))
      .toEqual({ ok: true, data: { from: '2026-11-01T07:00:00.000Z', to: '2026-11-02T07:59:59.999Z' } });
  });

  it('keeps an offset or Z exactly as written, and the UTC control', () => {
    expect(resolveWindow(scope('America/Los_Angeles'), { from: '2026-10-12T00:00:00Z', to: '2026-10-12T23:59:00+02:00' }))
      .toEqual({ ok: true, data: { from: '2026-10-12T00:00:00.000Z', to: '2026-10-12T21:59:00.000Z' } });
    expect(resolveWindow(scope('UTC'), { from: '2026-10-12T00:00:00', to: '2026-10-12' }))
      .toEqual({ ok: true, data: { from: '2026-10-12T00:00:00.000Z', to: '2026-10-12T23:59:59.999Z' } });
  });

  it('refuses an impossible naive date or clock before any read', () => {
    for (const from of ['2026-02-30', '2026-02-30T09:00:00', '2026-10-12T25:00:00', '2026-10-12T09:60']) {
      expect(resolveWindow(scope('America/Los_Angeles'), { from }), from).toMatchObject({ ok: false, code: 'invalid_input' });
    }
  });
});

describe('listPracticesBetween finds the practice on the family\'s school day', () => {
  function seeded() {
    const db = createInMemorySupabase({ defaults: { sports_events: { recurrence: 'none', recurrence_until: null, ends_at: null, location: null } } });
    db.seed('sports_events', [
      // Sunday 11 October, 5:30pm in Los Angeles — the evening BEFORE the school day.
      { id: 'sunday', family_id: 'fam-1', member_id: 'mem-child', title: 'Sunday scrimmage', sport: 'soccer', team: 'Lions', event_type: 'practice', starts_at: '2026-10-12T00:30:00Z' },
      // Monday 12 October, 5:30pm in Los Angeles — the one the day plan is about.
      { id: 'monday', family_id: 'fam-1', member_id: 'mem-child', title: 'Monday practice', sport: 'soccer', team: 'Lions', event_type: 'practice', starts_at: '2026-10-13T00:30:00Z' },
    ]);
    return db;
  }

  it('reports Monday\'s 5:30pm practice for a Monday window, not Sunday\'s', async () => {
    const res = await listPracticesBetween(scope('America/Los_Angeles', seeded()), { from: '2026-10-12T00:00:00', to: '2026-10-12T23:59:00' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((e) => e.id)).toEqual(['monday']);
  });

  it('a date-only Monday is the same answer', async () => {
    const res = await listPracticesBetween(scope('America/Los_Angeles', seeded()), { from: '2026-10-12', to: '2026-10-12' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((e) => e.id)).toEqual(['monday']);
  });
});
