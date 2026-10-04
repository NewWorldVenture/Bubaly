import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { listTeams } from '@/lib/services/sports';
vi.mock('@/lib/services/school', () => ({ resolveWindow: () => { throw Error('NS School resolver is not admitted'); } }));
vi.mock('@/lib/calendar/recurrence', () => ({ expandEventsInZone: () => { throw Error('Recurrence is not admitted'); }, expandEvents: () => { throw Error('Recurrence is not admitted'); } }));
const A = '10000000-0000-4000-8000-000000000001', B = '10000000-0000-4000-8000-000000000002';
const MA = '20000000-0000-4000-8000-000000000001', MB = '20000000-0000-4000-8000-000000000002';
const row = { id: '30000000-0000-4000-8000-000000000001', family_id: A, member_id: MA, sport: 'soccer', team_name: 'Neutral team', season: null, coach: null, is_active: true };
let proof: any, consoleError: any;
beforeEach(() => { proof = { name: expect.getState().currentTestName, requests: [], actualSdkReplies: [], fixtureErrors: [], forbidden: [], active: 0 }; consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => {
  consoleError.mockRestore();
  expect(proof.fixtureErrors).toEqual([]); expect(proof.forbidden).toEqual([]); expect(proof.active).toBe(0);
  expect(proof.requests).toHaveLength(1); expect(proof.requests.length).toBeLessThanOrEqual(2); expect(proof.actualSdkReplies).toHaveLength(1);
  const request = proof.requests[0], query = new URLSearchParams(request.query);
  expect(request.method).toBe('GET'); expect(request.table).toBe('teams'); expect(request.payload).toBeNull();
  expect(query.get('select')).toBe('*'); expect(query.get('family_id')).toBe('eq.' + proof.family);
  expect(query.get('order')).toBe('team_name.asc'); expect(query.get('limit')).toBe('500');
  expect(query.get('is_active')).toBe((proof.input.activeOnly ?? true) ? 'eq.true' : null);
  expect(query.get('member_id')).toBe(proof.input.memberId ? 'eq.' + proof.input.memberId : null);
  if (process.env.BUBALY_SPORTS_TEAMS_RECEIPTS) fs.appendFileSync(process.env.BUBALY_SPORTS_TEAMS_RECEIPTS, JSON.stringify(proof) + '\n');
});
async function run(body: any, options: any = {}) {
  const family = options.family ?? A, input = options.input ?? {}, status = options.status ?? 200;
  Object.assign(proof, { family, input, modeledBody: body, modeledStatus: status, declaredPostAwaitAdapter: options.adapter ?? null });
  const db = createClient('https://sports-teams-collection.invalid', 'synthetic-key', { accessToken: async () => null, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async (url: any, init: any = {}) => {
    proof.active++;
    try {
      const parsed = new URL(String(url)), method = init.method ?? 'GET', table = parsed.pathname.split('/').pop();
      if (parsed.origin !== 'https://sports-teams-collection.invalid' || method !== 'GET' || table !== 'teams' || proof.requests.length >= 2) { proof.forbidden.push(String(url)); throw Error('Unapproved transport'); }
      const headers = new Headers(init.headers);
      proof.requests.push({ method, table, query: parsed.search, payload: init.body ? JSON.parse(String(init.body)) : null, accept: headers.get('accept'), prefer: headers.get('prefer') });
      return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    } catch (error) { proof.fixtureErrors.push(error instanceof Error ? error.message : String(error)); throw error; }
    finally { proof.active--; }
  } } });
  function observe(builder: any): any {
    return new Proxy(builder, { get(target, property) {
      if (property === 'then') return (fulfilled: any, rejected: any) => target.then((reply: any) => {
        proof.actualSdkReplies.push({ status: reply.status, data: reply.data, error: reply.error, dataUndefined: reply.data === undefined });
        if (options.adapter === 'undefined') return { ...reply, data: undefined };
        if (options.adapter === 'data-plus-error') return { ...reply, data: [row] };
        return reply;
      }).then(fulfilled, rejected);
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: any[]) => { const next = value.apply(target, args); return next && typeof next === 'object' ? observe(next) : next; };
    } });
  }
  const scope: any = { db: { from: (table: string) => { if (table !== 'teams') { proof.forbidden.push(table); throw Error('Unapproved builder'); } return observe(db.from(table)); } }, familyId: family, userId: '40000000-0000-4000-8000-000000000001', memberId: family === A ? MA : MB, role: 'parent', actorKind: 'member', tz: 'UTC' };
  const result = options.omitInput ? await listTeams(scope) : await listTeams(scope, input);
  proof.result = result;
  return result;
}
// ORIGINAL CASES BEGIN
it('object collection is refused', async () => { expect(await run({})).toMatchObject({ ok: false, code: 'db' }); });
it('nonempty string collection is refused', async () => { expect(await run('team')).toMatchObject({ ok: false, code: 'db' }); });
it('empty string collection is refused', async () => { expect(await run('')).toMatchObject({ ok: false, code: 'db' }); });
it('numeric zero collection is refused', async () => { expect(await run(0)).toMatchObject({ ok: false, code: 'db' }); });
it('boolean false collection is refused', async () => { expect(await run(false)).toMatchObject({ ok: false, code: 'db' }); });
it('boolean true collection is refused', async () => { expect(await run(true)).toMatchObject({ ok: false, code: 'db' }); });
it('array-like length zero collection is refused', async () => { expect(await run({ length: 0 })).toMatchObject({ ok: false, code: 'db' }); });
it('indexed array-like collection is refused', async () => { expect(await run({ 0: row, length: 1 })).toMatchObject({ ok: false, code: 'db' }); });
it('empty array with omitted input preserves default active scope', async () => { expect(await run([], { omitInput: true })).toEqual({ ok: true, data: [] }); });
it('healthy team array remains unchanged', async () => { expect(await run([row])).toEqual({ ok: true, data: [row] }); });
it('raw array entries remain opaque without a row policy', async () => { expect(await run([null, 0, 'raw'])).toEqual({ ok: true, data: [null, 0, 'raw'] }); });
it('HTTP200 null preserves empty collection policy', async () => { expect(await run(null)).toEqual({ ok: true, data: [] }); });
it('HTTP204 preserves empty collection policy', async () => { expect(await run(null, { status: 204 })).toEqual({ ok: true, data: [] }); });
it('SDK403 preserves database refusal', async () => { expect(await run({ code: '42501', message: 'Synthetic team read refusal' }, { status: 403 })).toMatchObject({ ok: false, code: 'db' }); });
it('activeOnly false omits active filter and retains inactive row', async () => { const inactive = { ...row, is_active: false }; expect(await run([inactive], { input: { activeOnly: false } })).toEqual({ ok: true, data: [inactive] }); });
it('optional member filter preserves returned array', async () => { expect(await run([row], { input: { memberId: MA } })).toEqual({ ok: true, data: [row] }); });
it('family B with member and inactive options preserves all query predicates', async () => { const other = { ...row, family_id: B, member_id: MB, is_active: false }; expect(await run([other], { family: B, input: { memberId: MB, activeOnly: false } })).toEqual({ ok: true, data: [other] }); });
it('declared post-await undefined adapter preserves nullish empty policy', async () => { expect(await run([], { adapter: 'undefined' })).toEqual({ ok: true, data: [] }); expect(proof.actualSdkReplies[0]).toMatchObject({ status: 200, data: [], error: null }); });
it('declared positive-data plus SDK error adapter preserves error precedence', async () => { expect(await run({ code: '42501', message: 'Synthetic team read refusal' }, { status: 403, adapter: 'data-plus-error' })).toMatchObject({ ok: false, code: 'db' }); expect(proof.actualSdkReplies[0]).toMatchObject({ status: 403, data: null, error: { code: '42501' } }); });
// ORIGINAL CASES END
