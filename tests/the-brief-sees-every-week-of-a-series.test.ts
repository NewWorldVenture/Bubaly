// The brief sees every week of a series.
//
// `calendar_events` stores a recurring event as ONE row whose `starts_at` is
// its first occurrence. The daily brief, the weekly brief, the weekly digest
// and the pushed morning brief all read "today's" or "this week's" events by
// filtering that column by the window — `briefingCalendarWindow`'s own
// docstring says it "selects start dates only, without expanding … recurrence"
// — so the weekly soccer practice a family created in August was in the brief
// the week it was created and in no brief after that. The calendar page
// expands series (lib/calendar/recurrence.ts); the briefs did not.
//
// `readCalendarOccurrences` (lib/calendar/occurrences.ts) is the read those
// four surfaces now share: one-offs by the window, series expanded with the
// calendar page's expander, limit applied after the merge. The daily route is
// driven here end to end as well, on its deterministic path, so the schedule
// the family reads carries the practice.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { entitledServiceClient } from './helpers/entitled-service-client';
import { briefingCalendarBounds, briefingCalendarWindow, instantCalendarBounds } from '@/lib/briefing/calendar-window';
import { readCalendarOccurrences } from '@/lib/calendar/occurrences';

const mocks = vi.hoisted(() => ({ context: vi.fn(), server: vi.fn(), complete: vi.fn(), configured: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers({ 'accept-language': 'en-US', 'x-country': 'US' }) }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.context }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.server, createServiceClient: () => entitledServiceClient() }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: mocks.configured, resolveProvider: async () => ({ complete: mocks.complete }) }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: async (_scope: unknown, _input: unknown, fn: (obs: { used: () => void }) => unknown) => fn({ used: () => {} }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/metric/time-saved-server', () => ({ countHandledThisWeek: async () => ({ total: 0 }) }));
import { POST as briefing } from '@/app/api/ai/briefing/route';

const ROOT = join(__dirname, '..');
const FAMILY = 'family';
const TZ = 'America/New_York';
/** A Wednesday. */
const TODAY = '2026-09-09';

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;
const titles = (rows: Array<{ title: string }> | null) => (rows ?? []).map((r) => r.title);

function seedCalendar() {
  db.seed('calendar_events', [
    // Wednesdays 15:00 New York (19:00Z in September), created three weeks ago.
    { id: 'soccer', family_id: FAMILY, title: 'Soccer practice', starts_at: '2026-08-19T19:00:00.000Z', ends_at: '2026-08-19T20:00:00.000Z', all_day: false, recurrence: 'weekly', recurrence_until: null, location: 'Field 3', category: 'sports', assignee_id: null },
    // Every day, all day, since the first.
    { id: 'bins', family_id: FAMILY, title: 'Bins out', starts_at: '2026-09-01T00:00:00.000Z', ends_at: null, all_day: true, recurrence: 'daily', recurrence_until: null, location: null, category: 'home', assignee_id: null },
    // A one-off today.
    { id: 'dentist', family_id: FAMILY, title: 'Dentist', starts_at: '2026-09-09T13:00:00.000Z', ends_at: '2026-09-09T13:30:00.000Z', all_day: false, recurrence: 'none', recurrence_until: null, location: null, category: 'health', assignee_id: null },
    // A series whose FIRST occurrence is today: one row, one line, not two.
    { id: 'piano', family_id: FAMILY, title: 'Piano', starts_at: '2026-09-09T21:00:00.000Z', ends_at: '2026-09-09T21:30:00.000Z', all_day: false, recurrence: 'weekly', recurrence_until: null, location: null, category: 'music', assignee_id: null },
    // A series that ended last month.
    { id: 'old-club', family_id: FAMILY, title: 'Old club', starts_at: '2026-07-01T19:00:00.000Z', ends_at: null, all_day: false, recurrence: 'weekly', recurrence_until: '2026-08-31T00:00:00.000Z', location: null, category: null, assignee_id: null },
    // A series that starts next week.
    { id: 'future', family_id: FAMILY, title: 'Future', starts_at: '2026-09-16T19:00:00.000Z', ends_at: null, all_day: false, recurrence: 'weekly', recurrence_until: null, location: null, category: null, assignee_id: null },
    // Another family's series on the same weekday: not ours.
    { id: 'theirs', family_id: 'other', title: 'Their practice', starts_at: '2026-08-19T19:00:00.000Z', ends_at: null, all_day: false, recurrence: 'weekly', recurrence_until: null, location: null, category: null, assignee_id: null },
  ]);
}

beforeEach(() => { db = createInMemorySupabase(); seedCalendar(); });

describe('readCalendarOccurrences', () => {
  const COLUMNS = ['title', 'starts_at', 'ends_at', 'all_day', 'location', 'category', 'assignee_id'] as const;

  it('today holds the one-offs AND this week\'s occurrence of every series, in time order, once each', async () => {
    const { data, error } = await readCalendarOccurrences(client(), FAMILY, briefingCalendarBounds(TODAY, TZ, 0, 1), TZ, { columns: COLUMNS });
    expect(error).toBeNull();
    expect(titles(data)).toEqual(['Bins out', 'Dentist', 'Soccer practice', 'Piano']);
    const soccer = data!.find((r) => r.title === 'Soccer practice')!;
    // The occurrence's own instants, not the first week's.
    expect(soccer).toMatchObject({ starts_at: '2026-09-09T19:00:00.000Z', ends_at: '2026-09-09T20:00:00.000Z', location: 'Field 3', category: 'sports' });
    expect(data!.find((r) => r.title === 'Bins out')).toMatchObject({ starts_at: '2026-09-09T00:00:00.000Z', all_day: true });
  });

  it('the control: the window filter alone, as the briefs read before, has no soccer and no bins', async () => {
    const { data } = await client().from('calendar_events').select('title').eq('family_id', FAMILY).or(briefingCalendarWindow(TODAY, TZ, 0, 1)).order('starts_at');
    expect(titles(data as Array<{ title: string }>)).toEqual(['Dentist', 'Piano']);
  });

  it('the limit applies after the merge, so the nearest things win, not the nearest rows', async () => {
    const { data } = await readCalendarOccurrences(client(), FAMILY, briefingCalendarBounds(TODAY, TZ, 0, 1), TZ, { columns: COLUMNS, limit: 2 });
    expect(titles(data)).toEqual(['Bins out', 'Dentist']);
  });

  it('the coming week has every day of a daily series and next week\'s practice', async () => {
    const { data } = await readCalendarOccurrences(client(), FAMILY, briefingCalendarBounds(TODAY, TZ, 1, 7), TZ, { columns: ['title', 'starts_at', 'all_day', 'category'] });
    const byTitle = new Map<string, string[]>();
    for (const row of data!) byTitle.set(row.title, [...(byTitle.get(row.title) ?? []), row.starts_at]);
    expect(byTitle.get('Bins out')).toHaveLength(7);
    expect(byTitle.get('Bins out')![0]).toBe('2026-09-10T00:00:00.000Z');
    expect(byTitle.get('Soccer practice')).toEqual(['2026-09-16T19:00:00.000Z']);
    expect(byTitle.get('Piano')).toEqual(['2026-09-16T21:00:00.000Z']);
    expect(byTitle.get('Future')).toEqual(['2026-09-16T19:00:00.000Z']);
    expect(byTitle.has('Dentist')).toBe(false);
    expect(byTitle.has('Old club')).toBe(false);
  });

  it('a timed series keeps its local hour across the clock change', async () => {
    db.seed('calendar_events', [{ id: 'swim', family_id: FAMILY, title: 'Swim', starts_at: '2026-10-21T19:00:00.000Z', ends_at: null, all_day: false, recurrence: 'weekly', recurrence_until: null, location: null, category: null, assignee_id: null }]);
    // 15:00 New York is 19:00Z in October and 20:00Z after 1 November.
    const { data } = await readCalendarOccurrences(client(), FAMILY, briefingCalendarBounds('2026-11-11', TZ, 0, 1), TZ, { columns: ['title', 'starts_at'] });
    expect(data!.find((r) => r.title === 'Swim')!.starts_at).toBe('2026-11-11T20:00:00.000Z');
  });

  it('an instant window (the weekly surfaces) reads the same way', async () => {
    // The family's week from Wednesday 9 September: aheadEnd is the last millisecond of the 15th.
    const bounds = instantCalendarBounds('2026-09-09T04:00:00.000Z', '2026-09-16T03:59:59.999Z', TZ);
    expect(bounds).toEqual({ timedFrom: '2026-09-09T04:00:00.000Z', timedTo: '2026-09-16T04:00:00.000Z', allDayFromDay: '2026-09-09', allDayToDay: '2026-09-16' });
    const { data } = await readCalendarOccurrences(client(), FAMILY, bounds, TZ, { columns: ['title', 'starts_at'] });
    expect(titles(data).filter((t) => t === 'Bins out')).toHaveLength(7);
    expect(titles(data).filter((t) => t === 'Soccer practice')).toHaveLength(1);
    expect(titles(data)).not.toContain('Future');
  });

  it('a failed read is the error it was, not an empty day', async () => {
    const refused = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const builder = target.from(table) as unknown as Record<string, unknown>;
          if (table === 'calendar_events') {
            const stub: Record<string, unknown> = {};
            Object.assign(stub, { eq: () => stub, or: () => stub, order: () => stub, not: () => stub, neq: () => stub, lt: () => stub, range: () => stub, then: (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: 'permission denied for table calendar_events' } }) });
            builder.select = () => stub;
          }
          return builder;
        };
      },
    }) as unknown as SupabaseClient<Database>;
    const result = await readCalendarOccurrences(refused, FAMILY, briefingCalendarBounds(TODAY, TZ, 0, 1), TZ, { columns: ['title'] });
    expect(result.data).toBeNull();
    expect(result.error?.message).toContain('permission denied');
  });
});

describe('the daily brief', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-09T16:00:00.000Z'));
    db.seed('family_members', [{ id: 'parent', family_id: FAMILY, display_name: 'Alex', role: 'parent', is_active: true }]);
    mocks.server.mockResolvedValue(db);
    mocks.context.mockResolvedValue({ user: { id: 'user' }, active: { familyId: FAMILY, role: 'parent', member: { id: 'parent', display_name: 'Alex' }, family: { name: 'Family', timezone: TZ } } });
    mocks.configured.mockResolvedValue(false);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External requests forbidden'); }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('lists this week\'s soccer practice, created three weeks ago, in today\'s schedule', async () => {
    const response = await briefing(new NextRequest('http://localhost/api/ai/briefing', { method: 'POST', body: JSON.stringify({ type: 'morning' }) }));
    expect(response.status).toBe(200);
    const body = await response.json();
    const schedule = body.briefing.schedule as Array<{ title: string; time: string }>;
    expect(schedule.map((s) => s.title)).toEqual(['Bins out', 'Dentist', 'Soccer practice', 'Piano']);
    expect(schedule.find((s) => s.title === 'Soccer practice')!.time).toBe('3:00 PM');
    expect(schedule.map((s) => s.title)).not.toContain('Their practice');
  });
});

describe('the four surfaces read through the shared occurrences read', () => {
  it.each([
    'app/api/ai/briefing/route.ts',
    'app/api/ai/weekly-briefing/route.ts',
    'app/api/cron/weekly-digest/route.ts',
    'lib/briefing/deliver.ts',
  ])('%s no longer reads calendar_events by its first start alone', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    expect(src).toContain('readCalendarOccurrences(');
    expect(src, 'a bare calendar_events read by starts_at crept back').not.toMatch(/from\('calendar_events'\)/);
  });
});
