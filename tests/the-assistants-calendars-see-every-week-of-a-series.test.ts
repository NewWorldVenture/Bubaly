import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { buildAssistantTools, type AssistantCtx } from '@/lib/assistant/tools';
import { answerAssistant, type AssistantLink } from '@/lib/assistant/service';
import { classifyAssistantUtterance } from '@/lib/assistant/intent';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

/**
 * THE ASSISTANTS' CALENDARS SEE EVERY WEEK OF A SERIES, AND AN ALL-DAY ROW ON
 * ITS OWN DATE.
 *
 * The chat assistant's calendar tools (lib/assistant/tools.ts) and the voice
 * speaker's agenda (lib/assistant/service.ts) each read `calendar_events` with
 * their own query. The chat tools filtered `starts_at` by the window, so a
 * weekly practice created in August was not in "what's on this week",
 * `find_free_time` called its hour free, and `list_pending_decisions` saw no
 * clash with a one-off booked over it. The speaker expanded series itself but
 * read one-offs from the family's midnight, so today's all-day row (stored at
 * today's UTC midnight, the evening before in Los Angeles) was never on
 * today's list. All of them now read through `readCalendarOccurrences`.
 *
 * The household is in Los Angeles. "Soccer" is a weekly series from Monday 17
 * August, 16:00 PDT; the day under test is Monday 14 September.
 */

const FAMILY = '00000000-0000-4000-8000-00000000fa01';
const PARENT = '00000000-0000-4000-8000-00000000ad01';
const PARENT_USER = '00000000-0000-4000-8000-00000000aa01';
const KID = '00000000-0000-4000-8000-00000000c1d1';
const SOCCER = '00000000-0000-4000-8000-0000000000e1';
const PHOTO = '00000000-0000-4000-8000-0000000000e2';
const CLOSED = '00000000-0000-4000-8000-0000000000e3';
const LA = 'America/Los_Angeles';
/** Monday 14 September 2026, 08:00 in Los Angeles. */
const NOW = new Date('2026-09-14T15:00:00.000Z');

const event = (row: Record<string, unknown>) => ({
  family_id: FAMILY, description: null, location: null, category: 'general', all_day: false,
  recurrence: 'none', recurrence_until: null, assignee_id: null, feed_id: null, external_uid: null,
  created_by: PARENT_USER, onboarding_key: null, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
  ends_at: null, ...row,
});

function household() {
  const db = createInMemorySupabase();
  db.seed('families', [{ id: FAMILY, timezone: LA }]);
  db.seed('calendar_events', [
    event({ id: SOCCER, title: 'Soccer', starts_at: '2026-08-17T23:00:00.000Z', ends_at: '2026-08-18T00:00:00.000Z', recurrence: 'weekly', assignee_id: KID }),
    // Monday 14 September 16:30–17:30 PDT, booked over the practice.
    event({ id: PHOTO, title: 'Team photo', starts_at: '2026-09-14T23:30:00.000Z', ends_at: '2026-09-15T00:30:00.000Z', assignee_id: KID }),
    // Monday 14 September, all day: stored at Monday's UTC midnight (Sunday 17:00 here).
    event({ id: CLOSED, title: 'School closed', starts_at: '2026-09-14T00:00:00.000Z', all_day: true }),
  ]);
  return db;
}

const ctx: AssistantCtx = {
  familyId: FAMILY, userId: PARENT_USER, role: 'parent', memberId: PARENT,
  members: [{ id: PARENT, display_name: 'Dana' }, { id: KID, display_name: 'Sam' }], tz: LA,
};
const tool = (db: ReturnType<typeof household>, name: string) => {
  const found = buildAssistantTools(db as unknown as SupabaseClient<Database>, ctx).find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

describe('the chat assistant\'s calendar tools', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('list_upcoming_events has this week\'s practice and today\'s all-day row', async () => {
    const res = await tool(household(), 'list_upcoming_events').execute({ days: 7 }) as { ok: boolean; events: { title: string; starts_at: string; all_day: boolean }[] };
    expect(res.ok).toBe(true);
    expect(res.events.map((e) => [e.title, e.starts_at])).toEqual([
      ['School closed', '2026-09-14T00:00:00.000Z'],
      ['Soccer', '2026-09-14T23:00:00.000Z'],
      ['Team photo', '2026-09-14T23:30:00.000Z'],
    ]);
    const fortnight = await tool(household(), 'list_upcoming_events').execute({ days: 14 }) as { events: { title: string; starts_at: string }[] };
    expect(fortnight.events.filter((e) => e.title === 'Soccer').map((e) => e.starts_at)).toEqual(['2026-09-14T23:00:00.000Z', '2026-09-21T23:00:00.000Z']);
  });

  it('find_free_time calls the practice\'s hour busy four weeks on, and the all-day row by its date', async () => {
    const res = await tool(household(), 'find_free_time').execute({ date: '2026-09-14' }) as { ok: boolean; busy: { title: string; start: string | null; end: string | null; all_day: boolean }[] };
    expect(res.ok).toBe(true);
    expect(res.busy).toEqual([
      { title: 'School closed', start: 'Mon, Sep 14', end: null, all_day: true, starts_at: '2026-09-14', ends_at: '2026-09-15' },
      { title: 'Soccer', start: 'Mon, Sep 14, 4:00 PM', end: 'Mon, Sep 14, 5:00 PM', all_day: false, starts_at: '2026-09-14T23:00:00.000Z', ends_at: '2026-09-15T00:00:00.000Z' },
      { title: 'Team photo', start: 'Mon, Sep 14, 4:30 PM', end: 'Mon, Sep 14, 5:30 PM', all_day: false, starts_at: '2026-09-14T23:30:00.000Z', ends_at: '2026-09-15T00:30:00.000Z' },
    ]);
    // Sunday is free: the all-day Monday is not drawn on the evening before.
    const sunday = await tool(household(), 'find_free_time').execute({ date: '2026-09-13' }) as { busy: unknown[] };
    expect(sunday.busy).toEqual([]);
  });

  it('find_free_time refuses a date that is not on the calendar', async () => {
    expect(await tool(household(), 'find_free_time').execute({ date: '2026-02-30' })).toEqual({ ok: false, error: 'date must be a real calendar date' });
  });

  it('list_pending_decisions sees the clash with the practice', async () => {
    const res = await tool(household(), 'list_pending_decisions').execute({}) as { ok: boolean; items: { title: string }[] };
    expect(res.ok).toBe(true);
    expect(res.items.some((i) => /overlap|conflict|double/i.test(i.title)), JSON.stringify(res.items)).toBe(true);
  });
});

describe('the speaker\'s agenda', () => {
  const link: AssistantLink = { id: 'link-1', family_id: FAMILY, user_id: PARENT_USER, provider: 'alexa', scopes: ['ask'], timezone: LA };
  const ask = (utterance: string) => answerAssistant(household() as unknown as SupabaseClient<Database>, link, classifyAssistantUtterance(utterance, NOW, LA), NOW);

  it('hears today\'s all-day row first, and every week of the practice', async () => {
    const reply = await ask("what's on today");
    expect(reply.speech).toBe('You have 3 things today: School closed, Soccer at 4pm and Team photo at 4:30pm.');
  });

  it('does not hear Monday\'s all-day row on Sunday', async () => {
    const sunday = new Date('2026-09-13T19:00:00.000Z');
    const reply = await answerAssistant(household() as unknown as SupabaseClient<Database>, link, classifyAssistantUtterance("what's on today", sunday, LA), sunday);
    expect(reply.speech).toBe('Nothing is on the calendar for today.');
  });
});

describe('source pins', () => {
  const ROOT = join(__dirname, '..');
  it('the assistants have no calendar read of their own left', () => {
    const tools = readFileSync(join(ROOT, 'lib/assistant/tools.ts'), 'utf8');
    const service = readFileSync(join(ROOT, 'lib/assistant/service.ts'), 'utf8');
    expect(tools.match(/readCalendarOccurrences\(/g)).toHaveLength(2);
    expect(tools.match(/readCalendarAvailability\(/g)).toHaveLength(1);
    expect(tools).toContain('readCalendarAvailability(supabase, ctx.familyId, bounds, tz)');
    // The only remaining direct reads are the write and the RSVP title lookups.
    expect(tools).not.toMatch(/from\('calendar_events'\)\s*\.select\('(title, starts_at|id, title, starts_at, ends_at)/);
    expect(service).toContain('readCalendarOccurrences(supabase, familyId, instantCalendarBounds(window.from, toInclusive, timezone), timezone');
    expect(service).not.toContain("from('calendar_events').select(columns)");
  });
});
