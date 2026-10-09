import { calendarTools } from '@/lib/ai/tools/calendar';
import { parseExactInstant } from '@/lib/calendar/exact-instant';
import { readCompleteCalendarOccurrences } from '@/lib/services/calendar/search-occurrences';
import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createEvent, createEvents, deleteEvent, deleteEvents, rescheduleAfter, updateEvent } from '@/lib/services/calendar';

vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => () => 'Already saved' }));
vi.mock('@/lib/calendar/source-capability', () => ({ CALENDAR_SOURCE_ARCHIVE_ENABLED: false }));
const family = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const otherFamily = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const id = 'cccccccc-cccc-4ccc-8ccc-000000000001';
type Row = { id: string; family_id: string; title: string; feed_id: string | null; external_uid: string | null };
type Operation = 'update' | 'delete' | 'batch';
const native = (extra: Partial<Row> = {}): Row => ({ id, family_id: family, title: 'Synthetic original', feed_id: null, external_uid: null, ...extra });

function fixture(initial: Row[], takeover?: (rows: Row[]) => void) {
  const rows = initial.map(row => ({ ...row }));
  const calls: { method: string; query: Record<string, string>; payload: unknown }[] = [];
  const db = createClient<Database>('https://synthetic.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://synthetic.invalid');
      expect(url.pathname).toBe('/rest/v1/calendar_events');
      const method = init?.method ?? 'GET';
      expect(['PATCH', 'DELETE']).toContain(method);
      const query = Object.fromEntries(url.searchParams);
      const payload = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, query, payload });
      // Ownership can change immediately before the actual database mutation;
      // admission must be a predicate on that mutation, not an earlier read.
      takeover?.(rows);
      const matches = rows.filter(row => [...url.searchParams].every(([column, value]) => {
        if (column === 'select') return true;
        const field = row[column as keyof Row];
        if (value.startsWith('eq.')) return field === value.slice(3);
        if (value === 'is.null') return field === null;
        if (value.startsWith('in.(')) return value.slice(4, -1).split(',').includes(String(field));
        throw new Error(`Unsupported synthetic filter ${column}=${value}`);
      }));
      const saved = matches.map(row => ({ ...row, ...(method === 'PATCH' ? payload : {}) }));
      if (method === 'PATCH') matches.forEach(row => Object.assign(row, payload));
      else matches.forEach(row => rows.splice(rows.indexOf(row), 1));
      return new Response(JSON.stringify(saved), { headers: { 'Content-Type': 'application/json' } });
    } },
  });
  const scope: ServiceScope = { db, familyId: family, memberId: 'synthetic-member', userId: 'synthetic-user', role: 'parent', actorKind: 'member', tz: 'UTC' };
  return { rows, calls, run: (operation: Operation, ids = [id]) => operation === 'update'
    ? updateEvent(scope, ids[0], { title: 'Synthetic changed' })
    : operation === 'delete' ? deleteEvent(scope, ids[0]) : deleteEvents(scope, ids) };
}

describe('native calendar writes use atomic source ownership predicates', () => {
  it.each<Operation>(['update', 'delete', 'batch'])('preserves a normal native %s', async operation => {
    const f = fixture([native()]);
    expect(await f.run(operation)).toMatchObject({ ok: true });
    expect(f.calls).toHaveLength(1);
    expect(operation === 'update' ? f.rows[0].title : f.rows.length).toBe(operation === 'update' ? 'Synthetic changed' : 0);
  });

  for (const source of [
    { feed_id: 'synthetic-feed', external_uid: 'synthetic-uid' },
    { feed_id: 'synthetic-feed', external_uid: null },
    { feed_id: null, external_uid: 'synthetic-uid' },
  ]) {
    it.each<Operation>(['update', 'delete', 'batch'])(`refuses source row ${JSON.stringify(source)} through %s`, async operation => {
      const original = native(source), f = fixture([original]);
      const result = await f.run(operation);
      expect(result).toMatchObject(operation === 'batch' ? { ok: true, data: { removed: 0 } } : { ok: false, code: 'not_found' });
      expect(f.rows).toEqual([original]);
    });
  }

  it.each<Operation>(['update', 'delete', 'batch'])('retains the foreign-family boundary during %s', async operation => {
    const original = native({ family_id: otherFamily }), f = fixture([original]);
    expect(await f.run(operation)).toMatchObject(operation === 'batch' ? { ok: true, data: { removed: 0 } } : { ok: false, code: 'not_found' });
    expect(f.rows).toEqual([original]);
    expect(f.calls[0].query.family_id).toBe(`eq.${family}`);
  });

  it.each<Operation>(['update', 'delete', 'batch'])('refuses concurrent feed takeover at the actual %s', async operation => {
    const f = fixture([native()], rows => { rows[0].feed_id = 'new-source-owner'; });
    expect(await f.run(operation)).toMatchObject(operation === 'batch' ? { ok: true, data: { removed: 0 } } : { ok: false, code: 'not_found' });
    expect(f.rows).toEqual([native({ feed_id: 'new-source-owner' })]);
    expect(f.calls).toHaveLength(1); // No preflight ownership read.
    expect(f.calls[0].query).toMatchObject({ feed_id: 'is.null', external_uid: 'is.null', family_id: `eq.${family}` });
  });

  it('bulk deletion removes only the native subset from mixed family/source rows', async () => {
    const imported = native({ id: 'cccccccc-cccc-4ccc-8ccc-000000000002', feed_id: 'synthetic-feed', external_uid: 'uid' });
    const foreign = native({ id: 'cccccccc-cccc-4ccc-8ccc-000000000003', family_id: otherFamily });
    const f = fixture([native(), imported, foreign]);
    expect(await f.run('batch', [id, imported.id, foreign.id])).toMatchObject({ ok: true, data: { removed: 1 } });
    expect(f.rows).toEqual([imported, foreign]);
  });

  it('an empty batch performs no database request', async () => {
    const f = fixture([native()]);
    expect(await f.run('batch', [])).toMatchObject({ ok: true, data: { removed: 0 } });
    expect(f.calls).toEqual([]);
  });
});

describe('native calendar exact write and captured-state boundary', () => {
    const FAMILY = '10000000-0000-4000-8000-000000000001', ID = '20000000-0000-4000-8000-000000000001';
    type FixtureEvent = Tables<'calendar_events'> & { source_recurrence: null };
    const base: FixtureEvent & { ends_at: string } = { id: ID, family_id: FAMILY, title: 'Synthetic', description: null, location: null, category: 'general', starts_at: '2026-10-08T09:00:00.000001Z', ends_at: '2026-10-08T09:00:00.000009Z', all_day: false, recurrence: 'none', recurrence_until: null, assignee_id: null, feed_id: null, external_uid: null, created_by: null, onboarding_key: null, idempotency_key: null, source_recurrence: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
    function fixture(seed: FixtureEvent[] = [], beforePatch?: (rows: FixtureEvent[]) => void) {
        const rows = structuredClone(seed);
        const calls: {
            method: string;
            body: unknown;
            url: string;
        }[] = [];
        const db = createClient<Database>('https://calendar-write.synthetic.invalid', 'synthetic', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
                    const u = new URL(String(input)), method = init?.method ?? 'GET';
                    expect(u.origin).toBe('https://calendar-write.synthetic.invalid');
                    expect(u.pathname).toBe('/rest/v1/calendar_events');
                    const body: Record<string, unknown> | Record<string, unknown>[] | null = init?.body ? JSON.parse(String(init.body)) : null;
                    calls.push({ method, body, url: u.toString() });
                    if (method === 'POST') {
                        if (body === null)
                            throw Error('Synthetic POST needs a body');
                        const inputs = Array.isArray(body) ? body : [body];
                        const inserted = inputs.map((r, i) => ({ ...base, ...r, id: `20000000-0000-4000-8000-${String(rows.length + i + 1).padStart(12, '0')}` }));
                        rows.push(...inserted);
                        return Response.json(Array.isArray(body) ? inserted : inserted[0]);
                    }
                    expect(u.searchParams.get('family_id')).toBe('eq.' + FAMILY);
                    const matches = (r: FixtureEvent) => [...u.searchParams].every(([key, value]) => {
                        if (['id', 'family_id', 'idempotency_key', 'starts_at', 'ends_at', 'all_day', 'feed_id', 'external_uid'].includes(key)) {
                            const field = r[key as keyof typeof base];
                            if (value === 'is.null')
                                return field === null;
                            if (value.startsWith('eq.')) {
                                const wanted = value.slice(3);
                                if (key === 'starts_at' || key === 'ends_at')
                                    return typeof field === 'string' && parseExactInstant(field) === parseExactInstant(wanted);
                                if (key === 'all_day')
                                    return field === (wanted === 'true');
                                return field === wanted;
                            }
                        }
                        return true;
                    });
                    if (method === 'PATCH')
                        beforePatch?.(rows);
                    let found = rows.filter(matches);
                    if (method === 'PATCH') {
                        expect(u.searchParams.get('feed_id')).toBe('is.null');
                        expect(u.searchParams.get('external_uid')).toBe('is.null');
                        found = found.filter(r => r.feed_id === null && r.external_uid === null);
                        found.forEach(r => Object.assign(r, body));
                        return Response.json(found[0] ?? null);
                    }
                    expect(method).toBe('GET');
                    const accept = new Headers(init?.headers).get('accept') ?? '';
                    if (accept.includes('vnd.pgrst.object'))
                        return Response.json(found[0] ?? null);
                    if (u.searchParams.has('recurrence'))
                        found = found.filter(r => u.searchParams.get('recurrence') === 'neq.none' ? r.recurrence !== 'none' : r.recurrence === 'none');
                    return Response.json(found, { headers: { 'Content-Range': `0-${Math.max(found.length - 1, 0)}/${found.length}` } });
                } } });
        return { rows, calls, scope: { db, familyId: FAMILY, userId: null, memberId: null, role: 'system' as const, actorKind: 'system' as const, tz: 'America/New_York', now: new Date('2026-10-08T08:00:00Z') } };
    }
    it('healthy millisecond explicit offset create preserves known instant', async () => { const f = fixture(); const r = await createEvent(f.scope, { title: 'Synthetic', startsAt: '2026-10-08T18:00:00.123+09:00', endsAt: '2026-10-08T18:00:00.124+09:00' }); expect(r.ok).toBe(true); expect(f.rows[0]).toMatchObject({ starts_at: '2026-10-08T09:00:00.123Z', ends_at: '2026-10-08T09:00:00.124Z' }); });
    it('healthy canonical DATE create remains visible in qualified reader', async () => { const f = fixture(); expect((await createEvent(f.scope, { title: 'Synthetic', startsAt: '2026-10-08', endsAt: '2026-10-09', allDay: true })).ok).toBe(true); const r = await readCompleteCalendarOccurrences(f.scope, { from: '2026-10-08T00:00:00Z', to: '2026-10-09T23:59:59.999Z' }); expect(r.ok).toBe(true); if (r.ok)
        expect(r.data.totalVisibleCount).toBe(1); });
    it('healthy millisecond reschedule preserves duration', async () => { const f = fixture([{ ...base, starts_at: '2026-10-08T09:00:00.001Z', ends_at: '2026-10-08T09:00:00.009Z' }]); expect((await rescheduleAfter(f.scope, ID, { startsAt: '2026-10-09T09:00:00.003Z' })).ok).toBe(true); expect(f.rows[0].ends_at).toBe('2026-10-09T09:00:00.011Z'); });
    it('healthy native update refuses publisher-owned row', async () => { const f = fixture([{ ...base, feed_id: '30000000-0000-4000-8000-000000000001' }]); expect((await updateEvent(f.scope, ID, { title: 'Changed' })).ok).toBe(false); expect(f.rows[0].title).toBe('Synthetic'); });
    it('create preserves genuine positive 8microsecond interval', async () => { const f = fixture(); expect((await createEvent(f.scope, { title: 'Synthetic', startsAt: base.starts_at, endsAt: base.ends_at })).ok).toBe(true); expect(f.rows[0]).toMatchObject({ starts_at: base.starts_at, ends_at: base.ends_at }); });
    it('batch create preserves microsecond endpoints', async () => { const f = fixture(); expect((await createEvents(f.scope, [{ title: 'Synthetic', startsAt: base.starts_at, endsAt: base.ends_at }])).ok).toBe(true); expect(f.rows[0].ends_at).toBe(base.ends_at); });
    it('update preserves genuine microsecond endpoints', async () => { const f = fixture([base]); expect((await updateEvent(f.scope, ID, { startsAt: '2026-10-08T10:00:00.000001Z', endsAt: '2026-10-08T10:00:00.000009Z' })).ok).toBe(true); expect(f.rows[0].starts_at).toBe('2026-10-08T10:00:00.000001Z'); });
    it('reschedule preserves 8microsecond duration and precise new start', async () => { const f = fixture([base]); expect((await rescheduleAfter(f.scope, ID, { startsAt: '2026-10-09T09:00:00.000003Z' })).ok).toBe(true); expect(f.rows[0]).toMatchObject({ starts_at: '2026-10-09T09:00:00.000003Z', ends_at: '2026-10-09T09:00:00.000011Z' }); });
    it('reversed microsecond create refuses before write', async () => { const f = fixture(); expect((await createEvent(f.scope, { title: 'Synthetic', startsAt: base.ends_at, endsAt: base.starts_at })).ok).toBe(false); expect(f.calls).toHaveLength(0); });
    it('noncanonical DATE create cannot succeed then vanish behind qualified read refusal', async () => { const f = fixture(); const made = await createEvent(f.scope, { title: 'Synthetic', startsAt: '2026-10-08T01:00:00Z', endsAt: '2026-10-09T01:00:00Z', allDay: true }); const read = await readCompleteCalendarOccurrences(f.scope, { from: '2026-10-08T00:00:00Z', to: '2026-10-09T23:59:59.999Z' }); expect(made.ok).toBe(false); expect(f.rows).toHaveLength(0); expect(read.ok).toBe(true); });
    it('equal-boundary DATE create refuses before write', async () => { const f = fixture(); expect((await createEvent(f.scope, { title: 'Synthetic', startsAt: '2026-10-08', endsAt: '2026-10-08', allDay: true })).ok).toBe(false); expect(f.calls).toHaveLength(0); });
    it('microsecond malformed DATE cannot be silently rewritten to canonical', async () => { const f = fixture(); expect((await createEvent(f.scope, { title: 'Synthetic', startsAt: '2026-10-08T00:00:00.000001Z', endsAt: '2026-10-09T00:00:00Z', allDay: true })).ok).toBe(false); expect(f.calls).toHaveLength(0); });
    it('changed keyed retry cannot silently return a distinct microsecond instant', async () => { const f = fixture([{ ...base, idempotency_key: 'synthetic-owned-key' }]); const r = await createEvent({ ...f.scope, idempotencyKey: 'synthetic-owned-key' }, { title: base.title, startsAt: '2026-10-08T09:00:00.000002Z', endsAt: base.ends_at }, { rejectChangedRetry: true }); expect(f.calls.every(c => c.method === 'GET')).toBe(true); expect(r.ok).toBe(false); });
    it('valid canonical spring DATE retains exact 23hour family occupancy', async () => { const f = fixture(); expect((await createEvent(f.scope, { title: 'Synthetic', startsAt: '2026-03-08', endsAt: '2026-03-09', allDay: true })).ok).toBe(true); const r = await readCompleteCalendarOccurrences(f.scope, { from: '2026-03-08T05:00:00Z', to: '2026-03-09T03:59:59.999Z' }); expect(r.ok).toBe(true); if (r.ok) {
        expect(r.data.occurrences).toHaveLength(1);
        expect(r.data.occurrences[0].interval.end - r.data.occurrences[0].interval.start).toBe(23 * 3600000);
    } });
    it('invalid civil write clock cannot silently roll to another day', async () => { const f = fixture(); expect((await createEvent(f.scope, { title: 'Synthetic', startsAt: '2026-02-30T09:00:00Z' })).ok).toBe(false); expect(f.calls).toHaveLength(0); });
    it('partial end-only update cannot create reversed native interval', async () => { const f = fixture([base]); expect((await updateEvent(f.scope, ID, { endsAt: '2026-10-07T09:00:00Z' })).ok).toBe(false); expect(f.calls.every(c => c.method === 'GET')).toBe(true); });
    it('healthy explicit millisecond point remains point after create and qualified read', async () => { const f = fixture(); expect((await createEvent(f.scope, { title: 'Synthetic', startsAt: '2026-10-08T09:00:00.001Z', endsAt: '2026-10-08T09:00:00.001Z' })).ok).toBe(true); const r = await readCompleteCalendarOccurrences(f.scope, { from: '2026-10-08T00:00:00Z', to: '2026-10-09T23:59:59.999Z' }); expect(r.ok).toBe(true); if (r.ok)
        expect(r.data.occurrences[0]).toMatchObject({ point: true, occupied: false }); });
    it('floating writer means household clock in every hostzone', async () => { const f = fixture(); expect((await createEvent(f.scope, { title: 'Synthetic', startsAt: '2026-10-08T09:00:00.000001' })).ok).toBe(true); expect(f.rows[0].starts_at).toBe('2026-10-08T13:00:00.000001Z'); });
    it('floating spring gap uses RFC offset and preserves fractions', async () => { const f = fixture(); expect((await createEvent(f.scope, { title: 'Synthetic', startsAt: '2026-03-08T02:30:07.123456' })).ok).toBe(true); expect(f.rows[0].starts_at).toBe('2026-03-08T07:30:07.123456Z'); });
    it('floating autumn fold uses first occurrence', async () => { const f = fixture(); expect((await createEvent(f.scope, { title: 'Synthetic', startsAt: '2026-11-01T01:30' })).ok).toBe(true); expect(f.rows[0].starts_at).toBe('2026-11-01T05:30:00.000Z'); });
    it('write refuses finer than PostgreSQL microseconds without rounding', async () => { const f = fixture(); expect((await createEvent(f.scope, { title: 'Synthetic', startsAt: '2026-10-08T09:00:00.000000001Z' })).ok).toBe(false); expect(f.calls).toHaveLength(0); });
    it('writer accepts nanosecond-padded microsecond value without changing it', async () => { const f = fixture(); expect((await createEvent(f.scope, { title: 'Synthetic', startsAt: '2026-10-08T09:00:00.123456000Z' })).ok).toBe(true); expect(f.rows[0].starts_at).toBe('2026-10-08T09:00:00.123456Z'); });
    it('nonempty invalid optional end refuses rather than clearing', async () => { const f = fixture([base]); expect((await updateEvent(f.scope, ID, { endsAt: 'invalid-clock' })).ok).toBe(false); expect(f.calls).toHaveLength(0); expect(f.rows[0].ends_at).toBe(base.ends_at); });
    it('nonempty invalid recurrence until refuses before create', async () => { const f = fixture(); expect((await createEvent(f.scope, { title: 'Synthetic', startsAt: base.starts_at, recurrenceUntil: 'invalid-clock' })).ok).toBe(false); expect(f.calls).toHaveLength(0); });
    it('temporal update detects concurrent end change at actual CAS mutation', async () => { const seed = { ...base, ends_at: '2026-10-08T10:00:00Z' }; const f = fixture([seed], rows => { rows[0].ends_at = '2026-10-08T09:15:00Z'; }); expect((await updateEvent(f.scope, ID, { startsAt: '2026-10-08T09:30:00Z' })).ok).toBe(false); expect(f.rows[0]).toMatchObject({ starts_at: seed.starts_at, ends_at: '2026-10-08T09:15:00Z' }); expect(f.calls.filter(c => c.method === 'PATCH')).toHaveLength(1); });
    it('reschedule uses same captured duration and CAS even concurrent old-start change', async () => { const f = fixture([base], rows => { rows[0].starts_at = '2026-10-08T09:00:00.000003Z'; }); expect((await rescheduleAfter(f.scope, ID, { startsAt: '2026-10-09T09:00:00.000003Z' })).ok).toBe(false); expect(f.rows[0].ends_at).toBe(base.ends_at); expect(f.calls.filter(c => c.method === 'GET')).toHaveLength(1); });
    it('temporal update CAS protects persisted allDay during concurrent transition', async () => { const f = fixture([{ ...base, starts_at: '2026-10-08T00:00:00Z', ends_at: '2026-10-09T00:00:00Z', all_day: false }], rows => { rows[0].all_day = true; }); expect((await updateEvent(f.scope, ID, { startsAt: '2026-10-08T01:00:00Z' })).ok).toBe(false); expect(f.rows[0].starts_at).toBe('2026-10-08T00:00:00Z'); expect(f.rows[0].all_day).toBe(true); });
    it('temporal update still protects concurrent source takeover', async () => { const f = fixture([base], rows => { rows[0].feed_id = '30000000-0000-4000-8000-000000000001'; }); expect((await updateEvent(f.scope, ID, { startsAt: '2026-10-08T08:00:00Z' })).ok).toBe(false); expect(f.rows[0].starts_at).toBe(base.starts_at); });
    it('partial DATE end uses persisted allDay and rejects nonmidnight', async () => { const f = fixture([{ ...base, starts_at: '2026-10-08T00:00:00Z', ends_at: '2026-10-09T00:00:00Z', all_day: true }]); expect((await updateEvent(f.scope, ID, { endsAt: '2026-10-09T01:00:00Z' })).ok).toBe(false); expect(f.calls.every(c => c.method === 'GET')).toBe(true); });
    it('legacy explicit-offset minute precision remains accepted as a known instant', async () => { const f = fixture(); expect((await createEvent(f.scope, { title: 'Synthetic', startsAt: '2026-10-08T18:00+09:00' })).ok).toBe(true); expect(f.rows[0].starts_at).toBe('2026-10-08T09:00:00.000Z'); });
    it('actual reschedule tool verification rejects a distinct same-ms saved instant', async () => { const f = fixture([{ ...base, starts_at: '2026-10-08T09:00:00.000001Z' }]); const tool = calendarTools.find(t => t.name === 'calendar.rescheduleEvent')!; const r = await tool.verify!(f.scope, { event_id: ID, starts_at: '2026-10-08T09:00:00.000002Z' }, { id: ID, title: 'Synthetic' }); expect(r).toMatchObject({ ok: true, data: { verified: false } }); });
    it('actual reschedule tool verification accepts equivalent exact offset alias', async () => { const f = fixture([{ ...base, starts_at: '2026-10-08T09:00:00.123456Z' }]); const tool = calendarTools.find(t => t.name === 'calendar.rescheduleEvent')!; const r = await tool.verify!(f.scope, { event_id: ID, starts_at: '2026-10-08T18:00:00.123456+09:00' }, { id: ID, title: 'Synthetic' }); expect(r).toMatchObject({ ok: true, data: { verified: true } }); });
    for (const [label, value] of [['minute offset', '2026-10-09T18:00+09:00'], ['trimmed offset', '  2026-10-09T18:00:00.000003+09:00  ']]) {
        it('actual tool execute and verify agree for accepted ' + label, async () => { const f = fixture([base]); const tool = calendarTools.find(t => t.name === 'calendar.rescheduleEvent')!; const input = { event_id: ID, starts_at: value }; const result = await tool.execute(f.scope, input); expect(result.ok).toBe(true); if (!result.ok)
            throw Error('Expected synthetic move'); expect(await tool.verify!(f.scope, input, result.data)).toMatchObject({ ok: true, data: { verified: true } }); });
    }
it('same-prefix offset UTC midnight DATE stays accepted',async()=>{const f=fixture();expect((await createEvent(f.scope,{title:'Synthetic',startsAt:'2026-10-08T09:00:00+09:00',endsAt:'2026-10-09T09:00:00+09:00',allDay:true})).ok).toBe(true);expect(f.rows[0].starts_at).toBe('2026-10-08T00:00:00.000Z');});
it('timed offset daywrap remains a valid explicit instant',async()=>{const f=fixture();expect((await createEvent(f.scope,{title:'Synthetic',startsAt:'2026-10-08T19:00:00-05:00',endsAt:'2026-10-09T19:00:00-05:00'})).ok).toBe(true);expect(f.rows[0].starts_at).toBe('2026-10-09T00:00:00.000Z');});
it('DATE offset daywrap create must refuse rather than shift civil label',async()=>{const f=fixture();expect((await createEvent(f.scope,{title:'Synthetic',startsAt:'2026-10-08T19:00:00-05:00',endsAt:'2026-10-09T19:00:00-05:00',allDay:true})).ok).toBe(false);expect(f.rows).toHaveLength(0);});
it('DATE offset daywrap batch must refuse before writes',async()=>{const f=fixture();expect((await createEvents(f.scope,[{title:'Synthetic',startsAt:'2026-10-08T19:00:00-05:00',endsAt:'2026-10-09T19:00:00-05:00',allDay:true}])).ok).toBe(false);expect(f.rows).toHaveLength(0);});
it('persisted DATE end patch cannot shift civil label',async()=>{const f=fixture([{...base,all_day:true,starts_at:'2026-10-08T00:00:00Z',ends_at:'2026-10-09T00:00:00Z'}]);expect((await updateEvent(f.scope,ID,{endsAt:'2026-10-09T19:00:00-05:00'})).ok).toBe(false);expect(f.rows[0].ends_at).toBe('2026-10-09T00:00:00Z');});
it('DATE reschedule target cannot shift civil label',async()=>{const f=fixture([{...base,all_day:true,starts_at:'2026-10-08T00:00:00Z',ends_at:'2026-10-09T00:00:00Z'}]);expect((await rescheduleAfter(f.scope,ID,{startsAt:'2026-10-09T19:00:00-05:00'})).ok).toBe(false);expect(f.rows[0].starts_at).toBe('2026-10-08T00:00:00Z');});
it('persisted DATE start patch cannot shift original civil label',async()=>{const f=fixture([{...base,all_day:true,starts_at:'2026-10-08T00:00:00Z',ends_at:'2026-10-11T00:00:00Z'}]);expect((await updateEvent(f.scope,ID,{startsAt:'2026-10-08T19:00:00-05:00'})).ok).toBe(false);expect(f.calls.every(c=>c.method==='GET')).toBe(true);});
it('transition to DATE validates original patched labels',async()=>{const f=fixture([{...base,starts_at:'2026-10-08T00:00:00Z',ends_at:'2026-10-11T00:00:00Z'}]);expect((await updateEvent(f.scope,ID,{allDay:true,startsAt:'2026-10-08T19:00:00-05:00'})).ok).toBe(false);expect(f.calls.every(c=>c.method==='GET')).toBe(true);});
it('batch refuses a later wrapped DATE before inserting healthy earlier entry',async()=>{const f=fixture();expect((await createEvents(f.scope,[{title:'Healthy',startsAt:'2026-10-08',allDay:true},{title:'Wrapped',startsAt:'2026-10-08T19:00:00-05:00',allDay:true}])).ok).toBe(false);expect(f.calls).toHaveLength(0);});
it('DATE reschedule accepts same-prefix UTCmidnight offset alias preserving duration',async()=>{const f=fixture([{...base,all_day:true,starts_at:'2026-10-08T00:00:00Z',ends_at:'2026-10-09T00:00:00Z'}]);expect((await rescheduleAfter(f.scope,ID,{startsAt:'2026-10-09T09:00:00+09:00'})).ok).toBe(true);expect(f.rows[0]).toMatchObject({starts_at:'2026-10-09T00:00:00.000Z',ends_at:'2026-10-10T00:00:00.000Z'});});

});
