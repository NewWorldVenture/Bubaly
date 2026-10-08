import { describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { buildAssistantTools } from '@/lib/assistant/tools';
import { createInMemorySupabase, orPredicate } from './helpers/in-memory-supabase';
const family = 'synthetic-family';
const row = (id: string, start: string, end: string | null, extra = {}) => ({ id, family_id: family, title: id, starts_at: start, ends_at: end, all_day: false, recurrence: 'none', recurrence_until: null, assignee_id: null, ...extra });
type SourceRow = { id: string; family_id: string; starts_at: string; ends_at: string | null; member_id: string | null; recurrence: string };
type Options = { school?: SourceRow[]; sports?: SourceRow[]; members?: { id: string; display_name: string }[]; fail?: string };
const source = (id: string, extra: Partial<SourceRow> = {}): SourceRow => ({ id, family_id: family, starts_at: '2026-10-10T10:00:00.000Z', ends_at: '2026-10-10T11:00:00.000Z', member_id: null, recurrence: 'none', ...extra });
async function run(rows: ReturnType<typeof row>[], date = '2026-10-10', tz = 'UTC', args = {}, options: Options = {}) {
  const db = createInMemorySupabase({ maxRows: 2 }); db.seed('calendar_events', rows);
  db.seed('school_events', options.school ?? []); db.seed('sports_events', options.sports ?? []);
  const scoped = new Proxy(db, { get(target, key) {
    if (key === 'from') return (table: string) => {
      if (table === options.fail) throw new Error('Synthetic unavailable source');
      return target.from(table);
    };
    return Reflect.get(target, key);
  } });
  const tool = buildAssistantTools(scoped as unknown as SupabaseClient<Database>, { familyId: family, userId: 'synthetic-user', memberId: null, members: options.members ?? [], tz }).find(t => t.name === 'find_free_time')!;
  return await tool.execute({ date, ...args }) as { ok: boolean; busy?: Array<{ title: string; start: string; end: string | null; all_day: boolean; starts_at: string; ends_at: string | null }>; note?: string; error?: string };
}
describe('actual assistant free-time tool complete overlap boundary', () => {
  it('refuses a later date of a sports series rather than treating an older master as no commitment', async () => {
    const result = await run([], undefined, undefined, {}, { sports: [source('weekly practice', { starts_at: '2026-10-03T10:00:00.000Z', ends_at: '2026-10-03T11:00:00.000Z', recurrence: 'weekly' })] });
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty('busy'); expect(result.note).toBeUndefined();
  });
  it('does not let foreign-family sports series disable this family availability', async () => {
    const result = await run([], undefined, undefined, {}, { sports: [source('foreign series', { family_id: 'other-family', recurrence: 'weekly' })] });
    expect(result.ok).toBe(true); expect(result.busy).toEqual([]);
  });
  it('includes an ongoing overnight commitment and clips it to this day', async () => {
    const result = await run([row('Overnight occupied', '2026-10-09T23:30:00.000Z', '2026-10-10T02:00:00.000Z')]);
    expect(result.ok).toBe(true); expect(result.busy).toHaveLength(1); expect(result.busy![0]).toMatchObject({ title: 'Overnight occupied', starts_at: '2026-10-10T00:00:00.000Z', ends_at: '2026-10-10T02:00:00.000Z' }); expect(result.note).not.toContain('whole day is free');
  });
  it('keeps the 51st evening commitment with server-capped pages', async () => {
    const result = await run([...Array.from({ length: 50 }, (_, n) => row(`Morning-${n}`, '2026-10-10T09:00:00.000Z', '2026-10-10T10:00:00.000Z')), row('Evening occupied', '2026-10-10T20:00:00.000Z', '2026-10-10T21:00:00.000Z')]);
    expect(result.ok).toBe(true); expect(result.busy).toHaveLength(51); expect(result.busy!.some(b => b.title === 'Evening occupied')).toBe(true);
  });
  it('clips a commitment spanning the full 25-hour family fall-back day', async () => {
    const result = await run([row('Full day occupied', '2026-11-01T03:00:00.000Z', '2026-11-02T06:00:00.000Z')], '2026-11-01', 'America/New_York');
    expect(result.busy).toMatchObject([{ starts_at: '2026-11-01T04:00:00.000Z', ends_at: '2026-11-02T05:00:00.000Z' }]);
  });
  it('retains a multi-day all-day commitment on its own civil day', async () => {
    const result = await run([row('Trip', '2026-10-09T00:00:00.000Z', '2026-10-12T00:00:00.000Z', { all_day: true })], '2026-10-10', 'America/Los_Angeles');
    expect(result.busy).toMatchObject([{ title: 'Trip', all_day: true, starts_at: '2026-10-10', ends_at: '2026-10-11', end: null }]); expect(result.busy![0].start).toContain('Oct 10');
  });
  it('preserves the one-hour missing-end convention and excludes foreign-family rows', async () => {
    const result = await run([row('Late arrival', '2026-10-09T23:30:00.000Z', null), row('Other family', '2026-10-10T09:00:00.000Z', '2026-10-10T10:00:00.000Z', { family_id: 'foreign-family' })]);
    expect(result.busy).toMatchObject([{ title: 'Late arrival', starts_at: '2026-10-10T00:00:00.000Z', ends_at: '2026-10-10T00:30:00.000Z' }]); expect(result.busy).toHaveLength(1);
  });
  it('refuses an over-ceiling read instead of describing a partial day as free', async () => {
    const result = await run(Array.from({ length: 20_001 }, (_, n) => row(`Crowded-${n}`, '2026-10-10T09:00:00.000Z', '2026-10-10T10:00:00.000Z')));
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty('busy'); expect(result.note).toBeUndefined();
  });
  it('refuses an invalid civil date rather than reporting availability', async () => {
    const result = await run([], '2026-02-30'); expect(result.ok).toBe(false); expect(result).not.toHaveProperty('busy');
  });
  it.each(['school', 'sports'] as const)('includes %s when the native calendar is empty', async kind => {
    const result = await run([], undefined, undefined, {}, { [kind]: [source('occupied')] });
    expect(result.ok).toBe(true); expect(result.busy).toMatchObject([{ title: kind === 'school' ? 'School event' : 'Sports event', starts_at: '2026-10-10T10:00:00.000Z', ends_at: '2026-10-10T11:00:00.000Z' }]);
    expect(result.note).not.toContain('whole day is free');
  });
  it.each(['school', 'sports'] as const)('reads all capped %s pages and excludes foreign rows', async kind => {
    const result = await run([], undefined, undefined, {}, { [kind]: [...Array.from({ length: 5 }, (_, n) => source(`occupied-${n}`)), source('foreign', { family_id: 'foreign-family' })] });
    expect(result.ok).toBe(true); expect(result.busy).toHaveLength(5);
  });
  it.each(['calendar_events', 'school_events', 'sports_events'])('refuses availability when %s fails despite successful sibling sources', async fail => {
    const result = await run([], undefined, undefined, {}, { fail });
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty('busy'); expect(result.note).toBeUndefined();
  });
  it.each(['school', 'sports'] as const)('refuses over-ceiling %s rather than reporting partial availability', async kind => {
    const result = await run([], undefined, undefined, {}, { [kind]: Array.from({ length: 20_001 }, (_, n) => source(`occupied-${n}`)) });
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty('busy'); expect(result.note).toBeUndefined();
  });
  const members = [{ id: 'sam-a', display_name: 'Sam Jones' }, { id: 'sam-b', display_name: 'Sam Smith' }];
  it.each(['Sam', 'Missing Person', '', 123])('refuses ambiguous or unknown assignee %j', async assignee => {
    const result = await run([], undefined, undefined, { assignee }, { members, sports: [source('Sam Smith busy', { member_id: 'sam-b' })] });
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty('busy'); expect(result.note).toBeUndefined();
  });
  it('refuses duplicate exact roster names rather than silently choosing one', async () => {
    const result = await run([], undefined, undefined, { assignee: 'Sam' }, { members: members.map(m => ({ ...m, display_name: 'Sam' })) });
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty('busy');
  });
  it.each(['sAM sMITH', 'Smith'])('selects unique assignee %s and retains whole-family commitments from all sources', async assignee => {
    const result = await run([
      row('Family trip', '2026-10-10T00:00:00.000Z', '2026-10-11T00:00:00.000Z', { all_day: true }),
      row('Sam Smith busy', '2026-10-10T12:00:00.000Z', '2026-10-10T13:00:00.000Z', { assignee_id: 'sam-b' }),
      row('Sam Jones busy', '2026-10-10T12:00:00.000Z', '2026-10-10T13:00:00.000Z', { assignee_id: 'sam-a' }),
    ], undefined, undefined, { assignee }, { members,
      school: [source('family-school'), source('smith-school', { member_id: 'sam-b' }), source('jones-school', { member_id: 'sam-a' }), source('foreign-school', { family_id: 'foreign' })],
      sports: [source('family-sports'), source('smith-sports', { member_id: 'sam-b' }), source('jones-sports', { member_id: 'sam-a' }), source('foreign-sports', { family_id: 'foreign' })],
    });
    expect(result.ok).toBe(true); expect(result.busy).toHaveLength(6);
    expect(result.busy!.map(b => b.title).sort()).toEqual(['Family trip', 'Sam Smith busy', 'School event', 'School event', 'Sports event', 'Sports event']);
  });
  it('gives a unique exact name priority over other partial matches', async () => {
    const result = await run([], undefined, undefined, { assignee: 'Sam' }, { members: [{ id: 'sam-a', display_name: 'Sam' }, members[1]], sports: [source('exact', { member_id: 'sam-a' }), source('partial', { member_id: 'sam-b' })] });
    expect(result.ok).toBe(true); expect(result.busy).toHaveLength(1);
  });
  it('clips secondary-source overnight and missing-end blocks to the family day', async () => {
    const result = await run([], '2026-11-01', 'America/New_York', {}, {
      school: [source('school overnight', { starts_at: '2026-11-01T03:30:00.000Z', ends_at: '2026-11-01T06:30:00.000Z' })],
      sports: [source('sports missing end', { starts_at: '2026-11-01T03:30:00.000Z', ends_at: null })],
    });
    expect(result.busy).toMatchObject([
      { title: 'School event', starts_at: '2026-11-01T04:00:00.000Z', ends_at: '2026-11-01T06:30:00.000Z' },
      { title: 'Sports event', starts_at: '2026-11-01T04:00:00.000Z', ends_at: '2026-11-01T04:30:00.000Z' },
    ]);
  });
});

describe('assistant availability actual SDK transport completeness', () => {
  it.each(['series', 'missing-count', 'transport-rejection'])('refuses a previous-week sports master using a family-scoped exact count: %s', async mode => {
    const missingCount = mode === 'missing-count';
    let sawProbe = false;
    const masters = [source('previous-week practice', { starts_at: '2026-10-03T10:00:00.000Z', ends_at: '2026-10-03T11:00:00.000Z', recurrence: 'weekly' })];
    const db = createClient<Database>('https://synthetic.invalid', 'synthetic-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe('https://synthetic.invalid');
        const isProbe = init?.method === 'HEAD';
        if (isProbe) {
          sawProbe = true;
          expect(url.pathname).toBe('/rest/v1/sports_events');
          expect(url.searchParams.get('family_id')).toBe(`eq.${family}`);
          expect(url.searchParams.get('recurrence')).toBe('neq.none');
          expect(url.searchParams.get('starts_at')).toBe('lt.2026-10-11T00:00:00.000Z');
          expect(url.searchParams.has('limit')).toBe(false);
          expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');
          if (mode === 'transport-rejection') throw new Error('Synthetic sports recurrence transport rejection');
        }
        // The weekly October 3 master lies outside the October 10 busy query,
        // but the recurrence probe counts it. No provider/network is contacted.
        const matched = url.pathname.endsWith('/sports_events') ? masters.filter(row => [...url.searchParams].every(([key, value]) => {
          if (['select', 'order'].includes(key)) return true;
          if (key === 'or') return orPredicate(value.slice(1, -1))(row);
          const field = row[key as keyof SourceRow];
          if (value.startsWith('eq.')) return field === value.slice(3);
          if (value.startsWith('neq.')) return field != null && field !== value.slice(4);
          if (value.startsWith('lt.')) return String(field) < value.slice(3);
          throw new Error(`Unexpected SDK filter ${key}=${value}`);
        })) : [];
        expect(matched.length).toBe(isProbe ? 1 : 0);
        return new Response(isProbe ? null : JSON.stringify(matched), { headers: {
          'Content-Type': 'application/json',
          ...(!(isProbe && missingCount) ? { 'Content-Range': matched.length ? `0-${matched.length - 1}/${matched.length}` : '*/0' } : {}),
        } });
      } },
    });
    const tool = buildAssistantTools(db, { familyId: family, userId: 'synthetic-user', memberId: null, members: [], tz: 'UTC' }).find(t => t.name === 'find_free_time')!;
    const result = await tool.execute({ date: '2026-10-10' }) as { ok: boolean; busy?: unknown[]; note?: string };
    expect(sawProbe).toBe(true); expect(result.ok).toBe(false); expect(result).not.toHaveProperty('busy'); expect(result.note).toBeUndefined();
  });
  it.each([false, true])('uses stable counted family-scoped pages and refuses missing count=%s', async missingCount => {
    const calls: { table: string; query: Record<string, string>; prefer: string }[] = [];
    const db = createClient<Database>('https://synthetic.invalid', 'synthetic-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe('https://synthetic.invalid');
        const table = url.pathname.split('/').at(-1)!;
        const query = Object.fromEntries(url.searchParams);
        const prefer = new Headers(init?.headers).get('prefer') ?? '';
        calls.push({ table, query, prefer });
        const seeded = table === 'school_events' || table === 'sports_events'
          ? [...Array.from({ length: 5 }, (_, n) => source(`${table}-${n}`)), source('foreign', { family_id: 'foreign' })] : [];
        const matches = seeded.filter(row => [...url.searchParams].every(([key, value]) => {
          if (['select', 'order', 'offset', 'limit'].includes(key)) return true;
          if (key === 'or') return orPredicate(value.slice(1, -1))(row);
          const field = row[key as keyof SourceRow];
          if (value.startsWith('eq.')) return field === value.slice(3);
          if (value.startsWith('neq.')) return field != null && field !== value.slice(4);
          if (value.startsWith('lt.')) return String(field) < value.slice(3);
          throw new Error(`Unexpected SDK filter ${key}=${value}`);
        })).sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id));
        const first = Number(query.offset ?? 0), limit = Math.min(2, Number(query.limit ?? 2));
        const rows = matches.slice(first, first + limit);
        return new Response(init?.method === 'HEAD' ? null : JSON.stringify(rows), { headers: {
          'Content-Type': 'application/json',
          ...(missingCount && table === 'sports_events' ? {} : { 'Content-Range': `${first}-${first + rows.length - 1}/${matches.length}` }),
        } });
      } },
    });
    const tool = buildAssistantTools(db, { familyId: family, userId: 'synthetic-user', memberId: null, members: [], tz: 'UTC' }).find(t => t.name === 'find_free_time')!;
    const result = await tool.execute({ date: '2026-10-10' }) as { ok: boolean; busy?: unknown[]; note?: string };
    expect(result.ok).toBe(!missingCount);
    if (missingCount) { expect(result).not.toHaveProperty('busy'); expect(result.note).toBeUndefined(); }
    else expect(result.busy).toHaveLength(10);
    for (const call of calls) { expect(call.query.family_id).toBe(`eq.${family}`); expect(call.prefer).toContain('count=exact'); expect(call.query.order).toBe('starts_at.asc,id.asc'); }
    for (const table of ['school_events', 'sports_events']) {
      const offsets = calls.filter(call => call.table === table && !call.query.recurrence).map(call => Number(call.query.offset ?? 0));
      expect(offsets).toEqual(missingCount && table === 'sports_events' ? [0] : [0, 2, 4]);
    }
  });
});
