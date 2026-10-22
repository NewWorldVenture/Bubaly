import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { listDue } from '@/lib/services/reminders';
vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: (...args: unknown[]) => { (globalThis as any).__dueActivity?.push(args); throw Error('Unadmitted activity invocation'); } }));
vi.mock('@/lib/reminders/details', () => ({ nextRemindAt: () => { throw Error('Unadmitted reminder details invocation'); } }));

const FAMILY = 'a1111111-1111-4111-8111-111111111111';
const MEMBER = 'b2222222-2222-4222-8222-222222222222';
const NOW = '2026-10-10T15:00:00.000Z';
const HOST = 'https://reminder-due-collection.invalid';
const ORIGIN_COLUMNS = 'id,family_id,autopilot_origin,autopilot_card_id';
const CARD_COLUMNS = 'id,family_id,kind,source_kind,source_id,member_id,action_type,title,detail,urgency,payload';
const active = { id: 'active-1', family_id: FAMILY, status: 'active', remind_at: NOW };
let proof: any;

// Content pages retain the original finite transport and receipt assertions.
// The origin schema adds a separate, explicit authorization read plan: only
// the named manual IDs are admitted. Nothing inferred from a content row's
// title, tags, or apparent shape may manufacture trusted origin metadata.
function dueLimit() { return Math.min(Math.max(proof.input.limit ?? 100, 1), 500); }
function expectedPages() {
  if (proof.expectedHorizon === null) return 0;
  const first = proof.rawResponses[0];
  return first && first.status === 200 && !proof.adapter && Array.isArray(first.body)
    && first.body.length > 0 && first.body.length < dueLimit() ? 2 : 1;
}
function queryKey(table: string, query: URLSearchParams) {
  return `${table}?${JSON.stringify([...query.entries()].sort())}`;
}
type PrivacyFailure = { table: 'family_reminders' | 'reminders' | 'autopilot_suggestions'; kind: 'sql' | 'transport' };
function privacyPlan(manualIds: string[], expectCards: boolean, failure?: PrivacyFailure) {
  const origins = manualIds.map((id) => ({ id, family_id: FAMILY, autopilot_origin: false, autopilot_card_id: null }));
  const plan: { key: string; body: unknown; outcome: 'ok' | 'sql' | 'transport' }[] = [];
  for (const table of ['family_reminders', 'reminders']) {
    const rows = table === 'family_reminders' ? origins : [];
    const failed = failure?.table === table;
    const offsets = rows.length && !failed ? [0, rows.length] : [0];
    for (const offset of offsets) {
      const query = new URLSearchParams({ select: ORIGIN_COLUMNS, family_id: `eq.${FAMILY}`, order: 'id.asc', offset: String(offset), limit: '1000' });
      plan.push({ key: queryKey(table, query), body: offset === 0 ? rows : [], outcome: failed ? failure.kind : 'ok' });
    }
  }
  if (expectCards) {
    const query = new URLSearchParams({ select: CARD_COLUMNS, family_id: `eq.${FAMILY}`, action_type: 'eq.create_reminder', order: 'created_at.desc,id.asc', offset: '0', limit: '1000' });
    plan.push({ key: queryKey('autopilot_suggestions', query), body: [], outcome: failure?.table === 'autopilot_suggestions' ? failure.kind : 'ok' });
  }
  return plan;
}

afterEach(() => {
  expect(proof.forbidden).toEqual([]);
  expect(proof.transportErrors).toEqual([]);
  expect(proof.active).toBe(0);
  expect(proof.requests.length).toBe(expectedPages());
  expect(proof.actualSdkReplies.length).toBe(proof.requests.length);
  expect(proof.activity).toEqual([]);
  proof.requests.forEach((request: any, page: number) => {
    const q = new URLSearchParams(request.query);
    expect(request.method).toBe('GET');
    expect(request.table).toBe('family_reminders');
    expect([...q.keys()].sort()).toEqual(['family_id', 'limit', 'offset', 'order', 'remind_at', 'remind_at', 'select', 'status', ...(proof.input.memberId ? ['member_id'] : [])].sort());
    expect(q.get('family_id')).toBe(`eq.${FAMILY}`);
    expect(q.get('status')).toBe('in.(active,snoozed)');
    expect(q.get('select')).toBe('*');
    expect(q.getAll('remind_at')).toEqual(['not.is.null', `lte.${proof.expectedHorizon}`]);
    expect(q.get('order')).toBe('remind_at.asc,id.asc');
    expect(q.get('limit')).toBe(String(dueLimit() * 2 ** page));
    expect(q.get('offset')).toBe(String(page === 0 ? 0 : proof.rawResponses[0].body.length));
    if (proof.input.memberId) expect(q.get('member_id')).toBe(`eq.${proof.input.memberId}`);
    expect(request.payload).toBeNull();
  });
  // Exact plan equality rejects missing authorization, arbitrary table access,
  // unbounded reads, duplicate requests and cross-household filter changes.
  const expectedAttempts = proof.privacyPlan.flatMap((r: any) => (r.outcome === 'transport' ? [0, 1, 2, 3] : [0]).map((attempt) => `${r.key}#${attempt}`));
  expect(proof.privacyRequests.map((r: any) => `${r.key}#${r.attempt}`).sort()).toEqual(expectedAttempts.sort());
  expect(proof.declaredTransportErrors.length).toBe(proof.privacyPlan.filter((r: any) => r.outcome === 'transport').length * 4);
  expect(proof.privacySdkReplies.length).toBe(proof.privacyPlan.length);
  for (const receipt of proof.privacySdkReplies) {
    const planned = proof.privacyPlan.find((r: any) => r.key === receipt.key);
    expect(planned).toBeDefined();
    if (planned.outcome === 'ok') {
      expect(receipt.status).toBe(200);
      expect(receipt.error).toBeNull();
      expect(Array.isArray(receipt.data)).toBe(true);
    } else {
      expect(receipt.status).toBe(planned.outcome === 'sql' ? 403 : 0);
      expect(receipt.data).toBeNull();
      expect(receipt.error).not.toBeNull();
      if (planned.outcome === 'sql') expect(receipt.error.code).toBe('42501');
    }
  }
  if (process.env.BUBALY_REMINDER_DUE_RECEIPTS) {
    appendFileSync(process.env.BUBALY_REMINDER_DUE_RECEIPTS, JSON.stringify({ ...proof, test: expect.getState().currentTestName }) + String.fromCharCode(10));
  }
});

async function run(body: any = [], options: any = {}) {
  const input = options.input ?? {};
  const before = input.before ? Date.parse(input.before) : Date.parse(NOW) + (input.withinMinutes ?? 0) * 60000;
  const needsOrigins = Number.isFinite(before) && Array.isArray(body) && body.length > 0 && (options.status ?? 200) === 200 && !options.adapter;
  proof = {
    input, expectedHorizon: Number.isFinite(before) ? new Date(before).toISOString() : null,
    requests: [], rawResponses: [], actualSdkReplies: [], declaredAdapters: [], activity: [], forbidden: [], transportErrors: [], active: 0,
    status: options.status ?? 200, adapter: options.adapter ?? null,
    privacyPlan: needsOrigins ? privacyPlan(options.manualIds ?? [], options.expectCards ?? false, options.privacyFailure) : [],
    privacyRequests: [], privacySdkReplies: [], declaredTransportErrors: [],
  };
  (globalThis as any).__dueActivity = proof.activity;
  const declaredTransportError = new TypeError('Synthetic authorization transport failure');
  const db = createClient(HOST, 'synthetic-key', {
    accessToken: async () => null,
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (url: any, init: any = {}) => {
      proof.active++;
      try {
        const u = new URL(String(url));
        const method = init.method ?? 'GET';
        if (u.origin !== HOST || method !== 'GET' || init.body != null) {
          proof.forbidden.push(String(url));
          throw Error('Forbidden finite transport');
        }
        const table = u.pathname.slice('/rest/v1/'.length);
        const content = u.pathname === '/rest/v1/family_reminders' && u.searchParams.get('select') === '*';
        if (!content) {
          const key = queryKey(table, u.searchParams);
          const planned = proof.privacyPlan.find((entry: any) => entry.key === key);
          const priorAttempts = proof.privacyRequests.filter((entry: any) => entry.key === key).length;
          const attempt = Number(new Headers(init.headers).get('x-retry-count') ?? '0');
          if (!u.pathname.startsWith('/rest/v1/') || !planned || priorAttempts >= (planned.outcome === 'transport' ? 4 : 1) || attempt !== priorAttempts) {
            proof.forbidden.push(String(url));
            throw Error('Forbidden authorization query');
          }
          proof.privacyRequests.push({ key, attempt, method, table, query: u.search, payload: null });
          if (planned.outcome === 'transport') {
            proof.declaredTransportErrors.push({ key, attempt });
            throw declaredTransportError;
          }
          if (planned.outcome === 'sql') {
            return new Response(JSON.stringify({ code: '42501', message: 'Synthetic private authorization read denied' }), { status: 403, headers: { 'content-type': 'application/json' } });
          }
          return new Response(JSON.stringify(planned.body), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (proof.requests.length >= 2) {
          proof.forbidden.push(String(url));
          throw Error('Forbidden content page');
        }
        const headers = new Headers(init.headers);
        const page = proof.requests.length;
        proof.requests.push({ method, table, query: u.search, accept: headers.get('accept'), prefer: headers.get('prefer'), payload: null });
        if (page > 0) {
          if (options.nextPageError) {
            const denied = { code: '42501', message: 'Synthetic content page denied' };
            proof.rawResponses.push({ status: 403, body: denied });
            return new Response(JSON.stringify(denied), { status: 403, headers: { 'content-type': 'application/json' } });
          }
          proof.rawResponses.push({ status: 200, body: [] });
          return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        proof.rawResponses.push({ status: proof.status, body: proof.status === 204 ? null : body });
        return new Response(proof.status === 204 ? null : JSON.stringify(body), { status: proof.status, headers: { 'content-type': 'application/json' } });
      } catch (error) {
        if (error !== declaredTransportError) proof.transportErrors.push(error instanceof Error ? error.message : String(error));
        throw error;
      } finally { proof.active--; }
    } },
  });
  function observe(builder: any): any {
    return new Proxy(builder, { get(target, key) {
      if (key === 'then') return (fulfilled: any, rejected: any) => target.then((reply: any) => {
        const content = target.url.pathname === '/rest/v1/family_reminders' && target.url.searchParams.get('select') === '*';
        const receipt = { status: reply.status, data: reply.data, dataUndefined: reply.data === undefined, error: reply.error };
        if (!content) { proof.privacySdkReplies.push({ ...receipt, key: queryKey(target.url.pathname.slice('/rest/v1/'.length), target.url.searchParams) }); return reply; }
        proof.actualSdkReplies.push(receipt);
        if (options.adapter === 'undefined') {
          proof.declaredAdapters.push({ kind: 'post-await data undefined' });
          return { ...reply, data: undefined };
        }
        if (options.adapter === 'error') {
          proof.declaredAdapters.push({ kind: 'post-await data plus explicit error' });
          return { ...reply, error: { code: '42501', message: 'Declared synthetic read refusal' } };
        }
        return reply;
      }).then(fulfilled, rejected);
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args: any[]) => { const next = value.apply(target, args); return next && typeof next === 'object' ? observe(next) : next; };
    } });
  }
  const scope: any = {
    db: { from: (table: string) => {
      if (!['family_reminders', 'reminders', 'autopilot_suggestions'].includes(table)) {
        proof.forbidden.push(table); throw Error('Forbidden builder');
      }
      return observe(db.from(table));
    } },
    familyId: FAMILY, userId: 'synthetic-user', memberId: MEMBER, role: options.role ?? 'parent', actorKind: 'member', tz: 'UTC', now: new Date(NOW),
  };
  try { const result = await listDue(scope, input); proof.result = result; return result; }
  catch (error) {
    proof.serviceThrown = error instanceof Error ? error.message : String(error);
    proof.result = { thrown: proof.serviceThrown };
    return proof.result;
  }
}

// ORIGINAL CASES BEGIN
it('successful plain object receipt returns structured read refusal',async()=>{expect(await run({})).toMatchObject({ok:false,code:'db'});expect(proof.requests).toHaveLength(1);});
it('successful empty array-like object receipt returns structured read refusal',async()=>{expect(await run({length:0})).toMatchObject({ok:false,code:'db'});expect(proof.requests).toHaveLength(1);});
it('successful populated array-like object receipt returns structured read refusal',async()=>{expect(await run({length:1,0:active})).toMatchObject({ok:false,code:'db'});expect(proof.requests).toHaveLength(1);});
it('successful empty string receipt returns structured read refusal',async()=>{expect(await run('')).toMatchObject({ok:false,code:'db'});expect(proof.requests).toHaveLength(1);});
it('successful nonempty string receipt returns structured read refusal',async()=>{expect(await run('malformed')).toMatchObject({ok:false,code:'db'});expect(proof.requests).toHaveLength(1);});
it('successful zero receipt returns structured read refusal',async()=>{expect(await run(0)).toMatchObject({ok:false,code:'db'});expect(proof.requests).toHaveLength(1);});
it('successful finite nonzero number receipt returns structured read refusal',async()=>{expect(await run(7)).toMatchObject({ok:false,code:'db'});expect(proof.requests).toHaveLength(1);});
it('successful false boolean receipt returns structured read refusal',async()=>{expect(await run(false)).toMatchObject({ok:false,code:'db'});expect(proof.requests).toHaveLength(1);});
it('successful true boolean receipt returns structured read refusal',async()=>{expect(await run(true)).toMatchObject({ok:false,code:'db'});expect(proof.requests).toHaveLength(1);});
it('successful object with nonfunction filter receipt returns structured read refusal',async()=>{expect(await run({filter:"opaque"})).toMatchObject({ok:false,code:'db'});expect(proof.requests).toHaveLength(1);});
it('healthy empty array preserves complete empty result and minimum limit',async()=>{expect(await run([],{input:{limit:0}})).toEqual({ok:true,data:[]});expect(proof.requests).toHaveLength(1);});
it('healthy active array preserves entries and provided-now default horizon',async()=>{expect(await run([active],{manualIds:[active.id]})).toEqual({ok:true,data:[active]});expect(proof.requests).toHaveLength(2);expect(proof.rawResponses[1]).toEqual({status:200,body:[]});});
it('snooze filtering preserves elapsed missing and invalid-until policy',async()=>{const elapsed={...active,id:'elapsed',status:'snoozed',snoozed_until:'2026-10-10T14:59:00Z'},future={...active,id:'future',status:'snoozed',snoozed_until:'2026-10-10T15:01:00Z'},missing={...active,id:'missing',status:'snoozed',snoozed_until:null},invalid={...active,id:'invalid',status:'snoozed',snoozed_until:'bad'};expect(await run([active,future,elapsed,missing,invalid],{manualIds:[active.id,future.id,elapsed.id,missing.id,invalid.id]})).toEqual({ok:true,data:[active,elapsed,missing,invalid]});});
// Retain the original collection-only compatibility oracle under the explicit
// manager fallback. That role-authorized result proves no trusted row ownership.
it('nonnull opaque array entries preserve existing collection-only policy',async()=>{const rows=[17,false,'opaque',{id:'opaque-object'}];expect(await run(rows,{expectCards:true})).toEqual({ok:true,data:rows});});
it('HTTP200 null receipt preserves intentional empty result',async()=>{expect(await run(null)).toEqual({ok:true,data:[]});});
it('HTTP204 receipt preserves intentional empty result',async()=>{expect(await run(null,{status:204})).toEqual({ok:true,data:[]});});
it('declared post-await undefined data preserves nullish empty policy',async()=>{expect(await run([],{adapter:'undefined'})).toEqual({ok:true,data:[]});expect(proof.actualSdkReplies[0].data).toEqual([]);expect(proof.declaredAdapters).toEqual([{kind:'post-await data undefined'}]);});
it('HTTP403 error preserves structured database refusal before filtering',async()=>{expect(await run({code:'42501',message:'Synthetic read denied'},{status:403})).toMatchObject({ok:false,code:'db'});});
it('declared data-plus-error adapter preserves explicit error precedence',async()=>{expect(await run([active],{adapter:'error'})).toMatchObject({ok:false,code:'db'});expect(proof.actualSdkReplies[0].error).toBeNull();expect(proof.actualSdkReplies[0].data).toEqual([active]);});
it('invalid horizon refuses before any SDK request',async()=>{expect(await run([],{input:{before:'invalid'}})).toMatchObject({ok:false,code:'invalid_input'});expect(proof.requests).toEqual([]);});
it('explicit offset horizon and member preserve exact family-scoped GET filters',async()=>{expect(await run([active],{manualIds:[active.id],input:{before:'2026-10-10T11:00:00-04:00',memberId:MEMBER,limit:12}})).toEqual({ok:true,data:[active]});expect(proof.expectedHorizon).toBe(NOW);});
it('within-minutes horizon and upper limit preserve bounded query semantics',async()=>{expect(await run([],{input:{withinMinutes:5,limit:501}})).toEqual({ok:true,data:[]});expect(proof.expectedHorizon).toBe('2026-10-10T15:05:00.000Z');});
// ORIGINAL CASES END

it('nonnull opaque array entries establish no ownership for a nonmanager',async()=>{const rows=[17,false,'opaque',{id:'opaque-object'}];expect(await run(rows,{role:'child',expectCards:true})).toEqual({ok:true,data:[]});});
// Manager fallback is authorized by role; it is not proof that a row is manual.
it('a manager retains a valid-ID reminder whose origin is unresolved',async()=>{expect(await run([active],{expectCards:true})).toEqual({ok:true,data:[active]});});
it('the same unresolved valid-ID reminder is withheld from a nonmanager',async()=>{expect(await run([active],{role:'child',expectCards:true})).toEqual({ok:true,data:[]});});
it('an explicit manual origin admits the same valid-ID reminder to a nonmanager',async()=>{expect(await run([active],{role:'child',manualIds:[active.id]})).toEqual({ok:true,data:[active]});});

// A missing origin is a readable absence. A failed authorization read cannot
// establish either an empty due list or the manager's unresolved-row fallback.
it.each((['family_reminders', 'reminders', 'autopilot_suggestions'] as const).flatMap((table) =>
  (['parent', 'child'] as const).map((role) => ({ table, role }))))(
  '$table SQL refusal answers unavailable to $role',
  async ({ table, role }) => {
    const result = await run([active], {
      role, expectCards: table === 'autopilot_suggestions', privacyFailure: { table, kind: 'sql' },
    });
    expect(result).toEqual({ ok: false, code: 'db', error: 'Could not load your reminders.', retryable: true });
    expect(result).not.toHaveProperty('data');
    expect(JSON.stringify(result)).not.toContain(active.id);
  },
);
it.each([
  { table: 'reminders', role: 'child' },
  { table: 'autopilot_suggestions', role: 'parent' },
] as const)('$table terminal transport failure answers unavailable to $role', async ({ table, role }) => {
  const result = await run([active], {
    role, expectCards: table === 'autopilot_suggestions', privacyFailure: { table, kind: 'transport' },
  });
  expect(result).toEqual({ ok: false, code: 'db', error: 'Could not load your reminders.', retryable: true });
  expect(result).not.toHaveProperty('data');
  expect(proof.declaredTransportErrors.map((entry: any) => entry.attempt)).toEqual([0, 1, 2, 3]);
});
it('a later content-page error keeps precedence over an earlier authorization failure', async () => {
  const result = await run([active], { role: 'child', privacyFailure: { table: 'reminders', kind: 'sql' }, nextPageError: true });
  expect(result).toEqual({
    ok: false, code: 'db',
    error: "You don't have permission to do that. Ask a family admin if you think this is a mistake.",
  });
  expect(proof.actualSdkReplies[1].error.code).toBe('42501');
});
