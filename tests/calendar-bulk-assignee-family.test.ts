import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const nativeRequire = createRequire(import.meta.url);
const sourceRoot = process.env.BUBALY_CALENDAR_BULK_SOURCE_ROOT ?? process.cwd();
const sourcePaths = { calendar: 'lib/services/calendar/index.ts', idempotency: 'lib/services/idempotency.ts', types: 'lib/services/types.ts', errors: 'lib/supabase/errors.ts', eventDates: 'lib/calendar/event-dates.ts', calendarWindow: 'lib/briefing/calendar-window.ts', occurrences: 'lib/calendar/occurrences.ts', recurrence: 'lib/calendar/recurrence.ts', zoned: 'lib/time/zoned.ts', calendarDay: 'lib/calendar/day.ts', sourceCapability: 'lib/calendar/source-capability.ts' };
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
const ownA = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002', ownB = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002';
const ownA2 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003', ownB2 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000003';
const userId = 'dddddddd-dddd-4ddd-8ddd-000000000001';
const traces: any[] = []; let trace: any;
beforeEach(() => { trace = { name: expect.getState().currentTestName, requests: [], forbidden: [], transportErrors: [], settled: 0, activity: [], logs: [] }; for (const method of ['error', 'warn'] as const) vi.spyOn(console, method).mockImplementation((...args) => trace.logs.push({ method, args })); });
afterEach(() => { traces.push(trace); expect(trace.forbidden).toEqual([]); expect(trace.transportErrors).toEqual([]); expect(trace.requests.length).toBeLessThanOrEqual(6); expect(trace.settled).toBe(trace.requests.length); expect(trace.requests.every((r: any) => ['calendar_events', 'family_members'].includes(r.table) && ['GET', 'POST'].includes(r.method))).toBe(true); expect(trace.logs.every((l: any) => String(l.args[0]).startsWith('[service:calendar] batch create failed') || String(l.args[0]).startsWith('[service:calendar] batch duplicate probe failed'))).toBe(true); vi.restoreAllMocks(); });
afterAll(() => { if (process.env.BUBALY_CALENDAR_BULK_TRACE) fs.writeFileSync(process.env.BUBALY_CALENDAR_BULK_TRACE, JSON.stringify(traces, null, 2) + '\n', { flag: 'wx' }); });
type Options = { family?: string; assignees?: (string | null | undefined)[]; key?: string; existing?: 'all' | 'partial'; recovery?: boolean; writeDenied?: boolean; probeDenied?: boolean; invalidSecond?: boolean; memberResponse?: unknown; memberDenied?: boolean };
function fixture(options: Options = {}) {
  const family = options.family ?? A, assignees = options.assignees ?? [null];
  const inputs: any[] = assignees.map((id, i) => ({ title: ` Event ${i + 1} `, startsAt: '2026-01-02T10:00:00Z', endsAt: '2026-01-02T11:00:00Z', location: ' Neutral room ', description: ' Neutral description ', category: i === 0 ? 'general' : 'unknown', allDay: i === 0 ? true : undefined, recurrence: 'none', recurrenceUntil: null, ...(id === undefined ? {} : { assigneeId: id }) }));
  if (options.invalidSecond) inputs[1].title = ' ';
  // Independent expected digest over the published public key contract; does not call the product helper.
  const keys = options.key ? inputs.map((_, i) => createHash('sha256').update(JSON.stringify(['calendar.createEvents', family, options.key!.trim(), i])).digest('hex')) : [];
  const rows = inputs.map((_, i) => ({ family_id: family, title: `Event ${i + 1}`, description: 'Neutral description', location: 'Neutral room', category: 'general', starts_at: '2026-01-02T10:00:00.000Z', ends_at: '2026-01-02T11:00:00.000Z', all_day: i === 0, recurrence: 'none', recurrence_until: null, assignee_id: assignees[i] ?? null, created_by: userId, idempotency_key: keys[i] ?? null }));
  const saved = rows.map((r, i) => ({ ...r, id: `cccccccc-cccc-4ccc-8ccc-${String(i + 1).padStart(12, '0')}` }));
  const previous = saved.map(r => ({ ...r, title: 'Earlier saved composition', assignee_id: family === A ? ownA : ownB }));
  const settled = options.existing === 'partial' ? previous.slice(0, 1) : previous;
  let probes = 0;
  const deny = (reason: string): never => { trace.forbidden.push(reason); throw new Error(reason); };
  const transport: typeof fetch = async (resource, init) => { try {
    const url = new URL(String(resource)), method = init?.method ?? 'GET', table = url.pathname.split('/').at(-1)!;
    if (url.origin !== 'https://calendar-bulk.invalid' || !['calendar_events', 'family_members'].includes(table) || !['GET', 'POST'].includes(method) || trace.requests.length >= 6) deny('Outside finite Calendar bulk proof');
    const query = Object.fromEntries(url.searchParams), payload = init?.body ? JSON.parse(String(init.body)) : undefined;
    trace.requests.push({ method, table, query, payload });
    if (table === 'family_members') {
      const requested = assignees.filter((id): id is string => id != null).filter((id, index, ids) => ids.findIndex(other => other.toLowerCase() === id.toLowerCase()) === index);
      if (method !== 'GET' || query.select !== 'id,family_id' || query.family_id !== 'eq.' + family || query.id !== 'in.(' + requested.join(',') + ')' || Object.keys(query).length !== 3) deny('Member lookup lacks exact server family and deduplicated requested IDs');
      const normalizedFamily = family.toLowerCase();
      const roster = normalizedFamily === A ? [ownA, ownA2] : normalizedFamily === B ? [ownB, ownB2] : [];
      const members = Object.prototype.hasOwnProperty.call(options, 'memberResponse') ? options.memberResponse : requested.filter(id => roster.includes(id.toLowerCase())).map(id => ({ id: id.toLowerCase(), family_id: normalizedFamily }));
      return new Response(JSON.stringify(options.memberDenied ? { code: '42501', message: 'Synthetic member lookup refused' } : members), { status: options.memberDenied ? 403 : 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'GET') {
      probes++;
      if (!options.key || query.select !== '*' || query.family_id !== 'eq.' + family || query.idempotency_key !== 'in.(' + keys.join(',') + ')' || Object.keys(query).length !== 3) deny('Unexpected keyed batch query vector');
      if (options.probeDenied) return new Response(JSON.stringify({ code: '42501', message: 'Synthetic probe refused' }), { status: 403, headers: { 'content-type': 'application/json' } });
      const response = options.existing ? settled : options.recovery && probes === 2 ? saved : [];
      return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (!Array.isArray(payload) || JSON.stringify(payload) !== JSON.stringify(rows) || query.select !== '*') deny('Atomic insert failed independent complete normalized composition contract');
    return new Response(JSON.stringify(options.writeDenied ? { code: '42501', message: 'Synthetic batch write refused' } : saved), { status: options.writeDenied ? 403 : 201, headers: { 'content-type': 'application/json' } });
  } catch (e) { trace.transportErrors.push(String(e)); throw e; } finally { trace.settled++; } };
  const db = createClient('https://calendar-bulk.invalid', 'synthetic-key', { accessToken: async () => null, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
  const scope: any = { db, familyId: family, userId, memberId: family === A ? ownA : ownB, role: 'parent', actorKind: 'member', tz: 'UTC', idempotencyKey: options.key };
  const loaded: any = {};
  const unused = (name: string) => new Proxy({}, { get: () => () => deny('Unused seam ' + name) });
  function load(name: string): any { if (loaded[name]) return loaded[name]; const entry = { exports: {} }; loaded[name] = entry.exports; const require = (id: string): any => {
    const dependency: Record<string, string> = { '@/lib/calendar/event-dates': 'eventDates', '@/lib/briefing/calendar-window': 'calendarWindow', '@/lib/calendar/occurrences': 'occurrences', '@/lib/calendar/recurrence': 'recurrence', '@/lib/time/zoned': 'zoned', '@/lib/calendar/day': 'calendarDay', './source-capability': 'sourceCapability' }; if (dependency[id]) return load(dependency[id]);
    if (id === 'server-only') return {}; if (id === 'node:crypto') return nativeRequire(id);
    if (id === '../types' || id === './types') return load('types'); if (id === '../idempotency') return load('idempotency'); if (id === '@/lib/supabase/errors') return load('errors');
    if (id === '../activity') return { recordActivitySafely: async (_scope: any, descriptor: any) => trace.activity.push(descriptor) };
    if (['@/lib/home/conflicts', '@/lib/calendar/scheduling', '@/lib/supabase/settle', '../scope', '@/lib/supabase/escape-like', '@/lib/i18n/server'].includes(id)) return unused(id);
    return deny('Forbidden import ' + id);
  }; new Function('require', 'module', 'exports', sourceFor(name))(require, entry, entry.exports); loaded[name] = entry.exports; return entry.exports; }
  return { run: () => load('calendar').createEvents(scope, inputs), rows, saved, settled, keys };
}
const posts = () => trace.requests.filter((r: any) => r.method === 'POST');
const gets = () => trace.requests.filter((r: any) => r.method === 'GET' && r.table === 'calendar_events');
const activity = (saved: any[]) => ({ agent: 'calendar', action: 'create', title: saved.length === 1 ? `Added "${saved[0].title}" to the calendar` : `Added ${saved.length} events to the calendar`, detail: saved.map(r => r.title).join(', ').slice(0, 500), href: '/dashboard/calendar' });
describe('original Calendar bulk member-family admission', () => {
  it('refuses a family-B assignee in a new family-A batch before any POST', async () => { const f = fixture({ assignees: [ownB] }); expect(await f.run()).toMatchObject({ ok: false }); expect(posts()).toEqual([]); expect(trace.activity).toEqual([]); });
  it('refuses a family-A assignee in a new family-B batch before any POST', async () => { const f = fixture({ family: B, assignees: [ownA] }); expect(await f.run()).toMatchObject({ ok: false }); expect(posts()).toEqual([]); expect(trace.activity).toEqual([]); });
  it('refuses the entire mixed own-null-foreign composition before any atomic POST', async () => { const f = fixture({ assignees: [ownA, null, ownB] }); expect(await f.run()).toMatchObject({ ok: false }); expect(posts()).toEqual([]); expect(trace.activity).toEqual([]); });
  it('refuses a keyed not-yet-saved foreign composition before any POST', async () => { const f = fixture({ assignees: [ownB], key: 'synthetic-new-foreign-key' }); expect(await f.run()).toMatchObject({ ok: false }); expect(posts()).toEqual([]); expect(trace.activity).toEqual([]); });
  it('preserves a same-family one-row array POST and complete normalized composition', async () => { const f = fixture({ assignees: [ownA] }); expect(await f.run()).toEqual({ ok: true, data: f.saved }); expect(posts()).toHaveLength(1); expect(posts()[0].payload).toEqual(f.rows); expect(trace.activity).toEqual([activity(f.saved)]); });
  it('preserves one atomic POST for own-null-omitted rows in their input order', async () => { const f = fixture({ assignees: [ownA, null, undefined] }); expect(await f.run()).toEqual({ ok: true, data: f.saved }); expect(posts()).toHaveLength(1); expect(posts()[0].payload).toEqual(f.rows); expect(trace.activity).toEqual([activity(f.saved)]); });
  it('preserves all explicit null assignees without a member lookup', async () => { const f = fixture({ assignees: [null, null] }); expect(await f.run()).toEqual({ ok: true, data: f.saved }); expect(trace.requests).toHaveLength(1); expect(posts()[0].payload.map((r: any) => r.assignee_id)).toEqual([null, null]); });
  it('preserves omitted assignees as null without a member lookup', async () => { const f = fixture({ assignees: [undefined] }); expect(await f.run()).toEqual({ ok: true, data: f.saved }); expect(trace.requests).toHaveLength(1); expect(posts()[0].payload[0].assignee_id).toBeNull(); });
  it('preserves settled keyed rows before evaluating changed foreign input', async () => { const f = fixture({ assignees: [ownB], key: 'synthetic-settled-key', existing: 'all' }); expect(await f.run()).toEqual({ ok: true, data: f.settled }); expect(gets()).toHaveLength(1); expect(posts()).toEqual([]); expect(trace.activity).toEqual([]); });
  it('preserves existing partial keyed settlement without rewriting the batch', async () => { const f = fixture({ assignees: [ownB, null], key: 'synthetic-partial-key', existing: 'partial' }); expect(await f.run()).toEqual({ ok: true, data: f.settled }); expect(trace.requests).toHaveLength(1); expect(posts()).toEqual([]); expect(trace.activity).toEqual([]); });
  it('preserves index-derived keys and one atomic new keyed own-family insertion', async () => { const f = fixture({ assignees: [ownA, null], key: 'synthetic-new-own-key' }); expect(await f.run()).toEqual({ ok: true, data: f.saved }); expect(gets()).toHaveLength(1); expect(posts()).toHaveLength(1); expect(posts()[0].payload.map((r: any) => r.idempotency_key)).toEqual(f.keys); expect(trace.activity).toEqual([activity(f.saved)]); });
  it('preserves a failed keyed POST followed by the family-scoped winner receipt', async () => { const f = fixture({ assignees: [ownA], key: 'synthetic-race-key', writeDenied: true, recovery: true }); expect(await f.run()).toEqual({ ok: true, data: f.saved }); expect(trace.requests.filter((r: any) => r.table === 'calendar_events').map((r: any) => r.method)).toEqual(['GET', 'POST', 'GET']); expect(trace.activity).toEqual([]); });
  it('preserves keyless SDK write refusal without saved success or activity', async () => { const f = fixture({ assignees: [ownA], writeDenied: true }); expect(await f.run()).toMatchObject({ ok: false, code: 'db' }); expect(posts()).toHaveLength(1); expect(trace.activity).toEqual([]); });
  it('preserves keyed SDK write refusal when the recovery probe has no winner', async () => { const f = fixture({ assignees: [ownA], key: 'synthetic-no-winner-key', writeDenied: true }); expect(await f.run()).toMatchObject({ ok: false, code: 'db' }); expect(trace.requests.filter((r: any) => r.table === 'calendar_events').map((r: any) => r.method)).toEqual(['GET', 'POST', 'GET']); expect(trace.activity).toEqual([]); });
  it('preserves SDK duplicate-probe refusal before any POST or activity', async () => { const f = fixture({ assignees: [ownA], key: 'synthetic-probe-error-key', probeDenied: true }); expect(await f.run()).toMatchObject({ ok: false, code: 'db' }); expect(gets()).toHaveLength(1); expect(posts()).toEqual([]); expect(trace.activity).toEqual([]); });
  it('preserves invalid later-input refusal before any partial write', async () => { const f = fixture({ assignees: [ownA, null], invalidSecond: true }); expect(await f.run()).toMatchObject({ ok: false, code: 'invalid_input' }); expect(trace.requests).toEqual([]); expect(trace.activity).toEqual([]); });
});

const memberGets = () => trace.requests.filter((r: any) => r.table === 'family_members');
const expectMemberRefusal = async (memberResponse: unknown, assignees = [ownA]) => {
  const f = fixture({ assignees, memberResponse });
  expect(await f.run()).toMatchObject({ ok: false, code: 'invalid_input' });
  expect(posts()).toEqual([]);
  expect(trace.activity).toEqual([]);
};
describe('Calendar bulk positive member receipt contract', () => {
  it('admits two distinct same-family members with one lookup and one atomic POST', async () => { const f = fixture({ assignees: [ownA, ownA2] }); expect(await f.run()).toEqual({ ok: true, data: f.saved }); expect(memberGets()).toHaveLength(1); expect(memberGets()[0].query.id).toBe(`in.(${ownA},${ownA2})`); expect(posts()).toHaveLength(1); expect(posts()[0].payload).toEqual(f.rows); expect(trace.activity).toEqual([activity(f.saved)]); });
  it('deduplicates repeated mixed-case IDs without altering any inserted row', async () => { const f = fixture({ assignees: [ownA, ownA.toUpperCase(), ownA] }); expect(await f.run()).toEqual({ ok: true, data: f.saved }); expect(memberGets()).toHaveLength(1); expect(memberGets()[0].query.id).toBe(`in.(${ownA})`); expect(posts()[0].payload).toEqual(f.rows); expect(trace.activity).toEqual([activity(f.saved)]); });
  it('admits uppercase family and requested UUIDs with normalized returned identities', async () => { const f = fixture({ family: A.toUpperCase(), assignees: [ownA.toUpperCase()] }); expect(await f.run()).toEqual({ ok: true, data: f.saved }); expect(memberGets()).toHaveLength(1); expect(memberGets()[0].query.family_id).toBe('eq.' + A.toUpperCase()); expect(posts()[0].payload).toEqual(f.rows); });
  it('refuses an empty successful member receipt', async () => { await expectMemberRefusal([]); });
  it('refuses an object successful member collection', async () => { await expectMemberRefusal({ id: ownA, family_id: A }); });
  it('refuses a string successful member collection', async () => { await expectMemberRefusal('member'); });
  it('refuses a null successful member collection', async () => { await expectMemberRefusal(null); });
  it('refuses a numeric successful member collection', async () => { await expectMemberRefusal(0); });
  it('refuses a boolean successful member collection', async () => { await expectMemberRefusal(false); });
  it('refuses a null member entry without calling string comparison on it', async () => { await expectMemberRefusal([null]); });
  it('refuses an array member entry', async () => { await expectMemberRefusal([[ownA, A]]); });
  it('refuses a numeric returned member ID without a comparison throw', async () => { await expectMemberRefusal([{ id: 1, family_id: A }]); });
  it('refuses a boolean returned family ID without a comparison throw', async () => { await expectMemberRefusal([{ id: ownA, family_id: false }]); });
  it('refuses a returned requested ID from the wrong family', async () => { await expectMemberRefusal([{ id: ownA, family_id: B }]); });
  it('refuses an unrelated same-family returned ID', async () => { await expectMemberRefusal([{ id: ownA2, family_id: A }]); });
  it('refuses the entire batch when one requested member is missing', async () => { await expectMemberRefusal([{ id: ownA, family_id: A }], [ownA, ownA2]); });
  it('allows duplicate member receipts when every requested identity is covered', async () => { const f = fixture({ assignees: [ownA, ownA2], memberResponse: [{ id: ownA, family_id: A }, { id: ownA, family_id: A }, { id: ownA2, family_id: A }] }); expect(await f.run()).toEqual({ ok: true, data: f.saved }); expect(memberGets()).toHaveLength(1); expect(posts()).toHaveLength(1); expect(trace.activity).toEqual([activity(f.saved)]); });
  it('refuses actual SDK member lookup denial before any POST', async () => { const f = fixture({ assignees: [ownA], memberDenied: true }); expect(await f.run()).toMatchObject({ ok: false, code: 'db' }); expect(memberGets()).toHaveLength(1); expect(posts()).toEqual([]); expect(trace.activity).toEqual([]); });
  it('refuses keyed new-write member denial after the settled-key probe', async () => { const f = fixture({ assignees: [ownA], key: 'synthetic-member-denied-key', memberDenied: true }); expect(await f.run()).toMatchObject({ ok: false, code: 'db' }); expect(gets()).toHaveLength(1); expect(memberGets()).toHaveLength(1); expect(posts()).toEqual([]); expect(trace.activity).toEqual([]); });
});
