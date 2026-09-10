import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getMessages, translate } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';
import { scopeForSystem } from '@/lib/services/scope';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ context: vi.fn(), server: vi.fn(), complete: vi.fn(), build: vi.fn(), locale: 'en-US' as LocaleCode }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.context }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.server }));
vi.mock('@/lib/i18n/server', () => ({ getLocaleContext: async () => ({ locale: { code: mocks.locale }, messages: getMessages(mocks.locale) }) }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: async () => ({ complete: mocks.complete }) }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: async (_scope: unknown, _input: unknown, fn: (obs: { used: () => void }) => unknown) => fn({ used: () => {} }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/metric/time-saved-server', () => ({ countHandledThisWeek: async () => ({ total: 0 }) }));
vi.mock('@/lib/briefing/build', async original => {
  const actual = await original<typeof import('@/lib/briefing/build')>();
  return { ...actual, buildBrief: (...args: Parameters<typeof actual.buildBrief>) => { mocks.build(...args); return actual.buildBrief(...args); } };
});
import { POST } from '@/app/api/ai/briefing/route';
import { readMorningBrief } from '@/lib/briefing/deliver';

type DB = SupabaseClient<Database>;
let db = createInMemorySupabase<DB>();
function row(title: string, starts_at: string, all_day = false, ends_at: string | null = null, family_id = 'family') {
  return { id: title, family_id, title, starts_at, ends_at, all_day, location: 'Literal {location}', category: 'general', assignee_id: null };
}
function family(timezone: string, now: string, role = 'parent') {
  vi.setSystemTime(new Date(now));
  mocks.context.mockResolvedValue({ user: { id: 'user' }, active: { familyId: 'family', role, member: { id: 'parent', display_name: 'Alex' }, family: { name: 'Family', timezone } } });
}
async function api() {
  const response = await POST(new NextRequest('http://localhost/api/ai/briefing', { method: 'POST', body: '{}' }));
  expect(response.status).toBe(200);
  return response.json();
}
const prompt = () => mocks.complete.mock.calls.at(-1)![0].messages[0].content as string;
const calendarInput = () => mocks.build.mock.calls.at(-1)![0].events as { title: string; start: string; end: string | null; allDay: boolean; location: string }[];
async function morning(timezone: string, dayKey: string) {
  const now = new Date();
  const result = await readMorningBrief(scopeForSystem(db, { id: 'family', timezone }, { now }), { at: now, dayKey });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); mocks.locale = 'en-US';
  db = createInMemorySupabase<DB>(); mocks.server.mockResolvedValue(db);
  // Invalid optional AI output exercises the actual deterministic fallback and records its prompt.
  mocks.complete.mockResolvedValue({ text: 'invalid response', toolCalls: [] });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External requests forbidden'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('all-day calendar rows in the actual briefing readers', () => {
  it.each([
    ['America/New_York', '2026-09-09T16:00:00.000Z', '2026-09-09', '2026-09-10T00:30:00.000Z'],
    ['America/Los_Angeles', '2026-09-10T06:30:00.000Z', '2026-09-09', '2026-09-10T03:30:00.000Z'],
    ['Asia/Tokyo', '2026-09-09T22:30:00.000Z', '2026-09-10', '2026-09-10T11:30:00.000Z'],
    ['UTC', '2026-09-09T16:00:00.000Z', '2026-09-09', '2026-09-09T20:30:00.000Z'],
  ])('%s preserves date-only holidays and timed conflicts across UTC midnight', async (zone, now, day, timed) => {
    family(zone, now);
    const tomorrow = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString();
    const rows = [row('Today holiday {title}', `${day}T00:00:00.000Z`, true, tomorrow), row('Tomorrow holiday', tomorrow, true),
      row('Meeting', timed, false, new Date(Date.parse(timed) + 3_600_000).toISOString()),
      row('Practice', new Date(Date.parse(timed) + 1_800_000).toISOString(), false, new Date(Date.parse(timed) + 5_400_000).toISOString()),
      row('Other family secret', timed, false, null, 'other'), row('Other family holiday', `${day}T00:00:00.000Z`, true, null, 'other')];
    db.seed('calendar_events', rows); const before = structuredClone(db.table('calendar_events'));
    const body = await api();
    expect(body.briefing.schedule.map((e: { title: string }) => e.title)).toEqual(['Today holiday {title}', 'Meeting', 'Practice']);
    expect(body.briefing.schedule[0].time).toBe('All Day');
    expect(body.briefing.conflicts).toHaveLength(1);
    expect(body.briefing.conflicts[0].description).toContain('Meeting and Practice overlap');
    expect(prompt()).toContain('All Day Today holiday {title}');
    expect(prompt().split('\n').find(line => line.includes('Today holiday {title}'))).not.toContain(' until ');
    expect(prompt()).toContain(`${tomorrow.slice(0, 10)} All Day Tomorrow holiday`);
    expect(JSON.stringify(body) + prompt()).not.toContain('Other family');
    expect(calendarInput()[0]).toEqual({ title: rows[0].title, start: rows[0].starts_at, end: rows[0].ends_at, allDay: true, location: rows[0].location });
    const brief = await morning(zone, day);
    expect(brief.calendar.timeline.map(e => [e.title, e.allDay])).toEqual([['Today holiday {title}', true], ['Meeting', false], ['Practice', false]]);
    expect(brief.calendar.timeline[0].timeLabel).toBe('All day'); expect(brief.calendar.conflicts).toHaveLength(1);
    expect(db.table('calendar_events')).toEqual(before);
    expect(calendarInput().some(e => e.title === 'Other family secret')).toBe(false);
    expect(db.log.every(entry => entry.table !== 'home_briefs')).toBe(true);
  });

  it.each(['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const)('%s uses the existing all-day label in the fallback', async locale => {
    mocks.locale = locale; family('UTC', '2026-09-09T12:00:00.000Z');
    db.seed('calendar_events', [row('Holiday', '2026-09-09T00:00:00.000Z', true)]);
    const body = await api(); expect(body.briefing.schedule[0].time).toBe(translate(getMessages(locale), 'calendar.allDay'));
  });

  it.each([
    ['2026-03-07T23:30:00-05:00', '2026-03-14', '2026-03-15', '2026-03-15T03:59:59.999Z', '2026-03-15T04:00:00.000Z'],
    ['2026-11-01T00:30:00-04:00', '2026-11-08', '2026-11-09', '2026-11-09T04:59:59.999Z', '2026-11-09T05:00:00.000Z'],
  ])('API retains day +7 and excludes day +8 across DST at %s', async (now, lastDay, excludedDay, lastInstant, excludedInstant) => {
    family('America/New_York', now);
    db.seed('calendar_events', [row('Last holiday', `${lastDay}T00:00:00.000Z`, true), row('Last timed', lastInstant),
      row('Excluded holiday', `${excludedDay}T00:00:00.000Z`, true), row('Excluded timed', excludedInstant)]);
    await api(); expect(prompt()).toContain('Last holiday'); expect(prompt()).toContain('Last timed');
    expect(prompt()).not.toContain('Excluded holiday'); expect(prompt()).not.toContain('Excluded timed');
  });

  it.each([
    ['2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T03:59:59.999Z', '2026-03-09T04:00:00.000Z'],
    ['2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T04:59:59.999Z', '2026-11-02T05:00:00.000Z'],
  ])('API includes exactly the local 23/25-hour day on %s', async (day, first, last, next) => {
    family('America/New_York', `${day}T12:00:00.000Z`);
    db.seed('calendar_events', [row('Today holiday', `${day}T00:00:00.000Z`, true), row('First timed', first), row('Last timed', last),
      row('Next day', next), row('Previous day', new Date(Date.parse(first) - 1).toISOString())]);
    const body = await api();
    expect(body.briefing.schedule.map((e: { title: string }) => e.title)).toEqual(['Today holiday', 'First timed', 'Last timed']);
  });

  it('keeps multi-day events anchored to their original start date and preserves ISO values', async () => {
    family('America/New_York', '2026-09-09T12:00:00.000Z');
    db.seed('calendar_events', [row('Earlier ongoing holiday', '2026-09-08T00:00:00.000Z', true, '2026-09-12T00:00:00.000Z'),
      row('Today multi-day holiday', '2026-09-09T00:00:00.000Z', true, '2026-09-12T00:00:00.000Z')]);
    await api(); expect(calendarInput()).toEqual([{ title: 'Today multi-day holiday', start: '2026-09-09T00:00:00.000Z',
      end: '2026-09-12T00:00:00.000Z', allDay: true, location: 'Literal {location}' }]);
    await morning('America/New_York', '2026-09-09'); expect(calendarInput().map(e => e.title)).toEqual(['Today multi-day holiday']);
  });

  it('leaves the existing school and sports horizons independent from the calendar correction', async () => {
    family('America/New_York', '2026-03-07T23:30:00-05:00');
    const starts_at = '2026-03-15T15:00:00.000Z';
    db.seed('calendar_events', [row('Beyond calendar week', starts_at)]);
    db.seed('school_events', [{ family_id: 'family', title: 'School original horizon', starts_at, event_type: 'class' }]);
    db.seed('sports_events', [{ family_id: 'family', title: 'Sports original horizon', starts_at, sport: 'running' }]);
    await api(); expect(prompt()).not.toContain('Beyond calendar week');
    expect(prompt()).toContain('School original horizon'); expect(prompt()).toContain('Sports original horizon');
  });

  it.each([
    ['2026-03-08', '2026-03-08T12:00:00.000Z', '2026-03-14', '2026-03-15T03:59:59.999Z', '2026-03-15T04:00:00.000Z'],
    ['2026-11-01', '2026-11-01T12:00:00.000Z', '2026-11-07', '2026-11-08T04:59:59.999Z', '2026-11-08T05:00:00.000Z'],
  ])('delivery covers seven local dates from %s with exclusive upper bounds', async (day, now, lastDay, lastInstant, excludedInstant) => {
    family('America/New_York', now);
    const nextDay = new Date(Date.parse(`${lastDay}T00:00:00Z`) + 86_400_000).toISOString();
    db.seed('calendar_events', [row('First holiday', `${day}T00:00:00.000Z`, true), row('Last holiday', `${lastDay}T00:00:00.000Z`, true),
      row('Last timed', lastInstant), row('Excluded holiday', nextDay, true), row('Excluded timed', excludedInstant)]);
    await morning('America/New_York', day);
    expect(calendarInput().map(e => e.title)).toEqual(['First holiday', 'Last holiday', 'Last timed']);
  });

  it('filters each event kind before the shared upcoming limit of eight', async () => {
    family('America/New_York', '2026-09-09T12:00:00.000Z');
    const excluded = Array.from({ length: 10 }, (_, i) => row(`Previous local evening ${i}`, `2026-09-10T01:${String(i).padStart(2, '0')}:00.000Z`));
    const included = Array.from({ length: 8 }, (_, i) => row(`Upcoming ${i}`, `2026-09-10T04:${String(i).padStart(2, '0')}:00.000Z`));
    db.seed('calendar_events', [...excluded, row('Tomorrow holiday', '2026-09-10T00:00:00.000Z', true), ...included]);
    await api(); const upcoming = prompt().split('TOMORROW/THIS WEEK EVENTS:')[1].split('CHORES DUE TODAY')[0];
    expect(upcoming).toContain('Tomorrow holiday'); expect(upcoming).not.toContain('Previous local evening');
    expect(upcoming).toContain('Upcoming 6'); expect(upcoming).not.toContain('Upcoming 7');
    expect(upcoming.trim().split('\n')).toHaveLength(8);
  });

  it('filters each event kind before the shared delivery limit of 100', async () => {
    family('America/New_York', '2026-09-09T12:00:00.000Z');
    const excluded = Array.from({ length: 101 }, (_, i) => row(`Previous local day ${i}`, new Date(Date.parse('2026-09-09T01:00:00Z') + i * 60_000).toISOString()));
    const included = Array.from({ length: 100 }, (_, i) => row(`Today ${i}`, new Date(Date.parse('2026-09-09T04:00:00Z') + i * 60_000).toISOString()));
    db.seed('calendar_events', [...excluded, row('Today holiday', '2026-09-09T00:00:00.000Z', true), ...included]);
    await morning('America/New_York', '2026-09-09');
    expect(calendarInput()).toHaveLength(100); expect(calendarInput()[0].title).toBe('Today holiday');
    expect(calendarInput().at(-1)!.title).toBe('Today 98'); expect(calendarInput().some(e => e.title.startsWith('Previous'))).toBe(false);
  });

  it('keeps child finance/health gates and snapshot quarantine while reading the corrected day', async () => {
    family('America/New_York', '2026-09-09T12:00:00.000Z', 'child');
    db.seed('calendar_events', [row('Holiday', '2026-09-09T00:00:00.000Z', true)]);
    const from = vi.spyOn(db, 'from'); await api();
    for (const table of ['bills', 'medication_schedules', 'parent_approvals', 'home_briefs', 'sync_calendar_events', 'sync_tokens']) expect(from.mock.calls.map(([name]) => name)).not.toContain(table);
  });

  it('retains a retryable delivery failure when the calendar query fails', async () => {
    family('America/New_York', '2026-09-09T12:00:00.000Z');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(table => {
      const query = from(table);
      return table !== 'calendar_events' ? query : new Proxy(query, { get: (target, key, receiver) => key === 'then'
        ? (resolve: (value: unknown) => void) => resolve({ data: null, error: { message: 'Calendar read unavailable' } })
        : Reflect.get(target, key, receiver) });
    });
    const now = new Date();
    const result = await readMorningBrief(scopeForSystem(db, { id: 'family', timezone: 'America/New_York' }, { now }), { at: now, dayKey: '2026-09-09' });
    expect(result).toMatchObject({ ok: false, retryable: true }); expect(mocks.build).not.toHaveBeenCalled();
    expect(db.table('notifications')).toHaveLength(0);
  });

  it.each([
    ['today', 1, 'returned error'], ['upcoming', 2, 'returned error'],
    ['today', 1, 'transport rejection'], ['upcoming', 2, 'transport rejection'],
  ] as const)('%s calendar read %i returns translated 503 on %s before downstream work', async (_slice, failingRead, failure) => {
    family('America/New_York', '2026-09-09T12:00:00.000Z'); mocks.locale = 'fr-FR';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const from = db.from.bind(db); let calendarReads = 0;
    vi.spyOn(db, 'from').mockImplementation(table => {
      const query = from(table);
      return table !== 'calendar_events' || ++calendarReads !== failingRead ? query : new Proxy(query, { get: (target, key, receiver) => key === 'then'
        ? (resolve: (value: unknown) => void, reject: (cause: unknown) => void) => failure === 'returned error'
          ? resolve({ data: [], error: { message: 'Internal calendar query detail' } }) : reject(new Error('Internal calendar transport detail'))
        : Reflect.get(target, key, receiver) });
    });
    const response = await POST(new NextRequest('http://localhost/api/ai/briefing', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: translate(getMessages('fr-FR'), 'briefing.failedToGenerateBriefing') });
    expect(mocks.complete).not.toHaveBeenCalled(); expect(mocks.build).not.toHaveBeenCalled();
    for (const table of ['notifications', 'ai_requests', 'home_briefs']) expect(db.log.map(entry => entry.table)).not.toContain(table);
  });

  it('accepts successful empty calendar reads as an empty day', async () => {
    family('America/New_York', '2026-09-09T12:00:00.000Z');
    const body = await api(); expect(body.briefing.schedule).toEqual([]); expect(body.briefing.conflicts).toEqual([]);
    expect(mocks.complete).toHaveBeenCalledOnce(); expect(mocks.build).toHaveBeenCalledOnce();
  });

  it.each([
    ['America/Santiago', '2026-09-06', '2026-09-06T04:00:00.000Z'],
    ['America/Havana', '2026-03-08', '2026-03-08T05:00:00.000Z'],
  ])('%s midnight gap excludes the preceding local date in both readers', async (zone, day, first) => {
    family(zone, `${day}T15:00:00.000Z`);
    db.seed('calendar_events', [row('Today holiday', `${day}T00:00:00.000Z`, true), row('First valid instant', first),
      row('Previous local date', new Date(Date.parse(first) - 1_800_000).toISOString())]);
    const body = await api(); expect(body.briefing.schedule.map((e: { title: string }) => e.title)).toEqual(['Today holiday', 'First valid instant']);
    await morning(zone, day); expect(calendarInput().map(e => e.title)).toEqual(['Today holiday', 'First valid instant']);
  });

  it.each([
    ['America/Santiago', '2026-08-29', '2026-08-30', '2026-09-06T04:00:00.000Z'],
    ['America/Havana', '2026-02-28', '2026-03-01', '2026-03-08T05:00:00.000Z'],
  ])('%s retains the last local evening when the exclusive endpoint skips midnight', async (zone, apiDay, deliveryDay, end) => {
    db.seed('calendar_events', [row('Last included instant', new Date(Date.parse(end) - 1).toISOString()), row('Exclusive endpoint', end)]);
    family(zone, `${apiDay}T15:00:00.000Z`); await api();
    expect(prompt()).toContain('Last included instant'); expect(prompt()).not.toContain('Exclusive endpoint');
    family(zone, `${deliveryDay}T15:00:00.000Z`); await morning(zone, deliveryDay);
    expect(calendarInput().map(e => e.title)).toEqual(['Last included instant']);
  });

  it('includes both occurrences of the Havana midnight fold and no previous-date row', async () => {
    const day = '2026-11-01'; family('America/Havana', `${day}T15:00:00.000Z`);
    db.seed('calendar_events', [row('First midnight', '2026-11-01T04:00:00.000Z'), row('First 00:30', '2026-11-01T04:30:00.000Z'),
      row('Second 00:30', '2026-11-01T05:30:00.000Z'), row('Previous date', '2026-11-01T03:59:59.999Z')]);
    const body = await api(); expect(body.briefing.schedule.map((e: { title: string }) => e.title)).toEqual(['First midnight', 'First 00:30', 'Second 00:30']);
    await morning('America/Havana', day); expect(calendarInput().map(e => e.title)).toEqual(['First midnight', 'First 00:30', 'Second 00:30']);
  });

  it('a horizon ending on Apia’s skipped date retains the preceding day without admitting the next', async () => {
    db.seed('calendar_events', [row('Last holiday', '2011-12-29T00:00:00.000Z', true), row('Excluded holiday', '2011-12-30T00:00:00.000Z', true),
      row('Last timed', '2011-12-30T09:59:59.999Z'), row('After jump', '2011-12-30T10:00:00.000Z')]);
    family('Pacific/Apia', '2011-12-22T22:00:00.000Z'); await api();
    expect(prompt()).toContain('Last holiday'); expect(prompt()).toContain('Last timed');
    expect(prompt()).not.toContain('Excluded holiday'); expect(prompt()).not.toContain('After jump');
    family('Pacific/Apia', '2011-12-23T22:00:00.000Z'); await morning('Pacific/Apia', '2011-12-23');
    expect(calendarInput().map(e => e.title)).toEqual(['Last holiday', 'Last timed']);
  });

  it.each(['point within an interval', 'simultaneous points'])('API keeps %s visible without inventing a timed clash', async kind => {
    family('UTC', '2026-09-09T12:00:00.000Z');
    const point = row('Point entry', '2026-09-09T09:30:00.000Z', false, '2026-09-09T09:30:00.000Z');
    db.seed('calendar_events', [point, kind === 'simultaneous points' ? { ...point, title: 'Other point' }
      : row('Appointment', '2026-09-09T09:00:00.000Z', false, '2026-09-09T10:00:00.000Z')]);
    const body = await api(); expect(body.briefing.schedule).toHaveLength(2); expect(body.briefing.conflicts).toEqual([]);
    expect(calendarInput().find(e => e.title === 'Point entry')).toMatchObject({ start: point.starts_at, end: point.ends_at });
  });

  it('API retains the legacy hour estimate for a missing end and a real overlap beside a point', async () => {
    family('UTC', '2026-09-09T12:00:00.000Z');
    db.seed('calendar_events', [row('Missing end', '2026-09-09T09:00:00.000Z'),
      row('Appointment', '2026-09-09T09:30:00.000Z', false, '2026-09-09T10:30:00.000Z'),
      row('Point', '2026-09-09T09:45:00.000Z', false, '2026-09-09T09:45:00.000Z')]);
    const body = await api(); expect(body.briefing.conflicts).toHaveLength(1);
    expect(body.briefing.conflicts[0].description).toContain('Missing end and Appointment overlap');
    expect(calendarInput().find(e => e.title === 'Missing end')!.end).toBeNull();
  });
});
