import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: async (scope: any, descriptor: any) => { const proof = (globalThis as any).__reminderMemberProof; if (!proof) throw Error('Inert activity observer requires test receipt'); proof.activity.push({ familyId: scope.familyId, userId: scope.userId, descriptor }); } }));
vi.mock('@/lib/services/scope', () => ({ scopeNow: () => { throw Error('Actual scope/clock namespace is not admitted'); } }));
vi.mock('@/lib/reminders/details', () => ({ nextRemindAt: () => { throw Error('Reminder details namespace is not admitted'); } }));
import { createReminder } from '@/lib/services/reminders';

const A = 'abcdefab-1234-4000-8000-000000000001', B = 'bcdefabc-1234-4000-8000-000000000002';
const MA = 'cdefabcd-1234-4000-8000-000000000001', MB = 'defabcde-1234-4000-8000-000000000002';
const USER = 'efabcdef-1234-4000-8000-000000000001', RID = 'fabcdabc-1234-4000-8000-000000000001', KEY = 'synthetic-reminder-member-key';
const AT = '2026-10-10T15:00:00.000Z';
const wanted = { title: 'Neutral reminder', notes: null, kind: 'time', remind_at: AT, location_name: null, recurrence: 'none', priority: 'medium', assigned_to_id: null, member_id: MA, ai_suggested: false, tags: [] };
const input = { title: 'Neutral reminder', kind: 'time', remindAt: AT, memberId: MA };
let proof: any, errorSpy: any, warnSpy: any;
beforeEach(() => {
  proof = { name: expect.getState().currentTestName, requests: [], rawResponses: [], actualSdkReplies: [], activity: [], transportErrors: [], forbidden: [], active: 0 };
  (globalThis as any).__reminderMemberProof = proof;
  errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => { (proof.consoleErrors ??= []).push(args); });
  warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => { (proof.consoleWarnings ??= []).push(args); });
});
afterEach(() => {
  errorSpy.mockRestore(); warnSpy.mockRestore();
  expect(proof.transportErrors).toEqual([]); expect(proof.forbidden).toEqual([]); expect(proof.active).toBe(0);
  expect(proof.requests.length).toBeLessThanOrEqual(4); expect(proof.actualSdkReplies).toHaveLength(proof.requests.length);
  expect(proof.rawResponses).toHaveLength(proof.requests.length);
  for (const request of proof.requests) {
    const query = new URLSearchParams(request.query);
    if (request.method === 'GET') {
      expect(query.get('family_id')).toBe('eq.' + proof.family);
      expect(request.payload).toBeNull();
      if (request.table === 'family_reminders') {
        expect(query.get('select')).toBe('*'); expect(query.get('idempotency_key')).toBe('eq.' + KEY); expect(query.get('limit')).toBe('1');
      } else {
        expect(request.table).toBe('family_members'); expect(query.get('id')).toBe('eq.' + proof.input.memberId);
        expect(query.get('select')).toBe('id,family_id'); expect(query.get('limit')).toBe('1');
      }
    } else {
      expect(request.method).toBe('POST'); expect(request.table).toBe('family_reminders'); expect(query.get('select')).toBe('*');
      expect(request.payload).toEqual(proof.expectedPayload);
      expect(request.accept).toBe('application/vnd.pgrst.object+json'); expect(request.prefer).toBe('return=representation');
    }
  }
  for (const descriptor of proof.activity) expect(descriptor).toEqual({ familyId: proof.family, userId: USER, descriptor: { agent: 'reminders', action: 'create', title: 'Set a reminder: "' + proof.expectedWanted.title + '"', detail: proof.expectedWanted.remind_at, href: '/dashboard/reminders', memberId: proof.input.memberId ?? null } });
  if (process.env.BUBALY_REMINDER_MEMBER_RECEIPTS) fs.appendFileSync(process.env.BUBALY_REMINDER_MEMBER_RECEIPTS, JSON.stringify(proof) + '\n');
  delete (globalThis as any).__reminderMemberProof;
});
const posts = () => proof.requests.filter((r: any) => r.method === 'POST');
const probes = () => proof.requests.filter((r: any) => r.table === 'family_reminders' && r.method === 'GET');
const members = () => proof.requests.filter((r: any) => r.table === 'family_members');
function saved(member: any = MA, family = A, extra: any = {}) { return { id: RID, family_id: family, ...wanted, member_id: member, status: 'active', created_by: USER, idempotency_key: KEY, ...extra }; }
async function run(options: any = {}) {
  const family = options.family ?? A, args = { ...input, ...options.input };
  if (options.omitMember) delete args.memberId;
  const key = options.keyed ? KEY : null;
  const expectedWanted = { ...wanted, member_id: args.memberId ?? null, ...options.expectedWanted };
  const expectedPayload = { family_id: family, ...expectedWanted, status: 'active', created_by: USER, idempotency_key: key };
  Object.assign(proof, { family, input: args, opts: options.opts ?? {}, key, expectedWanted, expectedPayload, model: { probeRows: options.probeRows ?? [null], probeStatus: options.probeStatus ?? 200, postStatus: options.postStatus ?? 201, postNull: !!options.postNull, memberReceipt: ('memberReceipt' in options ? options.memberReceipt : ((args.memberId?.toLowerCase() === MA && family.toLowerCase() === A) || (args.memberId?.toLowerCase() === MB && family.toLowerCase() === B) ? [{ id: args.memberId.toLowerCase(), family_id: family.toLowerCase() }] : [])) } });
  let probeIndex = 0;
  const db = createClient('https://reminder-member-family.invalid', 'synthetic-key', { accessToken: async () => null, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async (url: any, init: any = {}) => {
    proof.active++;
    try {
      const parsed = new URL(String(url)), table = parsed.pathname.split('/').pop(), method = init.method ?? 'GET';
      if (parsed.origin !== 'https://reminder-member-family.invalid' || proof.requests.length >= 4 || !((method === 'GET' && ['family_reminders', 'family_members'].includes(table!)) || (method === 'POST' && table === 'family_reminders'))) { proof.forbidden.push(String(url)); throw Error('Unapproved finite transport'); }
      const headers = new Headers(init.headers), payload = init.body ? JSON.parse(String(init.body)) : null;
      proof.requests.push({ method, table, query: parsed.search, payload, accept: headers.get('accept'), prefer: headers.get('prefer') });
      let status: number, body: any;
      if (method === 'POST') { status = options.postStatus ?? 201; body = status >= 400 ? { code: '23505', message: 'Synthetic insert refusal' } : options.postNull ? null : { id: RID, ...payload }; }
      else if (table === 'family_reminders') { status = options.probeStatus ?? 200; const rows = options.probeRows ?? [null], row = rows[Math.min(probeIndex++, rows.length - 1)]; body = status >= 400 ? { code: '42501', message: 'Synthetic duplicate probe refusal' } : row === null ? [] : [row]; }
      else { status = options.memberStatus ?? 200; body = status >= 400 ? { code: '42501', message: 'Synthetic member receipt refusal' } : proof.model.memberReceipt; }
      if (status === 204) body = null;
      proof.rawResponses.push({ requestIndex: proof.requests.length - 1, status, body });
      return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    } catch (error) { proof.transportErrors.push(error instanceof Error ? error.message : String(error)); throw error; }
    finally { proof.active--; }
  } } });
  function observe(builder: any): any {
    return new Proxy(builder, { get(target, property) {
      if (property === 'then') return (fulfilled: any, rejected: any) => target.then((reply: any) => { proof.actualSdkReplies.push({ status: reply.status, data: reply.data, dataUndefined: reply.data === undefined, error: reply.error }); return options.memberErrorAdapter && proof.requests.at(-1)?.table === 'family_members' ? { ...reply, status: 403, error: { code: '42501', message: 'Declared post-SDK adapter error' } } : reply; }).then(fulfilled, rejected);
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: any[]) => { const next = value.apply(target, args); return next && typeof next === 'object' ? observe(next) : next; };
    } });
  }
  const scope: any = { db: { from: (table: string) => { if (!['family_reminders', 'family_members'].includes(table)) { proof.forbidden.push(table); throw Error('Unapproved builder'); } return observe(db.from(table)); } }, familyId: family, userId: USER, memberId: family.toLowerCase() === A ? MA : MB, role: 'parent', actorKind: 'member', tz: 'UTC', ...(options.keyed ? { idempotencyKey: KEY } : {}) };
  try { const result = await createReminder(scope, args, options.opts ?? {}); proof.result = result; return result; }
  catch (error) { proof.serviceThrown = error instanceof Error ? error.message : String(error); throw error; }
}
// ORIGINAL CASES BEGIN
it('family A refuses a new reminder about family B member before POST or activity', async () => { expect((await run({ input: { memberId: MB } })).ok).toBe(false); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it('family B refuses a new reminder about family A member before POST or activity', async () => { expect((await run({ family: B, input: { memberId: MA } })).ok).toBe(false); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it('same-family explicit-time create retains normalized composition and one activity', async () => { expect(await run()).toEqual({ ok: true, data: { id: RID, ...proof.expectedPayload } }); expect(posts()).toHaveLength(1); expect(probes()).toEqual([]); expect(proof.activity).toHaveLength(1); });
it('alphabetic uppercase UUID input preserves ordinary successful payload', async () => { expect((await run({ family: A.toUpperCase(), input: { memberId: MA.toUpperCase() } })).ok).toBe(true); expect(posts()).toHaveLength(1); expect(proof.activity).toHaveLength(1); });
it('explicit null member preserves successful unassigned reminder without member GET', async () => { expect((await run({ input: { memberId: null } })).ok).toBe(true); expect(posts()).toHaveLength(1); expect(members()).toEqual([]); expect(proof.activity).toHaveLength(1); });
it('omitted member preserves successful unassigned reminder without member GET', async () => { expect((await run({ omitMember: true })).ok).toBe(true); expect(posts()).toHaveLength(1); expect(members()).toEqual([]); expect(proof.activity).toHaveLength(1); });
it('trimmed text and offset timestamp retain canonical normalized composition', async () => { expect((await run({ input: { title: ' Neutral reminder ', notes: ' note ', remindAt: '2026-10-10T11:00:00-04:00', tags: ['neutral'] }, expectedWanted: { notes: 'note', tags: ['neutral'] } })).ok).toBe(true); expect(posts()).toHaveLength(1); expect(proof.activity).toHaveLength(1); });
it('keyed new own reminder preserves initial probe and keyed insert', async () => { expect((await run({ keyed: true })).ok).toBe(true); expect(probes()).toHaveLength(1); expect(posts()).toHaveLength(1); expect(proof.activity).toHaveLength(1); });
it('opt-in identical settled retry returns its row before member lookup and write', async () => { const row = saved(); expect(await run({ keyed: true, probeRows: [row], opts: { rejectChangedRetry: true } })).toEqual({ ok: true, data: row }); expect(probes()).toHaveLength(1); expect(members()).toEqual([]); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it('legacy settled foreign-member receipt remains a settled operation result', async () => { const row = saved(MB); expect(await run({ keyed: true, input: { memberId: MB }, probeRows: [row] })).toEqual({ ok: true, data: row }); expect(members()).toEqual([]); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it('opt-in changed settled composition preserves already_saved refusal before any new write', async () => { expect(await run({ keyed: true, input: { title: 'Changed reminder' }, probeRows: [saved()], opts: { rejectChangedRetry: true } })).toMatchObject({ ok: false, code: 'already_saved' }); expect(members()).toEqual([]); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it('default changed settled operation retains existing successful result', async () => { const row = saved(); expect(await run({ keyed: true, input: { title: 'Changed reminder' }, probeRows: [row] })).toEqual({ ok: true, data: row }); expect(members()).toEqual([]); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it('blank title refuses before any SDK request', async () => { expect(await run({ input: { title: ' ' } })).toMatchObject({ ok: false, code: 'invalid_input' }); expect(proof.requests).toEqual([]); expect(proof.activity).toEqual([]); });
it('invalid explicit time refuses before any SDK request', async () => { expect(await run({ input: { remindAt: 'invalid-time' } })).toMatchObject({ ok: false, code: 'invalid_input' }); expect(proof.requests).toEqual([]); expect(proof.activity).toEqual([]); });
it('missing time refuses ordinary time reminder before any SDK request', async () => { expect(await run({ input: { remindAt: null } })).toMatchObject({ ok: false, code: 'invalid_input' }); expect(proof.requests).toEqual([]); expect(proof.activity).toEqual([]); });
it('initial SDK403 keyed probe preserves database refusal before member lookup or POST', async () => { expect(await run({ keyed: true, probeStatus: 403 })).toMatchObject({ ok: false, code: 'db' }); expect(probes()).toHaveLength(1); expect(members()).toEqual([]); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it('failed keyed insert returns matching modeled winner on recovery probe', async () => { const row = saved(); expect(await run({ keyed: true, probeRows: [null, row], postStatus: 409, opts: { rejectChangedRetry: true } })).toEqual({ ok: true, data: row }); expect(probes()).toHaveLength(2); expect(posts()).toHaveLength(1); expect(proof.activity).toEqual([]); });
it('failed keyed insert without recovery winner preserves database refusal', async () => { expect(await run({ keyed: true, probeRows: [null, null], postStatus: 409 })).toMatchObject({ ok: false, code: 'db' }); expect(probes()).toHaveLength(2); expect(posts()).toHaveLength(1); expect(proof.activity).toEqual([]); });
it('native successful POST null receipt preserves refusal without activity', async () => { expect(await run({ postNull: true })).toMatchObject({ ok: false, code: 'db' }); expect(posts()).toHaveLength(1); expect(proof.activity).toEqual([]); });
// ORIGINAL CASES END

// Added member admission receipts; original nineteen declarations above are unchanged.
it('member SDK403 refuses before new POST or activity', async () => { expect(await run({ memberStatus: 403 })).toMatchObject({ ok: false, code: 'db' }); expect(members()).toHaveLength(1); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it('empty member receipt refuses before new POST or activity', async () => { expect((await run({ memberReceipt: [] })).ok).toBe(false); expect(members()).toHaveLength(1); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it('HTTP200 null member receipt refuses before new POST or activity', async () => { expect((await run({ memberReceipt: null })).ok).toBe(false); expect(members()).toHaveLength(1); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it('HTTP204 member receipt refuses before new POST or activity', async () => { expect((await run({ memberStatus: 204 })).ok).toBe(false); expect(members()).toHaveLength(1); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it.each([{ name: 'object', body: {} }, { name: 'string', body: 'opaque' }, { name: 'zero', body: 0 }, { name: 'false', body: false }])('successful non-array $name member collection refuses before POST', async ({ body }) => { expect((await run({ memberReceipt: body })).ok).toBe(false); expect(members()).toHaveLength(1); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it('member receipt missing selected identities refuses without throwing', async () => { expect((await run({ memberReceipt: [{}] })).ok).toBe(false); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it('unrelated member id in scoped receipt refuses before POST', async () => { expect((await run({ memberReceipt: [{ id: MB, family_id: A }] })).ok).toBe(false); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it('other family in scoped member receipt refuses before POST', async () => { expect((await run({ memberReceipt: [{ id: MA, family_id: B }] })).ok).toBe(false); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it('numeric selected member id refuses without sameId throw', async () => { expect((await run({ memberReceipt: [{ id: 4, family_id: A }] })).ok).toBe(false); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it('boolean selected family id refuses without sameId throw', async () => { expect((await run({ memberReceipt: [{ id: MA, family_id: false }] })).ok).toBe(false); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it('keyed foreign new request retains empty initial and recovery probes without POST', async () => { expect((await run({ keyed: true, input: { memberId: MB } })).ok).toBe(false); expect(probes()).toHaveLength(2); expect(members()).toHaveLength(1); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
it('declared post-SDK positive-data error adapter preserves member error precedence', async () => { expect(await run({ memberErrorAdapter: true })).toMatchObject({ ok: false, code: 'db' }); expect(proof.actualSdkReplies.at(-1)).toMatchObject({ status: 200, data: [{ id: MA, family_id: A }], error: null }); expect(posts()).toEqual([]); expect(proof.activity).toEqual([]); });
