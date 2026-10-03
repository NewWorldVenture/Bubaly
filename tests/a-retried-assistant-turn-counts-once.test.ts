import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// F19, owner review 5393250792 on #788: a retried or accidentally repeated
// assistant send is ONE turn. It must not consume another allowance unit or
// repeat its effect, while a genuinely new send still counts — and the retry
// of the turn that reached 10 of 10 must not be refused as an eleventh.
//
// This drives the real `/api/ai` POST, the real allowance check, the real
// `withAiRequest` + `createRequest` (and its 23505 handling), the real replay
// lookup and the real `runAssistantTurn` / stream, against an in-memory
// database that enforces 0255's unique (family_id, client_request_id) index.
// Only identity, plan/tier settings, the rate limiter and the model are fixed.

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  providerCalls: 0,
  /** Stands in for the turn's tool writes: one per model run. */
  effects: 0,
  prepares: 0,
  planLevel: 0,
  user: { id: 'user-1', email: 'parent@example.com' },
  gate: null as Promise<void> | null,
  /** What the model answers; a test that needs two distinguishable turns sets it. */
  answer: null as string | null,
  /**
   * 'collision-unreadable': the ai_requests INSERT hits the unique key and the
   * read-back of the original row fails. 'insert-error': the INSERT fails.
   */
  fault: null as null | 'collision-unreadable' | 'insert-error',
  /** The model's stream runs a tool, then breaks before any text. */
  breakAfterAction: false,
  faulted: false,
  /** The turn's ai_messages INSERT fails (after the model and its tools ran). */
  messagesFault: false,
  /** Holds the wrapper's settling update on ai_requests: the window after the exchange is saved. */
  settleGate: null as Promise<void> | null,
  /** The stream runs a tool (an action event) before its text. */
  withTool: false,
  /** The stream breaks after its text reached the family. */
  breakStream: false,
}));

const FAMILY = 'fam-1';
const CONV = '22222222-2222-4222-8222-222222222222';
const OTHER_CONV = '33333333-3333-4333-8333-333333333333';

let clock = Date.parse('2026-10-02T12:00:00.000Z');
const tick = () => new Date(clock += 5).toISOString();

const tableOf = (name: string) => (state.tables[name] ??= []);

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'insert' | 'update' | 'upsert' = 'select';
  private payload: unknown = null;
  private head = false;
  private ordered: { col: string; asc: boolean } | null = null;
  private max: number | null = null;
  constructor(private readonly name: string) {}
  select(_cols?: string, opts?: { head?: boolean }) { if (this.op === 'select') this.head = Boolean(opts?.head); return this; }
  insert(rows: Row | Row[]) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows: Row | Row[]) { this.op = 'upsert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch: Row) { this.op = 'update'; this.payload = patch; return this; }
  eq(col: string, v: unknown) { this.filters.push((r) => r[col] === v); return this; }
  in(col: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[col])); return this; }
  gte(col: string, v: string) { this.filters.push((r) => String(r[col]) >= v); return this; }
  lte(col: string, v: string) { this.filters.push((r) => String(r[col]) <= v); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.ordered = { col, asc: opts?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  async maybeSingle() { const r = await this.run(); return { data: r.data?.[0] ?? null, error: r.error }; }
  async single() {
    const r = await this.run();
    if (r.error) return { data: null, error: r.error };
    return r.data?.[0] ? { data: r.data[0], error: null } : { data: null, error: { message: 'no row' } };
  }
  then<T>(ok: (v: { data: Row[] | null; error: unknown; count?: number }) => T, ko?: (e: unknown) => T) { return this.run().then(ok, ko); }

  private async run(): Promise<{ data: Row[] | null; error: { code?: string; message: string } | null; count?: number }> {
    await Promise.resolve();
    const rows = tableOf(this.name);
    if (this.name === 'ai_messages' && this.op === 'insert' && state.messagesFault) {
      return { data: null, error: { code: '08006', message: 'connection failure' } };
    }
    if (this.name === 'ai_requests' && this.op === 'update' && state.settleGate
      && ['completed', 'partially_completed', 'failed'].includes(String((this.payload as Row).status))) {
      await state.settleGate;
    }
    if (this.name === 'ai_requests' && this.op === 'insert' && state.fault) {
      state.faulted = true;
      return state.fault === 'collision-unreadable'
        ? { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_ai_requests_client_request"' } }
        : { data: null, error: { code: '08006', message: 'connection failure' } };
    }
    // After the collision, the original row cannot be read back.
    if (this.name === 'ai_requests' && this.op === 'select' && !this.head && state.faulted && state.fault === 'collision-unreadable') {
      return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
    }
    if (this.op === 'insert' || this.op === 'upsert') {
      const out: Row[] = [];
      for (const raw of this.payload as Row[]) {
        if (this.op === 'upsert' && rows.some((r) => r.id === raw.id)) continue;
        const row: Row = { id: raw.id ?? crypto.randomUUID(), created_at: tick(), ...raw };
        if (this.name === 'ai_requests' && row.client_request_id != null
          && rows.some((r) => r.family_id === row.family_id && r.client_request_id === row.client_request_id)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_ai_requests_client_request"' } };
        }
        rows.push(row);
        out.push(row);
      }
      return { data: out, error: null };
    }
    let hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === 'update') {
      for (const r of hit) Object.assign(r, this.payload as Row);
      return { data: hit, error: null };
    }
    if (this.head) return { data: null, error: null, count: hit.length };
    if (this.ordered) {
      const { col, asc } = this.ordered;
      hit = [...hit].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
    }
    if (this.max !== null) hit = hit.slice(0, this.max);
    return { data: hit, error: null };
  }
}

const db = { from: (name: string) => new Query(name), auth: { getUser: async () => ({ data: { user: state.user } }) } };

const ctx = () => ({
  user: state.user,
  memberships: [],
  active: { familyId: FAMILY, role: 'parent', member: { id: 'member-1' }, family: { name: 'Fam', timezone: 'UTC' } },
});

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => db, createServiceClient: () => db }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: async () => ctx(), requireUserContext: async () => ctx() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/assistant/tools', () => ({ buildAssistantTools: () => [] }));
vi.mock('@/lib/assistant/trust-wrapper', () => ({ wrapToolsWithTrust: () => [] }));
vi.mock('@/lib/supabase/bearer', () => ({ extractBearerToken: () => null, getBearerUserContext: async () => ({ ok: false, reason: 'invalid_token' }) }));
vi.mock('@/lib/server/ensure-family', () => ({ ensureActiveFamily: async () => true }));
vi.mock('@/lib/server/ai-request-context', () => ({
  assertAIRequestFamily: () => null,
  getAIRequestTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: async () => ({ ok: true }) }));
vi.mock('@/lib/server/feature-tiers', () => ({
  getResolvedFeatureTiers: async () => ({ 'ai-assistant': 'free' }),
  getFeatureTiersByHref: async () => ({}),
}));
vi.mock('@/lib/server/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/plan')>()),
  resolveFamilyPlanLevel: async () => state.planLevel,
}));
vi.mock('@/lib/ai/usage', () => ({ recordModelCall: async () => {} }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => true,
  resolveProvider: async () => provider,
}));

const ANSWER = 'Dinner is planned for Friday.';
async function model() {
  state.providerCalls += 1;
  if (state.gate) await state.gate;
  state.effects += 1;
}
const provider = vi.hoisted(() => ({}) as Record<string, unknown>);
Object.assign(provider, {
  model: 'test-model',
  runTools: async () => { await model(); return { text: state.answer ?? ANSWER, actions: [], usage: { promptTokens: 1, completionTokens: 1 } }; },
  async *runToolsStream() {
    await model();
    if (state.breakAfterAction) {
      // A tool ran, then the stream broke before any text.
      yield { type: 'action' as const, name: 'add_grocery_item', args: { name: 'milk' }, result: { ok: true, summary: 'Added milk' } };
      throw new Error('stream broke');
    }
    if (state.withTool) yield { type: 'action' as const, name: 'add_task', args: { title: 'Buy milk' }, result: { ok: true, summary: 'Added Buy milk' } };
    yield { type: 'delta' as const, text: state.answer ?? ANSWER };
    if (state.breakStream) throw new Error('upstream connection reset');
  },
});
// Preparation (classifier + context) is the costly half before the model; a
// replay must not reach it either.
vi.mock('@/lib/ai/assistant-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/assistant-engine')>()),
  prepareAssistantTurn: async () => {
    state.prepares += 1;
    return {
      ok: true,
      turn: {
        system: 's', messages: [], tools: [], provider,
        intent: { intent: 'other', confidence: 1, entities: {}, source: 'fast_path' },
        context: {}, cardContext: { members: [], currency: 'USD' },
        scope: { db, familyId: FAMILY, userId: state.user.id, memberId: 'member-1', role: 'parent', actorKind: 'ai', tz: 'UTC' },
      },
    };
  },
}));

function sendChat(key?: string, message = 'Plan dinner') {
  return new NextRequest('http://localhost/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify({ conversationId: CONV, message }),
  });
}

function send(opts: { key?: string | null; message?: string; conversationId?: string; json?: boolean; bodyKey?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: opts.json === false ? 'text/event-stream' : 'application/json' };
  if (opts.key) headers['idempotency-key'] = opts.key;
  return new NextRequest('http://localhost/api/ai', {
    method: 'POST', headers,
    body: JSON.stringify({
      conversationId: opts.conversationId ?? CONV,
      message: opts.message ?? 'Plan dinner',
      ...(opts.bodyKey ? { clientRequestId: opts.bodyKey } : {}),
    }),
  });
}

const turnRows = () => tableOf('ai_requests').filter((r) => r.feature === 'assistant.turn' || r.feature === 'assistant.stream');
function seed(n: number) {
  for (let i = 0; i < n; i++) tableOf('ai_requests').push({ id: `old-${i}`, family_id: FAMILY, requested_by: 'user-1', feature: 'notes.summary', status: 'completed', created_at: tick() });
}
function events(text: string) {
  return text.split('\n\n').filter((p) => p.startsWith('data:')).map((p) => JSON.parse(p.slice(5).trim()) as Record<string, unknown>);
}

beforeEach(() => {
  state.tables = {};
  state.providerCalls = 0;
  state.effects = 0;
  state.prepares = 0;
  state.planLevel = 0;
  state.user = { id: 'user-1', email: 'parent@example.com' };
  state.gate = null;
  state.answer = null;
  state.fault = null;
  state.faulted = false;
  state.breakAfterAction = false;
  state.messagesFault = false;
  state.settleGate = null;
  state.withTool = false;
  state.breakStream = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('a retried assistant send is one turn', () => {
  it('the retry of the turn that reached 10 of 10 replays its answer; it is not refused, counted or re-run', async () => {
    const { POST } = await import('@/app/api/ai/route');
    seed(9);
    const first = await POST(send({ key: 'send-0001-abcdef' }));
    expect(first.status).toBe(200);
    const original = await first.json() as { content: string };
    expect(original.content).toBe(ANSWER);
    expect(tableOf('ai_requests')).toHaveLength(10);

    for (let i = 0; i < 3; i++) {
      const retry = await POST(send({ key: 'send-0001-abcdef' }));
      expect(retry.status).toBe(200);
      const body = await retry.json() as { content: string; replayed: boolean; requestId: string };
      expect(body).toMatchObject({ content: ANSWER, replayed: true, requestId: turnRows()[0].id });
    }
    expect(tableOf('ai_requests')).toHaveLength(10);
    expect(state.providerCalls).toBe(1);
    expect(state.effects).toBe(1);
    expect(state.prepares).toBe(1);
    expect(tableOf('ai_messages')).toHaveLength(2); // one exchange saved, once
  });

  it('a genuinely new send at 10 of 10 is still refused before the model', async () => {
    const { POST } = await import('@/app/api/ai/route');
    seed(9);
    expect((await POST(send({ key: 'send-0001-abcdef' }))).status).toBe(200);
    expect((await POST(send({ key: 'send-0002-abcdef', message: 'And lunch?' }))).status).toBe(429);
    expect(state.providerCalls).toBe(1);
  });

  it('a new send with a new key counts as a new turn, even with the same words', async () => {
    const { POST } = await import('@/app/api/ai/route');
    expect((await POST(send({ key: 'send-0001-abcdef' }))).status).toBe(200);
    expect((await POST(send({ key: 'send-0002-abcdef' }))).status).toBe(200);
    expect(turnRows()).toHaveLength(2);
    expect(state.providerCalls).toBe(2);
  });

  it('two attempts with one key racing past the lookup are still one turn (the unique index decides)', async () => {
    const { POST } = await import('@/app/api/ai/route');
    seed(9);
    let release!: () => void;
    state.gate = new Promise<void>((r) => { release = r; });
    const a = POST(send({ key: 'send-0001-abcdef' }));
    const b = POST(send({ key: 'send-0001-abcdef' }));
    const loser = await b;
    // Both read "no prior turn" before either filed; the loser's INSERT hit the
    // index and it stopped before its model call.
    expect(loser.status).toBe(409);
    expect((await loser.json() as { code: string }).code).toBe('turn_in_progress');
    release();
    expect((await a).status).toBe(200);
    expect(state.providerCalls).toBe(1);
    expect(tableOf('ai_requests')).toHaveLength(10);
    expect(tableOf('ai_messages')).toHaveLength(2);
  });

  it('the stream transport replays the answer with the same request id, so speech rides on the same exchange', async () => {
    const { POST } = await import('@/app/api/ai/route');
    seed(9);
    const first = events(await (await POST(send({ key: 'send-0001-abcdef', json: false }))).text());
    const done = first.find((e) => e.type === 'done');
    expect(done).toMatchObject({ content: ANSWER, requestId: turnRows()[0].id });

    const replay = events(await (await POST(send({ key: 'send-0001-abcdef', json: false }))).text());
    expect(replay).toEqual([
      { type: 'delta', text: ANSWER },
      { type: 'done', content: ANSWER, persisted: true, requestId: done!.requestId },
    ]);
    expect(state.providerCalls).toBe(1);
    expect(tableOf('ai_requests')).toHaveLength(10);
  });

  it('a stream attempt that loses the race reports it and runs nothing', async () => {
    const { POST } = await import('@/app/api/ai/route');
    let release!: () => void;
    state.gate = new Promise<void>((r) => { release = r; });
    const a = POST(send({ key: 'send-0001-abcdef', json: false }));
    const b = POST(send({ key: 'send-0001-abcdef', json: false }));
    const [ra, rb] = await Promise.all([a, b]);
    const loserText = rb.text();
    const loser = events(await loserText);
    expect(loser).toEqual([{ type: 'error', error: 'ai.thisMessageIsAlreadyBeingAnswered' }]);
    release();
    expect(events(await ra.text()).at(-1)).toMatchObject({ type: 'done', content: ANSWER });
    expect(state.providerCalls).toBe(1);
    expect(turnRows()).toHaveLength(1);
  });

  it('a send without a key (older clients) behaves as before: each one counts', async () => {
    const { POST } = await import('@/app/api/ai/route');
    expect((await POST(send())).status).toBe(200);
    expect((await POST(send())).status).toBe(200);
    expect(turnRows()).toHaveLength(2);
    expect(turnRows().every((r) => r.client_request_id === null)).toBe(true);
  });

  it('the key may come in the body as clientRequestId', async () => {
    const { POST } = await import('@/app/api/ai/route');
    expect((await POST(send({ bodyKey: 'send-0001-abcdef' }))).status).toBe(200);
    expect((await (await POST(send({ bodyKey: 'send-0001-abcdef' }))).json() as { replayed?: boolean }).replayed).toBe(true);
    expect(state.providerCalls).toBe(1);
  });

  it('a malformed key is refused, not dropped (a dropped key would make the retry a second turn)', async () => {
    const { POST } = await import('@/app/api/ai/route');
    const res = await POST(send({ key: 'short' }));
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe('client_request_id_invalid');
    expect(state.providerCalls).toBe(0);
  });
});

describe('a key never unlocks someone else’s turn or a different message', () => {
  async function firstTurn() {
    const { POST } = await import('@/app/api/ai/route');
    expect((await POST(send({ key: 'send-0001-abcdef' }))).status).toBe(200);
    return POST;
  }

  it('another member of the family reusing the key is refused and counts nothing', async () => {
    const POST = await firstTurn();
    state.user = { id: 'user-2', email: 'teen@example.com' };
    const res = await POST(send({ key: 'send-0001-abcdef' }));
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string; content?: string })).toMatchObject({ code: 'client_request_id_conflict' });
    expect(state.providerCalls).toBe(1);
    expect(turnRows()).toHaveLength(1);
  });

  it('the key sent with different words is not a retry of that turn', async () => {
    const POST = await firstTurn();
    const res = await POST(send({ key: 'send-0001-abcdef', message: 'Something else entirely' }));
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe('client_request_id_conflict');
    expect(state.providerCalls).toBe(1);
  });

  it('the key sent into a different conversation is refused', async () => {
    const POST = await firstTurn();
    const res = await POST(send({ key: 'send-0001-abcdef', conversationId: OTHER_CONV }));
    expect(res.status).toBe(409);
    expect(state.providerCalls).toBe(1);
  });

  it('a concierge request filed under the same raw key does not collide with a turn', async () => {
    const { POST } = await import('@/app/api/ai/route');
    tableOf('ai_requests').push({ id: 'concierge-1', family_id: FAMILY, requested_by: 'user-1', kind: 'concierge', feature: null, client_request_id: 'send-0001-abcdef', status: 'completed', created_at: tick() });
    expect((await POST(send({ key: 'send-0001-abcdef' }))).status).toBe(200);
    expect(turnRows()).toHaveLength(1);
    expect(turnRows()[0].client_request_id).toBe('assistant:send-0001-abcdef');
  });
});

describe('a retry of an attempt that has not answered', () => {
  function priorRow(status: string) {
    tableOf('ai_requests').push({
      id: 'turn-1', family_id: FAMILY, requested_by: 'user-1', feature: 'assistant.stream', conversation_id: CONV,
      client_request_id: 'assistant:send-0001-abcdef', status, created_at: tick(), completed_at: status === 'executing' ? null : tick(),
    });
  }

  it.each([
    ['executing', 'turn_in_progress'],
    ['queued', 'turn_in_progress'],
    ['failed', 'turn_failed'],
  ])('%s: 409 %s, no model, no new row — even at 10 of 10', async (status, code) => {
    const { POST } = await import('@/app/api/ai/route');
    seed(9);
    priorRow(status);
    const res = await POST(send({ key: 'send-0001-abcdef' }));
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string; requestId: string })).toMatchObject({ code, requestId: 'turn-1' });
    expect(state.providerCalls).toBe(0);
    expect(tableOf('ai_requests')).toHaveLength(10);
  });

  it('answered but its answer was not saved: 409 turn_unsaved, not a second run', async () => {
    const { POST } = await import('@/app/api/ai/route');
    priorRow('partially_completed');
    const res = await POST(send({ key: 'send-0001-abcdef' }));
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe('turn_unsaved');
    expect(state.providerCalls).toBe(0);
  });

  it('control: completed with no saved exchange (a turn filed before exchanges carried its id) stays 409 turn_answered', async () => {
    const { POST } = await import('@/app/api/ai/route');
    priorRow('completed');
    const res = await POST(send({ key: 'send-0001-abcdef' }));
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe('turn_answered');
    expect(state.providerCalls).toBe(0);
  });
});

// A turn whose stream broke after text reached the family settles
// `partially_completed` and its first attempt ended with an `error` event. Its
// retry replays the saved half answer the same way — never as a clean reply
// the client would take for a whole answer (and speak aloud).
describe('a retry of an answer that was cut off says so', () => {
  const HALF = 'Dinner is planned for';
  function cutOffTurn(feature = 'assistant.stream') {
    tableOf('ai_requests').push({
      id: 'turn-1', family_id: FAMILY, requested_by: 'user-1', feature, conversation_id: CONV,
      client_request_id: 'assistant:send-0001-abcdef', status: 'partially_completed', created_at: tick(), completed_at: tick(),
    });
    tableOf('ai_messages').push(
      { id: 'm1', family_id: FAMILY, conversation_id: CONV, role: 'user', content: 'Plan dinner', request_id: 'turn-1', created_at: tick() },
      { id: 'm2', family_id: FAMILY, conversation_id: CONV, role: 'assistant', content: HALF, request_id: 'turn-1', created_at: tick() },
    );
  }

  it('/api/ai stream: the half answer, then the error, then done — no model, no new row', async () => {
    const { POST } = await import('@/app/api/ai/route');
    seed(9);
    cutOffTurn();
    const replay = events(await (await POST(send({ key: 'send-0001-abcdef', json: false }))).text());
    expect(replay).toEqual([
      { type: 'delta', text: HALF },
      { type: 'error', error: 'ai.thatAnswerWasCutOff' },
      { type: 'done', content: HALF, persisted: true, requestId: 'turn-1' },
    ]);
    expect(state.providerCalls).toBe(0);
    expect(state.prepares).toBe(0);
    expect(tableOf('ai_requests')).toHaveLength(10);
  });

  it('/api/ai JSON: a 200 replay marked partial, with the error', async () => {
    const { POST } = await import('@/app/api/ai/route');
    seed(9);
    cutOffTurn();
    const res = await POST(send({ key: 'send-0001-abcdef' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      conversationId: CONV, content: HALF, actions: [], cards: [], runIds: [], persisted: true,
      replayed: true, requestId: 'turn-1', partial: true, error: 'ai.thatAnswerWasCutOff',
    });
    expect(state.providerCalls).toBe(0);
    expect(tableOf('ai_requests')).toHaveLength(10);
  });

  it('/api/ai/chat: the same three events', async () => {
    const { POST } = await import('@/app/api/ai/chat/route');
    cutOffTurn('chat.assistant');
    const replay = events(await (await POST(sendChat('send-0001-abcdef'))).text());
    expect(replay).toEqual([
      { type: 'delta', text: HALF },
      { type: 'error', error: 'ai.thatAnswerWasCutOff' },
      { type: 'done', content: HALF, persisted: true, requestId: 'turn-1' },
    ]);
    expect(state.providerCalls).toBe(0);
    expect(tableOf('ai_requests')).toHaveLength(1);
  });

  it('control: a completed turn with the same saved exchange replays clean, unmarked', async () => {
    const { POST } = await import('@/app/api/ai/route');
    cutOffTurn();
    tableOf('ai_requests')[0].status = 'completed';
    const body = await (await POST(send({ key: 'send-0001-abcdef' }))).json() as Record<string, unknown>;
    expect(body).toMatchObject({ content: HALF, replayed: true });
    expect(body).not.toHaveProperty('partial');
    expect(body).not.toHaveProperty('error');
  });
});

// The second assistant entry point (`chat.assistant`, SSE only) keeps the
// same rule, through the same lookup and the same index.
describe('/api/ai/chat: a retried send is one turn there too', () => {
  const chatRows = () => tableOf('ai_requests').filter((r) => r.feature === 'chat.assistant');

  it('the retry of the turn that reached 10 of 10 replays it with the same request id', async () => {
    const { POST } = await import('@/app/api/ai/chat/route');
    seed(9);
    const first = events(await (await POST(sendChat('send-0001-abcdef'))).text());
    const done = first.find((e) => e.type === 'done');
    expect(done).toMatchObject({ content: ANSWER, requestId: chatRows()[0].id });
    const replay = events(await (await POST(sendChat('send-0001-abcdef'))).text());
    expect(replay).toEqual([
      { type: 'delta', text: ANSWER },
      { type: 'done', content: ANSWER, persisted: true, requestId: done!.requestId },
    ]);
    expect(state.providerCalls).toBe(1);
    expect(tableOf('ai_requests')).toHaveLength(10);
    expect(tableOf('ai_messages')).toHaveLength(2);
    expect((await POST(sendChat('send-0002-abcdef', 'And lunch?'))).status).toBe(429);
  });

  it('two attempts racing with one key are one turn', async () => {
    const { POST } = await import('@/app/api/ai/chat/route');
    let release!: () => void;
    state.gate = new Promise<void>((r) => { release = r; });
    const [ra, rb] = await Promise.all([POST(sendChat('send-0001-abcdef')), POST(sendChat('send-0001-abcdef'))]);
    expect(events(await rb.text())).toEqual([{ type: 'error', error: 'ai.thisMessageIsAlreadyBeingAnswered' }]);
    release();
    expect(events(await ra.text()).at(-1)).toMatchObject({ type: 'done', content: ANSWER });
    expect(state.providerCalls).toBe(1);
    expect(chatRows()).toHaveLength(1);
  });

  it('the key with different words, or a malformed key, is refused and runs nothing', async () => {
    const { POST } = await import('@/app/api/ai/chat/route');
    await (await POST(sendChat('send-0001-abcdef'))).text();
    expect((await POST(sendChat('send-0001-abcdef', 'Something else'))).status).toBe(409);
    expect((await POST(sendChat('short'))).status).toBe(400);
    expect(state.providerCalls).toBe(1);
  });

  it('a key filed on /api/ai replays on /api/ai/chat (one turn, whichever door)', async () => {
    const { POST: viaAi } = await import('@/app/api/ai/route');
    const { POST: viaChat } = await import('@/app/api/ai/chat/route');
    expect((await viaAi(send({ key: 'send-0001-abcdef' }))).status).toBe(200);
    const replay = events(await (await viaChat(sendChat('send-0001-abcdef'))).text());
    expect(replay.at(-1)).toMatchObject({ type: 'done', content: ANSWER, requestId: turnRows()[0].id });
    expect(state.providerCalls).toBe(1);
  });
});

// #788 release review 5964060680: the replay found "its" answer as the first
// user/assistant pair written in the conversation after the row was filed.
// It now reads the exchange bound to the request (`ai_messages.request_id`).
describe('a replay returns its own turn’s answer, never a neighbour’s', () => {
  it('two turns in one conversation each replay their own answer', async () => {
    const { POST } = await import('@/app/api/ai/route');
    state.answer = 'First answer.';
    expect((await POST(send({ key: 'send-0001-abcdef', message: 'First question' }))).status).toBe(200);
    state.answer = 'Second answer.';
    expect((await POST(send({ key: 'send-0002-abcdef', message: 'Second question' }))).status).toBe(200);
    state.answer = 'Never asked for.';
    const first = await (await POST(send({ key: 'send-0001-abcdef', message: 'First question' }))).json() as { content: string };
    const second = await (await POST(send({ key: 'send-0002-abcdef', message: 'Second question' }))).json() as { content: string };
    expect(first.content).toBe('First answer.');
    expect(second.content).toBe('Second answer.');
    expect(state.providerCalls).toBe(2);
  });

  it('a turn whose own answer was not saved never replays the next turn’s answer', async () => {
    const { POST } = await import('@/app/api/ai/route');
    // Filed and answered, but its exchange was not saved…
    tableOf('ai_requests').push({
      id: 'turn-1', family_id: FAMILY, requested_by: 'user-1', feature: 'assistant.turn', conversation_id: CONV,
      client_request_id: 'assistant:send-0001-abcdef', status: 'partially_completed', created_at: tick(), completed_at: tick(),
    });
    // …and five seconds later another turn saved its exchange in the same conversation.
    tableOf('ai_messages').push(
      { id: 'm1', family_id: FAMILY, conversation_id: CONV, role: 'user', content: 'Plan dinner', request_id: 'turn-2', created_at: tick() },
      { id: 'm2', family_id: FAMILY, conversation_id: CONV, role: 'assistant', content: 'Someone else’s answer.', request_id: 'turn-2', created_at: tick() },
    );
    const res = await POST(send({ key: 'send-0001-abcdef' }));
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe('turn_unsaved');
    expect(state.providerCalls).toBe(0);
  });

  it('a message a member writes later under the same request id does not replace the replayed answer', async () => {
    const { POST } = await import('@/app/api/ai/route');
    expect((await POST(send({ key: 'send-0001-abcdef' }))).status).toBe(200);
    tableOf('ai_messages').push({ id: 'zz', family_id: FAMILY, conversation_id: CONV, role: 'assistant', content: 'Forged.', request_id: turnRows()[0].id, created_at: tick() });
    const replay = await (await POST(send({ key: 'send-0001-abcdef' }))).json() as { content: string };
    expect(replay.content).toBe(ANSWER);
  });

  it('every saved exchange row carries its turn’s request id', async () => {
    const { POST: viaAi } = await import('@/app/api/ai/route');
    const { POST: viaChat } = await import('@/app/api/ai/chat/route');
    await viaAi(send({ key: 'send-0001-abcdef' }));
    await (await viaAi(send({ key: 'send-0002-abcdef', json: false }))).text();
    await (await viaChat(sendChat('send-0003-abcdef'))).text();
    const rows = tableOf('ai_requests').filter((r) => typeof r.client_request_id === 'string');
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      const saved = tableOf('ai_messages').filter((m) => m.request_id === r.id);
      expect(saved.map((m) => m.role).sort()).toEqual(['assistant', 'user']);
    }
  });
});

// #788 review 5964206145 (item 3): a keyed duplicate whose original row could
// not be read back left the earlier attempt's outcome unknown, and on Basic and
// Plus the turn ran again. A keyed send now fails closed on every plan, before
// the model; unkeyed sends on a paid plan keep running unrecorded, as before.
describe('a keyed send whose request cannot be recorded runs nothing, on every plan', () => {
  it.each([[0, 'Free'], [1, 'Basic'], [2, 'Plus']])('plan %i (%s), JSON: 503, no model call', async (level) => {
    const { POST } = await import('@/app/api/ai/route');
    state.planLevel = level as number;
    state.fault = 'collision-unreadable';
    const res = await POST(send({ key: 'send-0001-abcdef' }));
    expect(res.status).toBe(503);
    expect(state.providerCalls).toBe(0);
    expect(state.effects).toBe(0);
  });

  it('paid plan, stream: an error event, no model call', async () => {
    const { POST } = await import('@/app/api/ai/route');
    state.planLevel = 2;
    state.fault = 'collision-unreadable';
    const ev = events(await (await POST(send({ key: 'send-0001-abcdef', json: false }))).text());
    expect(ev).toEqual([{ type: 'error', error: 'ai.accountContextIsTemporarilyUnavailable' }]);
    expect(state.providerCalls).toBe(0);
  });

  it('paid plan, /api/ai/chat: an error event, no model call', async () => {
    const { POST } = await import('@/app/api/ai/chat/route');
    state.planLevel = 2;
    state.fault = 'insert-error';
    const ev = events(await (await POST(sendChat('send-0001-abcdef'))).text());
    expect(ev).toEqual([{ type: 'error', error: 'ai.accountContextIsTemporarilyUnavailable' }]);
    expect(state.providerCalls).toBe(0);
  });

  it('control: an unkeyed send on a paid plan whose filing fails still runs, as before', async () => {
    const { POST } = await import('@/app/api/ai/route');
    state.planLevel = 2;
    state.fault = 'insert-error';
    const res = await POST(send());
    expect(res.status).toBe(200);
    expect(state.providerCalls).toBe(1);
  });

  it('control: an unkeyed send on Free whose filing fails is refused, as before', async () => {
    const { POST } = await import('@/app/api/ai/route');
    state.fault = 'insert-error';
    expect((await POST(send())).status).not.toBe(200);
    expect(state.providerCalls).toBe(0);
  });
});

// Review of #875 (claim #771 5968933130): #834 runs no fallback once a tool has
// run, so on /api/ai/chat a stream that broke after a tool but before any text
// settled `failed`. #788's replay then said "did not finish" and the resend ran
// the tool again. A turn whose tool ran is partial, as on the engine path.
describe('/api/ai/chat: a turn whose tool ran before the stream broke is partial, not failed', () => {
  it('settles partially_completed, and a keyed retry replays it instead of running the tool again', async () => {
    const { POST } = await import('@/app/api/ai/chat/route');
    state.breakAfterAction = true;
    await (await POST(sendChat('send-0001-abcdef'))).text();
    const row = tableOf('ai_requests').find((r) => r.feature === 'chat.assistant');
    // The stream closes inside the request; the row settles just after the
    // body returns, so wait for it rather than assume the runtime's ordering.
    await vi.waitFor(() => expect(row?.status).toBe('partially_completed'));
    expect(state.effects).toBe(1);

    const replay = events(await (await POST(sendChat('send-0001-abcdef'))).text());
    expect(replay.map((e) => e.type)).toEqual(['delta', 'error', 'done']);
    expect(replay.at(-1)).toMatchObject({ requestId: row!.id });
    expect(state.providerCalls).toBe(1);
    expect(state.effects).toBe(1);
  });
});

// #875 review 5970538108. Two windows where a retry met an answered turn and
// could not get its answer: (1) the exchange could not be saved after the
// tools ran, yet the row settled `completed`; (2) the exchange was saved but
// the row was not settled yet (the process died, or the retry arrived before
// the wrapper finished). The saved exchange now decides, and nothing reruns.
describe('a retry after the answer was saved, or failed to save', () => {
  const KEY = 'send-0001-abcdef';
  function turnRow(status: string, feature = 'chat.assistant') {
    tableOf('ai_requests').push({
      id: 'turn-1', family_id: FAMILY, requested_by: 'user-1', feature, conversation_id: CONV,
      client_request_id: `assistant:${KEY}`, status, created_at: tick(), completed_at: status === 'executing' ? null : tick(),
    });
  }
  function savedPair(opts: { message?: string; conversationId?: string; cutOff?: boolean } = {}) {
    tableOf('ai_messages').push(
      { id: 'm1', family_id: FAMILY, conversation_id: opts.conversationId ?? CONV, role: 'user', content: opts.message ?? 'Plan dinner', request_id: 'turn-1', created_at: tick() },
      {
        id: 'm2', family_id: FAMILY, conversation_id: opts.conversationId ?? CONV, role: 'assistant', content: ANSWER, request_id: 'turn-1', created_at: tick(),
        structured_content: opts.cutOff ? { version: 1, cards: [], runIds: [], responseError: 'The stream broke.' } : null,
      },
    );
  }

  it('/api/ai/chat: the exchange fails to save after a tool ran; the row is partial and the retry is 409 turn_unsaved with nothing rerun', async () => {
    const { POST } = await import('@/app/api/ai/chat/route');
    state.withTool = true;
    state.messagesFault = true;
    const first = events(await (await POST(sendChat(KEY))).text());
    expect(first.map((e) => e.type)).toEqual(['action', 'delta', 'error', 'done']);
    expect(first.at(-1)).toMatchObject({ persisted: false });
    await vi.waitFor(() => expect(tableOf('ai_requests').find((r) => r.feature === 'chat.assistant')?.status).toBe('partially_completed'));

    state.messagesFault = false;
    const retry = await POST(sendChat(KEY));
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ code: 'turn_unsaved', error: 'ai.thatAnswerWasNotSaved' });
    expect(state.providerCalls).toBe(1);
    expect(state.effects).toBe(1);
    expect(tableOf('ai_requests').filter((r) => r.feature === 'chat.assistant')).toHaveLength(1);
  });

  it('/api/ai/chat: a retry in the window after the exchange is saved and before the row settles replays the answer', async () => {
    const { POST } = await import('@/app/api/ai/chat/route');
    let release!: () => void;
    state.settleGate = new Promise<void>((r) => { release = r; });
    const first = events(await (await POST(sendChat(KEY))).text());
    expect(first.at(-1)).toMatchObject({ type: 'done', persisted: true });
    const row = tableOf('ai_requests').find((r) => r.feature === 'chat.assistant')!;
    expect(row.status).toBe('executing');

    const retry = await POST(sendChat(KEY));
    expect(retry.status).toBe(200);
    const replay = events(await retry.text());
    expect(replay).toEqual([
      { type: 'delta', text: ANSWER },
      { type: 'done', content: ANSWER, persisted: true, requestId: row.id },
    ]);
    expect(state.providerCalls).toBe(1);
    release();
    await vi.waitFor(() => expect(row.status).toBe('completed'));
  });

  it('/api/ai/chat: a cut-off answer retried before its row settles replays as cut off, not as a whole answer', async () => {
    const { POST } = await import('@/app/api/ai/chat/route');
    state.breakStream = true;
    let release!: () => void;
    state.settleGate = new Promise<void>((r) => { release = r; });
    const first = events(await (await POST(sendChat(KEY))).text());
    expect(first.map((e) => e.type)).toEqual(['delta', 'error', 'done']);
    const row = tableOf('ai_requests').find((r) => r.feature === 'chat.assistant')!;
    expect(row.status).toBe('executing');

    const replay = events(await (await POST(sendChat(KEY))).text());
    expect(replay.map((e) => e.type)).toEqual(['delta', 'error', 'done']);
    expect(replay[1]).toMatchObject({ error: 'ai.thatAnswerWasCutOff' });
    expect(state.providerCalls).toBe(1);
    release();
    await vi.waitFor(() => expect(row.status).toBe('partially_completed'));
  });

  it('/api/ai stream: the same window replays the cut-off answer as cut off', async () => {
    const { POST } = await import('@/app/api/ai/route');
    state.breakStream = true;
    let release!: () => void;
    state.settleGate = new Promise<void>((r) => { release = r; });
    const first = events(await (await POST(send({ key: KEY, json: false }))).text());
    expect(first.map((e) => e.type)).toEqual(['delta', 'error', 'done']);
    const replay = events(await (await POST(send({ key: KEY, json: false }))).text());
    expect(replay.map((e) => e.type)).toEqual(['delta', 'error', 'done']);
    expect(state.providerCalls).toBe(1);
    release();
  });

  it.each(['executing', 'queued'])('%s with its exchange saved (the process died before settling): replayed, no model', async (status) => {
    const { POST } = await import('@/app/api/ai/route');
    seed(9);
    turnRow(status, 'assistant.turn');
    savedPair();
    const res = await POST(send({ key: KEY }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ content: ANSWER, replayed: true, requestId: 'turn-1' });
    expect(state.providerCalls).toBe(0);
    expect(tableOf('ai_requests')).toHaveLength(10);
  });

  it('an unsettled turn whose saved answer was cut off replays as cut off', async () => {
    const { POST } = await import('@/app/api/ai/chat/route');
    turnRow('executing');
    savedPair({ cutOff: true });
    const replay = events(await (await POST(sendChat(KEY))).text());
    expect(replay.map((e) => e.type)).toEqual(['delta', 'error', 'done']);
    expect(replay[1]).toMatchObject({ error: 'ai.thatAnswerWasCutOff' });
    expect(state.providerCalls).toBe(0);
  });

  it('failed over a saved answer (the stream broke, the fallback answered): replayed, not "did not finish"', async () => {
    const { POST } = await import('@/app/api/ai/chat/route');
    turnRow('failed');
    savedPair();
    const res = await POST(sendChat(KEY));
    expect(res.status).toBe(200);
    expect(events(await res.text()).at(-1)).toMatchObject({ type: 'done', content: ANSWER, requestId: 'turn-1' });
    expect(state.providerCalls).toBe(0);
  });

  it('negative control: unsettled with no saved exchange is still 409 turn_in_progress', async () => {
    const { POST } = await import('@/app/api/ai/chat/route');
    turnRow('executing');
    const res = await POST(sendChat(KEY));
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe('turn_in_progress');
    expect(state.providerCalls).toBe(0);
  });

  it('negative control: an unsettled turn\'s saved exchange for different words is a mismatch, not a replay', async () => {
    const { POST } = await import('@/app/api/ai/chat/route');
    turnRow('executing');
    savedPair({ message: 'Something else entirely' });
    const res = await POST(sendChat(KEY));
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe('client_request_id_conflict');
    expect(state.providerCalls).toBe(0);
  });

  it('negative control: an exchange saved in another conversation does not answer an unsettled turn', async () => {
    const { POST } = await import('@/app/api/ai/chat/route');
    turnRow('executing');
    savedPair({ conversationId: OTHER_CONV });
    const res = await POST(sendChat(KEY));
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe('turn_in_progress');
  });
});
