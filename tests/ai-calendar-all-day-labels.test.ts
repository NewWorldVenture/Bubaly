import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { calendarTools } from '@/lib/ai/tools/calendar';
import type { Database, Tables } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';

vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => () => 'Synthetic' }));

const FAMILY = '10000000-0000-4000-8000-000000000001';
const ACTOR = '20000000-0000-4000-8000-000000000001';
const ID = '30000000-0000-4000-8000-000000000001';
const ZONES = ['UTC', 'America/New_York', 'Asia/Tokyo', 'Pacific/Kiritimati'];

function fixture(timezone: string, allDay = true) {
  let row: Tables<'calendar_events'> = {
    id: ID, family_id: FAMILY, created_by: ACTOR, title: 'Synthetic',
    starts_at: '2026-11-14T00:00:00.000Z', ends_at: '2026-11-15T00:00:00.000Z',
    all_day: allDay, category: 'general', description: null, location: null,
    assignee_id: null, recurrence: 'none', recurrence_until: null,
    feed_id: null, external_uid: null, onboarding_key: null, idempotency_key: null,
    created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
  };
  const calls: { method: string; payload: Record<string, unknown> | null }[] = [];
  const db = createClient<Database>('https://calendar-label.synthetic.invalid', 'synthetic', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://calendar-label.synthetic.invalid');
      expect(url.pathname).toBe('/rest/v1/calendar_events');
      const method = init?.method ?? 'GET';
      expect(['GET', 'POST', 'PATCH']).toContain(method);
      const payload: Record<string, unknown> | null = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, payload });
      if (method !== 'POST') {
        expect(url.searchParams.get('family_id')).toBe(`eq.${FAMILY}`);
        expect(url.searchParams.get('id')).toBe(`eq.${ID}`);
      }
      if (method === 'PATCH') {
        expect(url.searchParams.get('feed_id')).toBe('is.null');
        expect(url.searchParams.get('external_uid')).toBe('is.null');
        // Apply the actual service's finite captured-clock predicates.
        for (const key of ['starts_at', 'ends_at', 'all_day'] as const) {
          const predicate = url.searchParams.get(key);
          if (predicate) expect(predicate).toBe(row[key] === null ? 'is.null' : `eq.${row[key]}`);
        }
      }
      if (payload) row = { ...row, ...payload };
      return Response.json(row);
    } },
  });
  const scope: ServiceScope = {
    db, familyId: FAMILY, userId: ACTOR, memberId: null, role: 'parent',
    actorKind: 'ai', tz: timezone, now: new Date('2026-11-14T12:00:00Z'),
  };
  return { scope, calls, row: () => row };
}

function tool(name: string) {
  const found = calendarTools.find(candidate => candidate.name === name);
  if (!found) throw new Error('Missing actual calendar tool');
  return found;
}

describe('AI calendar write labels preserve civil DATEs', () => {
  it.each(ZONES)('creates civil labels without a clock or previous-day shift in %s', async timezone => {
    for (const [start, end] of [
      ['2026-03-08', '2026-03-09'],
      ['2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'],
      ['2026-12-31', '2027-01-01'],
    ]) {
      const f = fixture(timezone);
      const input = { title: 'Synthetic', starts_at: start, ends_at: end, all_day: true };
      const actualTool = tool('calendar.createEvent');
      const result = await actualTool.execute(f.scope, input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      const expected = `all day ${start.slice(0, 10)}`;
      expect(result.data).toMatchObject({ when: expected, all_day: true, starts_at: `${start.slice(0, 10)}T00:00:00.000Z`, ends_at: `${end.slice(0, 10)}T00:00:00.000Z` });
      expect(actualTool.output.safeParse(result.data).success).toBe(true);
      expect(actualTool.summarize(input, result.data)).toContain(expected);
      expect(f.calls.map(call => call.method)).toEqual(['POST']);
      expect(f.calls[0].payload).toMatchObject({ family_id: FAMILY, created_by: ACTOR, all_day: true });
    }
  });

  it.each(ZONES)('labels default, null-end and multi-day DATE writes in %s', async timezone => {
    for (const end of [undefined, null, '2026-11-17']) {
      const f = fixture(timezone);
      const input = { title: 'Synthetic', starts_at: '2026-11-14', ends_at: end, all_day: true };
      const actualTool = tool('calendar.createEvent');
      const result = await actualTool.execute(f.scope, input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.data).toMatchObject({ when: 'all day 2026-11-14', ends_at: end ? '2026-11-17T00:00:00.000Z' : null });
      expect(actualTool.output.safeParse(result.data).success).toBe(true);
      expect(actualTool.summarize(input, result.data)).toContain('all day 2026-11-14');
      expect(f.calls.map(call => call.method)).toEqual(['POST']);
    }
  });
  it.each(ZONES)('labels a title-only all-day update by its civil DATE in %s', async timezone => {
    const f = fixture(timezone);
    const input = { event_id: ID, title: 'Renamed' };
    const actualTool = tool('calendar.updateEvent');
    const result = await actualTool.execute(f.scope, input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toMatchObject({ title: 'Renamed', when: 'all day 2026-11-14', all_day: true });
    expect(actualTool.output.safeParse(result.data).success).toBe(true);
    expect(actualTool.summarize(input, result.data)).toContain('all day 2026-11-14');
    expect(f.calls.map(call => call.method)).toEqual(['PATCH']);
    expect(f.row().starts_at).toBe('2026-11-14T00:00:00.000Z');
  });

  it.each(ZONES)('reschedules an all-day DATE without adding a clock in %s', async timezone => {
    const f = fixture(timezone);
    const input = { event_id: ID, starts_at: '2026-11-15' };
    const actualTool = tool('calendar.rescheduleEvent');
    const result = await actualTool.execute(f.scope, input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toMatchObject({ when: 'all day 2026-11-15', all_day: true, starts_at: '2026-11-15T00:00:00.000Z', ends_at: '2026-11-16T00:00:00.000Z' });
    expect(actualTool.output.safeParse(result.data).success).toBe(true);
    expect(actualTool.summarize(input, result.data)).toContain('all day 2026-11-15');
    expect(f.calls.map(call => call.method)).toEqual(['GET', 'PATCH']);
  });
});

describe('timed labels retain family timezone formatting', () => {
  for (const operation of ['createEvent', 'updateEvent', 'rescheduleEvent']) {
    it.each(ZONES)(`${operation} still describes a family wall time in %s`, async timezone => {
      const f = fixture(timezone, false);
      const result = await tool(`calendar.${operation}`).execute(f.scope, {
        event_id: ID, title: 'Synthetic', starts_at: '2026-11-14T09:00:00', ends_at: '2026-11-14T10:00:00', all_day: false,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.data).toMatchObject({ all_day: false, when: ['Asia/Tokyo', 'Pacific/Kiritimati'].includes(timezone) ? '9:00 AM Sat, Nov 14' : '9:00 AM Saturday' });
      expect(result.data).not.toMatchObject({ when: expect.stringContaining('all day') });
      expect(f.calls.some(call => call.method === 'POST' || call.method === 'PATCH')).toBe(true);
    });
  }
});

describe('DATE documentation does not broaden strict write admission', () => {
  it.each([
    ['2026-11-14T00:00:00', undefined],
    ['2026-11-14T12:00:00Z', undefined],
    ['2026-11-14T00:00:00.000001Z', undefined],
    ['2026-11-14T19:00:00-05:00', undefined],
    ['2026-11-14', '2026-11-14'],
    ['2026-11-14', '2026-11-13'],
  ])('refuses noncanonical or reversed all-day input %s/%s before a write', async (start, end) => {
    const f = fixture('America/New_York');
    expect(await tool('calendar.createEvent').execute(f.scope, { title: 'Synthetic', starts_at: start, ends_at: end, all_day: true })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(f.calls).toHaveLength(0);
  });

  it.each(['updateEvent', 'rescheduleEvent'])('%s refuses a floating DATE without mutating it', async operation => {
    const f = fixture('America/New_York');
    expect(await tool(`calendar.${operation}`).execute(f.scope, { event_id: ID, starts_at: '2026-11-14T00:00:00' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
    expect(f.row().starts_at).toBe('2026-11-14T00:00:00.000Z');
  });
});
