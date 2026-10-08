import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const sourceRoot = process.env.BUBALY_CALENDAR_DELETE_SOURCE_ROOT ?? process.cwd();
const sourcePaths = { calendar: 'lib/services/calendar/index.ts', types: 'lib/services/types.ts', errors: 'lib/supabase/errors.ts', eventDates: 'lib/calendar/event-dates.ts', calendarWindow: 'lib/briefing/calendar-window.ts', occurrences: 'lib/calendar/occurrences.ts', recurrence: 'lib/calendar/recurrence.ts', zoned: 'lib/time/zoned.ts', calendarDay: 'lib/calendar/day.ts', sourceCapability: 'lib/calendar/source-capability.ts' };
const sources = Object.fromEntries(Object.entries(sourcePaths).filter(([name]) => name !== 'sourceCapability').map(([name, file]) => [name, ts.transpileModule(fs.readFileSync(path.join(sourceRoot, file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText]));
// Historical source roots may predate this import. Read the exact real module
// only when their occurrences reader requests it; a missing requested file
// remains a hard ENOENT failure, never a fabricated or disabled capability.
function sourceFor(name: string): string {
  if (name === 'sourceCapability') return ts.transpileModule(fs.readFileSync(path.join(sourceRoot, sourcePaths.sourceCapability), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  if (!Object.hasOwn(sources, name)) throw new Error('Unknown finite source ' + name);
  return sources[name];
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', B = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const one = 'cccccccc-cccc-4ccc-8ccc-000000000001', two = 'cccccccc-cccc-4ccc-8ccc-000000000002';
const row1 = { id: one, title: 'Neutral first event' }, row2 = { id: two, title: 'Neutral second event' };
const traces: any[] = []; let trace: any;
beforeEach(() => { trace = { name: expect.getState().currentTestName, requests: [], forbidden: [], transportErrors: [], settled: 0, activity: [], sdkReplies: [], logs: [] }; vi.spyOn(console, 'error').mockImplementation((...args) => trace.logs.push(args)); });
afterEach(() => { traces.push(trace); expect(trace.forbidden).toEqual([]); expect(trace.transportErrors).toEqual([]); expect(trace.requests.length).toBeLessThanOrEqual(2); expect(trace.settled).toBe(trace.requests.length); expect(trace.requests.every((r: any) => r.method === 'DELETE' && r.table === 'calendar_events')).toBe(true); expect(trace.logs.every((args: any[]) => String(args[0]).startsWith('[service:calendar] batch delete failed'))).toBe(true); vi.restoreAllMocks(); });
afterAll(() => { if (process.env.BUBALY_CALENDAR_DELETE_TRACE) fs.writeFileSync(process.env.BUBALY_CALENDAR_DELETE_TRACE, JSON.stringify(traces, null, 2) + '\n', { flag: 'wx' }); });
type Options = { family?: string; ids?: string[]; body?: unknown; status?: number; adapter?: 'undefined' | 'dataWithError' };
function fixture(options: Options = {}) {
  const family = options.family ?? A, ids = options.ids ?? [one, two], body = Object.prototype.hasOwnProperty.call(options, 'body') ? options.body : [];
  const deny = (reason: string): never => { trace.forbidden.push(reason); throw new Error(reason); };
  const transport: typeof fetch = async (resource, init) => { try {
    const url = new URL(String(resource)), method = init?.method ?? 'GET', table = url.pathname.split('/').at(-1)!;
    if (url.origin !== 'https://calendar-delete.invalid' || method !== 'DELETE' || table !== 'calendar_events' || trace.requests.length >= 2 || init?.body) deny('Outside finite Calendar delete proof');
    const query = Object.fromEntries(url.searchParams), expectedIds = [...new Set(ids.filter(Boolean))];
    trace.requests.push({ method, table, query, payload: null });
    if (JSON.stringify(query) !== JSON.stringify({ family_id: 'eq.' + family, id: 'in.(' + expectedIds.join(',') + ')', feed_id: 'is.null', external_uid: 'is.null', select: 'id,title' })) deny('Delete query lacks exact family/filtered IDs/selected collection receipt');
    const status = options.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  } catch (e) { trace.transportErrors.push(String(e)); throw e; } finally { trace.settled++; } };
  const rawDb = createClient('https://calendar-delete.invalid', 'synthetic-key', { accessToken: async () => null, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
  // Two explicitly declared controls adapt the awaited reply after the actual installed SDK builds and executes the DELETE.
  const wrap = (builder: any): any => new Proxy(builder, { get(target, key) {
    if (key === 'then') return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => target.then((reply: any) => {
      trace.sdkReplies.push({ data: reply.data, error: reply.error, status: reply.status });
      const adapted = options.adapter === 'undefined' ? { ...reply, data: undefined } : { ...reply, data: [row1] };
      trace.effectiveReply = { dataIsUndefined: adapted.data === undefined, data: adapted.data, error: adapted.error };
      return resolve(adapted);
    }, reject);
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? (...args: any[]) => { const next = value.apply(target, args); return next && typeof next === 'object' ? wrap(next) : next; } : value;
  } });
  const db: any = options.adapter ? { from: (table: string) => wrap(rawDb.from(table)) } : rawDb;
  const scope: any = { db, familyId: family, userId: 'dddddddd-dddd-4ddd-8ddd-000000000001', memberId: 'eeeeeeee-eeee-4eee-8eee-000000000001', role: 'parent', actorKind: 'member', tz: 'UTC' };
  const loaded: any = {};
  const unused = (name: string) => new Proxy({}, { get: () => () => deny('Unused seam ' + name) });
  function load(name: string): any { if (loaded[name]) return loaded[name]; const entry = { exports: {} }; loaded[name] = entry.exports; const require = (id: string): any => {
    const dependency: Record<string, string> = { '@/lib/calendar/event-dates': 'eventDates', '@/lib/briefing/calendar-window': 'calendarWindow', '@/lib/calendar/occurrences': 'occurrences', '@/lib/calendar/recurrence': 'recurrence', '@/lib/time/zoned': 'zoned', '@/lib/calendar/day': 'calendarDay', './source-capability': 'sourceCapability' }; if (dependency[id]) return load(dependency[id]);
    if (id === '@/lib/calendar/availability') return { readCalendarAvailability: () => deny('Unused mutation read seam readCalendarAvailability') };
if (id === '@/lib/calendar/source-capability') return { CALENDAR_SOURCE_ARCHIVE_ENABLED: false };
    if (id === '@/lib/calendar/display-spans') return { calendarDisplayDay: () => deny('Unused read seam calendarDisplayDay') };
    if (id === '@/lib/onboarding/ics-time') return { validDay: () => deny('Unused read seam validDay') };
    if (id === 'server-only') return {};
    if (id === '../types' || id === './types') return load('types'); if (id === '@/lib/supabase/errors') return load('errors');
    if (id === '../activity') return { recordActivitySafely: async (passedScope: any, descriptor: any) => trace.activity.push({ family: passedScope.familyId, descriptor }) };
    if (['@/lib/home/conflicts', '@/lib/calendar/scheduling', '@/lib/supabase/settle', '../scope', '../idempotency', '@/lib/supabase/escape-like', '@/lib/i18n/server'].includes(id)) return unused(id);
    return deny('Forbidden import ' + id);
  }; new Function('require', 'module', 'exports', sourceFor(name))(require, entry, entry.exports); loaded[name] = entry.exports; return entry.exports; }
  return { run: () => load('calendar').deleteEvents(scope, ids) };
}
const refused = async (body: unknown) => { const f = fixture({ body }); await expect(f.run()).resolves.toMatchObject({ ok: false }); expect(trace.activity).toEqual([]); };
describe('original Calendar batch-delete collection contract', () => {
  it('refuses an object successful collection rather than an undefined removed count', async () => { await refused({}); });
  it('refuses a nonempty string successful collection without a map throw', async () => { await refused('event'); });
  it('refuses an empty string successful collection', async () => { await refused(''); });
  it('refuses numeric zero successful collection', async () => { await refused(0); });
  it('refuses numeric one successful collection', async () => { await refused(1); });
  it('refuses false successful collection', async () => { await refused(false); });
  it('refuses true successful collection', async () => { await refused(true); });
  it('refuses an empty array-like successful collection', async () => { await refused({ length: 0 }); });
  it('refuses a nonempty array-like successful collection without a map throw', async () => { await refused({ 0: row1, length: 1 }); });
  it('refuses a length-only successful collection without a map throw', async () => { await refused({ length: 2 }); });
  it('preserves an empty array removed-zero receipt without activity', async () => { expect(await fixture({ body: [] }).run()).toEqual({ ok: true, data: { removed: 0 } }); expect(trace.activity).toEqual([]); });
  it('preserves one selected row and the singular scoped activity descriptor', async () => { expect(await fixture({ body: [row1] }).run()).toEqual({ ok: true, data: { removed: 1 } }); expect(trace.activity).toEqual([{ family: A, descriptor: { agent: 'calendar', action: 'delete', title: 'Removed "Neutral first event" from the calendar', detail: 'Neutral first event', href: '/dashboard/calendar' } }]); });
  it('preserves two selected rows and the plural scoped activity descriptor', async () => { expect(await fixture({ body: [row1, row2] }).run()).toEqual({ ok: true, data: { removed: 2 } }); expect(trace.activity).toEqual([{ family: A, descriptor: { agent: 'calendar', action: 'delete', title: 'Removed 2 events from the calendar', detail: 'Neutral first event, Neutral second event', href: '/dashboard/calendar' } }]); });
  it('preserves HTTP200 null as an empty receipt', async () => { expect(await fixture({ body: null }).run()).toEqual({ ok: true, data: { removed: 0 } }); expect(trace.activity).toEqual([]); });
  it('preserves HTTP204 empty receipt as removed zero', async () => { expect(await fixture({ status: 204 }).run()).toEqual({ ok: true, data: { removed: 0 } }); expect(trace.activity).toEqual([]); });
  it('preserves actual SDK403 error before receipt classification', async () => { expect(await fixture({ status: 403, body: { code: '42501', message: 'Synthetic delete refused' } }).run()).toMatchObject({ ok: false, code: 'db' }); expect(trace.activity).toEqual([]); });
  it('preserves a no-ID no-op without issuing DELETE', async () => { expect(await fixture({ ids: [] }).run()).toEqual({ ok: true, data: { removed: 0 } }); expect(trace.requests).toEqual([]); expect(trace.activity).toEqual([]); });
  it('preserves filtering falsey IDs before the actual delete query', async () => { expect(await fixture({ ids: ['', one, ''], body: [row1] }).run()).toEqual({ ok: true, data: { removed: 1 } }); expect(trace.requests).toHaveLength(1); expect(trace.requests[0].query.id).toBe(`in.(${one})`); });
  it('preserves SDK IN deduplication without inventing a removed-count policy', async () => { expect(await fixture({ ids: [one, one], body: [row1] }).run()).toEqual({ ok: true, data: { removed: 1 } }); expect(trace.requests).toHaveLength(1); expect(trace.requests[0].query.id).toBe(`in.(${one})`); });
  it('preserves the server-family-B filter and activity scope', async () => { expect(await fixture({ family: B, body: [row1] }).run()).toEqual({ ok: true, data: { removed: 1 } }); expect(trace.requests[0].query.family_id).toBe('eq.' + B); expect(trace.activity[0].family).toBe(B); });
  it('preserves declared undefined adapter nullish behavior after the actual SDK DELETE', async () => { expect(await fixture({ body: null, adapter: 'undefined' }).run()).toEqual({ ok: true, data: { removed: 0 } }); expect(trace.sdkReplies).toMatchObject([{ data: null, error: null, status: 200 }]); expect(trace.effectiveReply.dataIsUndefined).toBe(true); expect(trace.activity).toEqual([]); });
  it('preserves SDK error precedence with a declared positive-data reply adapter', async () => { expect(await fixture({ status: 403, body: { code: '42501', message: 'Synthetic delete refused' }, adapter: 'dataWithError' }).run()).toMatchObject({ ok: false, code: 'db' }); expect(trace.sdkReplies[0].error.code).toBe('42501'); expect(trace.effectiveReply.data).toEqual([row1]); expect(trace.activity).toEqual([]); });
});
