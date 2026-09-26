// The Conflicts screen's one write button, "Apply & reschedule", used to report
// success for a move that never happened.
//
// `rescheduleEventAction` issued its own
// `.update({starts_at, ends_at}).eq('id', …).eq('family_id', …)` and branched on
// `error` alone. A PATCH that matches zero rows is not an error in PostgREST —
// driving the repo's own postgrest-js (2.108.2) against a stub server that
// answers a PATCH of a missing row the way PostgREST does:
//
//   BARE UPDATE (old code)     -> {"error":null,"status":204,"count":null}
//   WITH count:exact           -> {"error":null,"status":204,"count":0}
//   WITH .select().maybeSingle -> {"error":null,"data":null,"status":200}
//
// so the action could not tell a move from a miss and returned `{ok: true}`
// either way. `components/family/conflict-resolver.tsx` then calls `onResolved()`
// on `r.ok`, which adds the conflict's key to a client `useState` set that the
// `revalidatePath` refresh does not clear — so the card stayed gone for the rest
// of the session, and when it was the only one the page read "All conflicts
// handled". Dad's phone said the double-booking was fixed; piano still overlapped
// soccer, and nobody was dispatched.
//
// Zero rows is the ORDINARY outcome of a stale quick fix, not an exotic one. The
// ids are read at page render, and two things invalidate them while the tab sits
// open: a calendar feed removed and re-added (calendar_events.feed_id is
// ON DELETE CASCADE — supabase/migrations/0045_calendar_feeds.sql — and the
// re-import lands the same external_uid under a NEW row id, so the overlap
// survives with a different id), and the active family moving in another tab.
// RLS is no help: a row the policy filters yields zero rows, not an exception.
//
// These cases drive the REAL server action against an in-memory Postgres, with
// the REAL detector and quick-fix math the page uses (lib/family/conflicts), and
// ask the question the family would ask afterwards: is the clash still there?
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { detectConflicts, quickFixMoveAfter, type TimedEvent } from '@/lib/family/conflicts';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import { rescheduleEventAction } from '@/app/(app)/dashboard/conflicts/actions';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
/** The sentence the family must read instead of a silent success. */
const NOT_FOUND = MESSAGES['actions.thatEventCouldNotBe'];

const FAMILY = 'family-1';
const OTHER_FAMILY = 'family-2';
const SOCCER = '11111111-1111-4111-8111-111111111111';
const PIANO = '22222222-2222-4222-8222-222222222222';
/** The id the same piano lesson comes back under after a feed is re-added. */
const PIANO_REIMPORTED = '33333333-3333-4333-8333-333333333333';

const SOCCER_STARTS = '2026-03-03T17:00:00.000Z';
const SOCCER_ENDS = '2026-03-03T17:45:00.000Z';
const PIANO_STARTS = '2026-03-03T17:30:00.000Z';
const PIANO_ENDS = '2026-03-03T18:30:00.000Z';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

function seedTheClash() {
  db.seed('calendar_events', [
    { id: SOCCER, family_id: FAMILY, title: 'Soccer practice', starts_at: SOCCER_STARTS, ends_at: SOCCER_ENDS },
    { id: PIANO, family_id: FAMILY, title: 'Piano lesson', starts_at: PIANO_STARTS, ends_at: PIANO_ENDS },
  ]);
}

/** The family's own calendar, shaped the way the Conflicts page reads it. */
function calendarOf(familyId: string): TimedEvent[] {
  return db.table('calendar_events')
    .filter((r) => r.family_id === familyId)
    .map((r) => ({
      id: r.id as string, title: r.title as string,
      starts_at: r.starts_at as string, ends_at: (r.ends_at ?? null) as string | null,
      all_day: Boolean(r.all_day),
    }));
}

/** What the page puts on the button: the real detector, the real quick-fix math. */
function theQuickFixOnScreen() {
  const conflicts = detectConflicts(calendarOf(FAMILY));
  expect(conflicts, 'the fixture is meant to overlap').toHaveLength(1);
  const fix = quickFixMoveAfter(conflicts[0]!);
  expect(fix, 'the fixture is meant to have a one-tap fix').toBeTruthy();
  return fix!;
}

function rowById(id: string) {
  return db.table('calendar_events').find((r) => r.id === id);
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      calendar_events: {
        description: null, location: null, ends_at: null, all_day: false,
        category: 'general', recurrence: 'none', recurrence_until: null,
        assignee_id: null, idempotency_key: null,
      },
    },
  });
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: {
      familyId: FAMILY, role: 'parent',
      family: { name: 'Family One', timezone: 'America/New_York' },
      member: { id: 'member-1' },
    },
  });
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => vi.restoreAllMocks());

describe('a reschedule that moved nothing is not a resolved conflict', () => {
  it('refuses when the event was re-imported under a new id, and the clash is still on screen', async () => {
    seedTheClash();
    const fix = theQuickFixOnScreen();
    expect(fix.eventId, 'the quick fix moves the later event').toBe(PIANO);

    // Mom removes and re-adds the school feed in another tab. The cascade takes
    // the piano row out and the re-import puts the same lesson back under a new
    // id. The overlap is untouched; only the id Dad's open tab holds is stale.
    db.replace('calendar_events', db.table('calendar_events').filter((r) => r.id !== PIANO));
    db.seed('calendar_events', [
      { id: PIANO_REIMPORTED, family_id: FAMILY, title: 'Piano lesson', starts_at: PIANO_STARTS, ends_at: PIANO_ENDS },
    ]);

    const result = await rescheduleEventAction(fix.eventId, fix.startsAtIso, fix.endsAtIso);

    // What the card does with this is `if (r.ok) onResolved()`, so ok:true is
    // the whole defect: it hides the conflict for the rest of the session.
    expect(result.ok, 'reported the move as done').toBe(false);
    expect(result.error, 'refused without telling the family why').toBe(NOT_FOUND);

    // And the thing the family actually cares about: piano still clashes with
    // soccer, so the screen keeps showing the card it was about to hide.
    const survivor = rowById(PIANO_REIMPORTED)!;
    expect(survivor.starts_at).toBe(PIANO_STARTS);
    const stillConflicting = detectConflicts(calendarOf(FAMILY));
    expect(stillConflicting).toHaveLength(1);
    expect(stillConflicting[0]!.overlapMinutes).toBe(15);
  });

  it('refuses when the active family moved between render and tap, and touches nothing over there', async () => {
    seedTheClash();
    const fix = theQuickFixOnScreen();
    // A parent in two households: the second tab switched the active family, so
    // the write now carries family-2 while the card was drawn from family-1.
    mocks.requireUserContext.mockResolvedValue({
      user: { id: 'user-1' },
      active: {
        familyId: OTHER_FAMILY, role: 'parent',
        family: { name: 'Family Two', timezone: 'America/New_York' },
        member: { id: 'member-9' },
      },
    });

    const result = await rescheduleEventAction(fix.eventId, fix.startsAtIso, fix.endsAtIso);

    expect(result.ok, "marked the first household's clash resolved").toBe(false);
    expect(result.error).toBe(NOT_FOUND);
    expect(rowById(PIANO)!.starts_at, 'the first household was edited from the wrong context').toBe(PIANO_STARTS);
    expect(detectConflicts(calendarOf(FAMILY)), 'the clash the card was about is still live').toHaveLength(1);
  });

  it('still applies a live quick fix: the lesson really moves and the clash goes away', async () => {
    seedTheClash();
    const fix = theQuickFixOnScreen();

    const result = await rescheduleEventAction(fix.eventId, fix.startsAtIso, fix.endsAtIso);

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    const piano = rowById(PIANO)!;
    expect(piano.starts_at).toBe(fix.startsAtIso);
    expect(piano.ends_at).toBe(fix.endsAtIso);
    // Right after soccer ends, which is what the button promised.
    expect(piano.starts_at).toBe(SOCCER_ENDS);
    expect(detectConflicts(calendarOf(FAMILY)), 'the overlap should be gone').toHaveLength(0);
  });

  it('leaves the household trail an identical edit from the Calendar page leaves', async () => {
    seedTheClash();
    const fix = theQuickFixOnScreen();

    await rescheduleEventAction(fix.eventId, fix.startsAtIso, fix.endsAtIso);

    // The hand-rolled write recorded nothing, so a reschedule applied from the
    // Conflicts screen was invisible to an operator reading the trail while the
    // same change made on the Calendar page was not.
    const trail = db.table('audit_logs').filter((r) => r.family_id === FAMILY);
    expect(trail, 'the reschedule left no trail').toHaveLength(1);
    expect(trail[0]!.action).toBe('update');
    expect(trail[0]!.resource).toBe('calendar');
    expect(trail[0]!.actor_id).toBe('user-1');
  });

  it('refuses an end that lands before its start rather than storing it', async () => {
    seedTheClash();

    const result = await rescheduleEventAction(PIANO, PIANO_ENDS, PIANO_STARTS);

    expect(result.ok, 'stored an event that ends before it starts').toBe(false);
    expect(rowById(PIANO)!.starts_at).toBe(PIANO_STARTS);
  });
});
