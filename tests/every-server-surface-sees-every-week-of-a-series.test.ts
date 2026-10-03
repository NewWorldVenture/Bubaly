import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { buildAssistantTools } from '@/lib/assistant/tools';
import { loadMoneyTimelineInput } from '@/lib/finance/timeline-load';
import { buildSnapshot } from '@/lib/operating-index/server';
import { loadScheduleIntelligence } from '@/lib/schedule/intelligence-server';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

/**
 * EVERY SERVER SURFACE SEES EVERY WEEK OF A SERIES.
 *
 * After the briefs (#921), the today views (#922), the planner and reminders
 * (#923) and the sports table (#924), eleven server-side reads of
 * `calendar_events` still filtered `starts_at` — a series' FIRST start — by
 * their window: the chat assistant's three calendar tools, the autopilot scan,
 * the meal planner's busy nights, the money timeline, the hard signals, the
 * operating index's week, tomorrow and missing-location reads, the schedule
 * intelligence and the digital-twin projection. A weekly lesson created in
 * August was, from September on, absent from "what's on this week", free on
 * its afternoon, off the week's load and off the money timeline.
 *
 * All of them read through `readCalendarOccurrences` now. The household below
 * is in New York; "Piano" is a weekly series from Tuesday 25 August, 16:00,
 * and the week under test is 21–27 September.
 */

const ROOT = join(__dirname, '..');
const FAMILY = '00000000-0000-4000-8000-00000000fa03';
const PARENT = '00000000-0000-4000-8000-00000000ad03';
const PARENT_USER = '00000000-0000-4000-8000-00000000aa03';
const KID = '00000000-0000-4000-8000-00000000c1d3';
const PIANO = '00000000-0000-4000-8000-0000000000f1';
const DENTIST = '00000000-0000-4000-8000-0000000000f2';
const TZ = 'America/New_York';
/** Monday 21 September 2026, 08:00 in New York. */
const NOW = new Date('2026-09-21T12:00:00.000Z');

const event = (row: Record<string, unknown>) => ({
  family_id: FAMILY, description: null, location: null, category: 'general', all_day: false,
  recurrence: 'none', recurrence_until: null, assignee_id: KID, feed_id: null, external_uid: null,
  created_by: PARENT_USER, onboarding_key: null, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
  ...row,
});

function household(withSeries = true) {
  const db = createInMemorySupabase();
  db.seed('families', [{ id: FAMILY, timezone: TZ }]);
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, user_id: PARENT_USER, display_name: 'Dana', role: 'parent', is_active: true },
    { id: KID, family_id: FAMILY, user_id: null, display_name: 'Sam', role: 'child', is_active: true },
  ]);
  db.seed('calendar_events', [
    ...(withSeries ? [event({ id: PIANO, title: 'Piano', starts_at: '2026-08-25T20:00:00.000Z', ends_at: '2026-08-25T21:00:00.000Z', recurrence: 'weekly', category: 'appointment', location: 'Studio 2' })] : []),
    event({ id: DENTIST, title: 'Dentist', starts_at: '2026-09-24T14:00:00.000Z', ends_at: '2026-09-24T15:00:00.000Z', category: 'appointment' }),
  ]);
  return db;
}
const client = (db: ReturnType<typeof household>) => db as unknown as SupabaseClient<Database>;
const ctx = { familyId: FAMILY, userId: PARENT_USER, memberId: PARENT, members: [{ id: PARENT, display_name: 'Dana' }, { id: KID, display_name: 'Sam' }], tz: TZ };

describe('the chat assistant', () => {
  // The tools read the real clock; the week under test is in this machine's past.
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });
  const tool = (db: ReturnType<typeof household>, name: string) => {
    const spec = buildAssistantTools(client(db), ctx).find((t) => t.name === name);
    if (!spec) throw new Error(`no tool ${name}`);
    return spec;
  };

  it('"what\'s on this week" has the lesson in it, four weeks into the series', async () => {
    const out = await tool(household(), 'list_upcoming_events').execute({ days: 7 }) as { ok: boolean; events: { title: string; starts_at: string; who: string | null }[] };
    expect(out.ok).toBe(true);
    expect(out.events.map((e) => [e.title, e.starts_at])).toEqual([['Piano', '2026-09-22T20:00:00.000Z'], ['Dentist', '2026-09-24T14:00:00.000Z']]);
    expect(out.events[0].who).toBe('Sam');
  });

  it('"when is Sam free on Tuesday" counts the lesson as busy', async () => {
    const out = await tool(household(), 'find_free_time').execute({ date: '2026-09-22', assignee: 'Sam' }) as { ok: boolean; busy: { title: string }[]; time_zone: string };
    expect(out.ok).toBe(true);
    expect(out.time_zone).toBe(TZ);
    expect(out.busy.map((b) => b.title)).toEqual(['Piano']);
    // A real calendar day is required; a 30 February is refused, not read.
    expect(await tool(household(), 'find_free_time').execute({ date: '2026-02-30' })).toMatchObject({ ok: false });
  });
});

describe('the money timeline', () => {
  it('lists the lesson in the week ahead', async () => {
    const input = await loadMoneyTimelineInput(client(household()), FAMILY, TZ, NOW);
    // The timeline keeps events by the family's day, over its 90-day horizon:
    // the lesson is on it every Tuesday, not once in August.
    const pianoDays = input.events.filter((e) => e.title === 'Piano').map((e) => e.starts_at);
    expect(pianoDays.slice(0, 3)).toEqual(['2026-09-22', '2026-09-29', '2026-10-06']);
    expect(pianoDays.length).toBeGreaterThanOrEqual(12);
  });
});

describe("the operating index's week", () => {
  it('counts the lesson in the week\'s load, and the control without it does not', async () => {
    const withSeries = await buildSnapshot(client(household()), FAMILY, TZ, NOW);
    const without = await buildSnapshot(client(household(false)), FAMILY, TZ, NOW);
    expect(withSeries.upcomingEvents).toBe(2);
    expect(without.upcomingEvents).toBe(1);
  });
});

describe('the schedule intelligence', () => {
  it('sees the lesson at its time this week', async () => {
    const res = await loadScheduleIntelligence(client(household()), { familyId: FAMILY, tz: TZ, now: NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.events.map((e) => [e.eventId, e.startsAt])).toEqual(expect.arrayContaining([[PIANO, '2026-09-22T20:00:00.000Z']]));
  });
});

describe('every one of the eleven reads is the shared one (source pins)', () => {
  const FILES: [string, number][] = [
    ['lib/assistant/tools.ts', 3], ['lib/autopilot/scan.ts', 1], ['app/api/ai/meals/plan/route.ts', 1], ['lib/finance/timeline-load.ts', 1],
    ['lib/intelligence/hard-signals-server.ts', 1], ['lib/operating-index/server.ts', 3], ['lib/schedule/intelligence-server.ts', 1], ['lib/twin/project-server.ts', 1],
  ];
  it.each(FILES)('%s reads the calendar through readCalendarOccurrences (%i) and never by first start', (file, count) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    expect(src.match(/readCalendarOccurrences\(/g) ?? []).toHaveLength(count);
    // No remaining calendar read bounds `starts_at` itself: whatever follows a
    // `.from('calendar_events')` in the next few hundred characters is not a
    // window on the first start.
    for (const tail of src.split(".from('calendar_events')").slice(1)) {
      expect(tail.slice(0, 400)).not.toMatch(/\.(gte|lte|lt|gt)\('starts_at'/);
    }
  });

  it('the loaders that had no zone are handed the family\'s', () => {
    const cron = readFileSync(join(ROOT, 'app/api/cron/model-refresh/route.ts'), 'utf8');
    expect(cron).toContain("runTwinProjection(supabase, fam.id, null, now, fam.timezone || 'UTC')");
    expect(cron).toContain("runSignalDetection(supabase, fam.id, SIGNAL_LOCALE, signalText, now, fam.timezone || 'UTC')");
    const signals = readFileSync(join(ROOT, 'app/(app)/dashboard/family-signals/actions.ts'), 'utf8');
    expect(signals).toContain("ctx.active.family.timezone || 'UTC'");
    const twin = readFileSync(join(ROOT, 'app/(app)/dashboard/graph/twin-actions.ts'), 'utf8');
    expect(twin).toContain("ctx.active.family.timezone || 'UTC'");
    const refresh = readFileSync(join(ROOT, 'lib/reasoning/auto-refresh.ts'), 'utf8');
    expect(refresh).toContain("from('families').select('timezone').eq('id', familyId).maybeSingle()");
    expect(refresh).toContain("fam?.timezone || 'UTC'");
  });
});
