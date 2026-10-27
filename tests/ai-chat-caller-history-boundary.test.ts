// Actual legacy POST admission over a predicate-enforcing in-memory builder.
// Actor/gates/observation/model are synthetic adapters; no Auth, SDK, provider,
// cache coordinator, Storage, native database or production acceptance.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown, ctx: null as unknown, ownershipError: false,
  forbidden: vi.fn((name: string): never => { throw new Error(`Forbidden boundary: ${name}`); }),
  configured: vi.fn(async () => true), resolve: vi.fn(), generate: vi.fn<(input: unknown) => void>(),
  tools: vi.fn(() => []), wrap: vi.fn(() => []), calendar: vi.fn(async () => ({ data: [], error: null })),
  observed: vi.fn(), used: vi.fn(), failed: vi.fn(),
}));

// Whole mocks, installed before the route graph. No importOriginal of live
// server/Auth/provider modules; unknown transport tables refuse below.
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => h.ctx, getUserContext: () => h.forbidden('Auth reentry') }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.forbidden('service client') }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.forbidden('SDK construction') }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => h.forbidden('SSR construction'), createBrowserClient: () => h.forbidden('browser construction') }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: async () => ({ ok: true }) }));
vi.mock('@/lib/server/ai-access', () => ({
  AI_ASSISTANT_FEATURE_KEY: 'ai-assistant', assertAIAccess: async () => ({ ok: true }),
  accessDeniedResponse: () => h.forbidden('unexpected allowance refusal'),
}));
vi.mock('@/lib/services/scope', () => ({ scopeFromUserContext: (ctx: { active: { familyId: string } }) => ({ db: h.db, familyId: ctx.active.familyId }) }));
vi.mock('@/lib/calendar/occurrences', async importOriginal => ({
  readCalendarOccurrences: h.calendar,
  readCountedRows: (await importOriginal<typeof import('@/lib/calendar/occurrences')>()).readCountedRows,
}));
vi.mock('@/lib/assistant/tools', () => ({ buildAssistantTools: h.tools }));
vi.mock('@/lib/assistant/trust-wrapper', () => ({ wrapToolsWithTrust: h.wrap }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: h.configured,
  describeAIError: () => ({ message: 'Synthetic unexpected model error' }),
  resolveProvider: async () => {
    h.resolve();
    return {
      model: 'synthetic-no-provider',
      async *runToolsStream(input: unknown) { h.generate(input); yield { type: 'delta', text: 'OWN-SYNTHETIC-ANSWER' }; },
      runTools: () => h.forbidden('unexpected fallback'),
    };
  },
}));
vi.mock('@/lib/ai/assistant-engine', () => ({
  SSE_HEADERS: { 'Content-Type': 'text/event-stream' }, ASSISTANT_STOPPED: 'Stopped',
  finalizeAssistantContent: (text: string) => text,
  stoppedAssistantContent: () => h.forbidden('cancellation lane'),
  summarizeToolResult: () => h.forbidden('tool result'),
}));
vi.mock('@/lib/ai/voice-exchange', () => ({ ASSISTANT_TURN_FEATURES: ['assistant.stream', 'assistant.turn', 'chat.assistant'] }));
vi.mock('@/lib/ai/observability', () => ({
  AiRequestDuplicate: class extends Error {}, AiRequestNotFiled: class extends Error {},
  withAiRequest: async (_scope: unknown, _spec: unknown, body: (obs: { requestId: string; used: typeof h.used; failed: typeof h.failed }) => Promise<void>) => {
    h.observed();
    return body({ requestId: '00000000-0000-4000-8000-000000000091', used: h.used, failed: h.failed });
  },
}));

const importFetchGuard = vi.fn(() => h.forbidden('import-time fetch'));
vi.stubGlobal('fetch', importFetchGuard);
const { POST } = await import('@/app/api/ai/chat/route');
const importBoundaryCalls = { fetch: [...importFetchGuard.mock.calls], forbidden: [...h.forbidden.mock.calls] };
const FAMILY = '00000000-0000-4000-8000-000000000001';
const FOREIGN = '00000000-0000-4000-8000-000000000002';
const OWNER = '00000000-0000-4000-8000-000000000011';
const SIBLING = '00000000-0000-4000-8000-000000000012';
const OWN = '00000000-0000-4000-8000-000000000021';
const SIBLING_CONVERSATION = '00000000-0000-4000-8000-000000000022';
const FOREIGN_CONVERSATION = '00000000-0000-4000-8000-000000000023';
const REQUEST = '00000000-0000-4000-8000-000000000031';
const KEY = 'caller-history-key-0001';
const QUESTION = 'Please help with dinner';
type Trace = { table: string; methods: Array<{ name: string; args: unknown[] }> };
let db: InMemorySupabase;
let traces: Trace[];
let fetchGuard: ReturnType<typeof vi.fn>;

function context(userId = OWNER) {
  return { user: { id: userId }, active: {
    familyId: FAMILY, role: userId === OWNER ? 'parent' : 'teen',
    member: { id: userId === OWNER ? 'synthetic-parent-member' : 'synthetic-teen-member' },
    family: { id: FAMILY, name: 'Synthetic household', timezone: 'UTC' },
  } };
}

function instrument(client: InMemorySupabase) {
  const original = client.from.bind(client);
  client.from = ((table: string) => {
    if (!['ai_conversations', 'ai_messages', 'ai_requests', 'family_members', 'chore_assignments', 'meals'].includes(table)) h.forbidden(`table ${table}`);
    const trace: Trace = { table, methods: [] };
    traces.push(trace);
    const target = original(table);
    const proxy = new Proxy(target, {
      get(object, property, receiver) {
        const value: unknown = Reflect.get(object, property, receiver);
        if (typeof value !== 'function') return value;
        if (property === 'then') return value.bind(object);
        return (...args: unknown[]) => {
          trace.methods.push({ name: String(property), args });
          if (table === 'ai_conversations' && property === 'maybeSingle' && h.ownershipError
            && trace.methods.some(m => m.name === 'select' && m.args[0] === 'id')) {
            return Promise.resolve({ data: null, error: { code: '57014', message: 'synthetic ownership read unavailable' } });
          }
          const result: unknown = value.apply(object, args);
          return result === object ? proxy : result;
        };
      },
    });
    return proxy;
  }) as typeof client.from;
}

function request(conversationId: string, key?: string) {
  return new NextRequest('http://127.0.0.1:9/api/ai/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify({ conversationId, message: QUESTION }),
  });
}
const eq = (trace: Trace, column: string, value: unknown) => trace.methods.some(m => m.name === 'eq' && m.args[0] === column && m.args[1] === value);
const ordinaryHistory = () => traces.filter(t => t.table === 'ai_messages' && t.methods.some(m => m.name === 'select') && eq(t, 'conversation_id', OWN));
function noGenerationOrContext() {
  expect(h.resolve).not.toHaveBeenCalled(); expect(h.generate).not.toHaveBeenCalled();
  expect(h.tools).not.toHaveBeenCalled(); expect(h.wrap).not.toHaveBeenCalled();
  expect(h.calendar).not.toHaveBeenCalled(); expect(h.observed).not.toHaveBeenCalled();
  expect(traces.filter(t => ['family_members', 'chore_assignments', 'meals'].includes(t.table))).toEqual([]);
}
function seedReplay() {
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: OWNER,
    feature: 'chat.assistant', conversation_id: OWN, client_request_id: `assistant:${KEY}`, status: 'completed' }]);
  db.seed('ai_messages', [
    { id: 'saved-user', family_id: FAMILY, conversation_id: OWN, request_id: REQUEST, role: 'user', content: QUESTION, created_at: '2026-10-01T01:00:00Z' },
    { id: 'saved-answer', family_id: FAMILY, conversation_id: OWN, request_id: REQUEST, role: 'assistant', content: 'PRIVATE-SAVED-OWN-ANSWER', created_at: '2026-10-01T01:00:01Z' },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks(); h.ownershipError = false; h.configured.mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchGuard = vi.fn(() => h.forbidden('global fetch')); vi.stubGlobal('fetch', fetchGuard);
  db = createInMemorySupabase(); traces = []; instrument(db); h.db = db; h.ctx = context();
  db.seed('ai_conversations', [
    { id: OWN, family_id: FAMILY, user_id: OWNER, title: 'Own' },
    { id: SIBLING_CONVERSATION, family_id: FAMILY, user_id: SIBLING, title: 'Sibling private' },
    // Same user can belong to another household: active-family scoping still matters.
    { id: FOREIGN_CONVERSATION, family_id: FOREIGN, user_id: OWNER, title: 'Other household' },
  ]);
  db.seed('ai_messages', [
    { id: 'own-history', family_id: FAMILY, conversation_id: OWN, role: 'assistant', content: 'OWN-HISTORY-SENTINEL', created_at: '2026-10-01T00:00:00Z' },
    { id: 'sibling-history', family_id: FAMILY, conversation_id: SIBLING_CONVERSATION, role: 'assistant', content: 'SIBLING-HISTORY-SENTINEL', created_at: '2026-10-01T00:00:00Z' },
    { id: 'foreign-history', family_id: FOREIGN, conversation_id: FOREIGN_CONVERSATION, role: 'assistant', content: 'FOREIGN-HISTORY-SENTINEL', created_at: '2026-10-01T00:00:00Z' },
  ]);
});
afterEach(() => { expect(importBoundaryCalls).toEqual({ fetch: [], forbidden: [] }); expect(fetchGuard).not.toHaveBeenCalled(); expect(h.forbidden).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('legacy chat caller-owned conversation and saved history', () => {
  it('admits own history and persists only its synthetic exchange', async () => {
    const hostileBefore = JSON.stringify(db.table('ai_conversations').filter(r => r.id !== OWN));
    const response = await POST(request(OWN));
    expect(response.status).toBe(200); const body = await response.text();
    expect(body).toContain('OWN-SYNTHETIC-ANSWER');
    expect(h.generate).toHaveBeenCalledTimes(1); expect(h.observed).toHaveBeenCalledTimes(1);
    const input = JSON.stringify(h.generate.mock.calls[0][0]);
    expect(input).toContain('OWN-HISTORY-SENTINEL'); expect(input).not.toContain('SIBLING-HISTORY-SENTINEL'); expect(input).not.toContain('FOREIGN-HISTORY-SENTINEL');
    expect(ordinaryHistory()).toHaveLength(1); expect(eq(ordinaryHistory()[0], 'family_id', FAMILY)).toBe(true);
    const added = db.table('ai_messages').filter(r => r.request_id === '00000000-0000-4000-8000-000000000091');
    expect(added.map(r => ({ family: r.family_id, conversation: r.conversation_id, role: r.role }))).toEqual([
      { family: FAMILY, conversation: OWN, role: 'user' }, { family: FAMILY, conversation: OWN, role: 'assistant' },
    ]);
    expect(JSON.stringify(db.table('ai_conversations').filter(r => r.id !== OWN))).toBe(hostileBefore);
  });

  it.each([['same-family sibling', SIBLING_CONVERSATION], ['foreign-family same user', FOREIGN_CONVERSATION]])('refuses %s before any conversation history or generation', async (_label, id) => {
    const conversations = JSON.stringify(db.table('ai_conversations')), messages = JSON.stringify(db.table('ai_messages'));
    const response = await POST(request(id));
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'chat.conversationNotFound' });
    expect(h.configured).toHaveBeenCalledTimes(1); // local configuration probe precedes ownership.
    noGenerationOrContext(); expect(traces.filter(t => t.table === 'ai_messages')).toEqual([]);
    expect(JSON.stringify(db.table('ai_conversations'))).toBe(conversations); expect(JSON.stringify(db.table('ai_messages'))).toBe(messages);
  });

  it('refuses an unreadable ownership check before history or generation', async () => {
    h.ownershipError = true;
    const before = JSON.stringify(db.table('ai_messages'));
    const response = await POST(request(OWN));
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'chat.couldNotOpenThisConversation' });
    noGenerationOrContext(); expect(traces.filter(t => t.table === 'ai_messages')).toEqual([]);
    expect(JSON.stringify(db.table('ai_messages'))).toBe(before);
  });

  it('replays an own saved turn before configuration or ordinary history, without recreating its missing conversation', async () => {
    seedReplay(); db.replace('ai_conversations', db.table('ai_conversations').filter(r => r.id !== OWN));
    const before = JSON.stringify(db.table('ai_messages'));
    const response = await POST(request(OWN, KEY));
    expect(response.status).toBe(200); const text = await response.text();
    expect(text).toContain('PRIVATE-SAVED-OWN-ANSWER'); expect(text).toContain(REQUEST);
    expect(text).not.toContain('SIBLING-HISTORY-SENTINEL'); expect(text).not.toContain('FOREIGN-HISTORY-SENTINEL');
    noGenerationOrContext(); expect(h.configured).not.toHaveBeenCalled(); expect(ordinaryHistory()).toEqual([]);
    const savedReads = traces.filter(t => t.table === 'ai_messages'); expect(savedReads).toHaveLength(1);
    expect(eq(savedReads[0], 'request_id', REQUEST)).toBe(true); expect(eq(savedReads[0], 'family_id', FAMILY)).toBe(true);
    expect(traces.filter(t => t.table === 'ai_conversations')).toEqual([]); expect(JSON.stringify(db.table('ai_messages'))).toBe(before);
  });

  it('refuses a sibling retry key without reading its saved exchange or returning its answer', async () => {
    seedReplay(); h.ctx = context(SIBLING);
    const before = JSON.stringify(db.table('ai_messages'));
    const response = await POST(request(OWN, KEY));
    expect(response.status).toBe(409); const body = await response.json();
    expect(body).toEqual({ error: 'ai.thatRetryDoesNotMatchThisMessage', code: 'client_request_id_conflict' });
    expect(JSON.stringify(body)).not.toContain('PRIVATE-SAVED-OWN-ANSWER');
    noGenerationOrContext(); expect(h.configured).not.toHaveBeenCalled();
    expect(traces.filter(t => t.table === 'ai_messages' || t.table === 'ai_conversations')).toEqual([]);
    expect(JSON.stringify(db.table('ai_messages'))).toBe(before);
    const metadata = traces.filter(t => t.table === 'ai_requests'); expect(metadata).toHaveLength(1);
    expect(eq(metadata[0], 'family_id', FAMILY)).toBe(true); expect(eq(metadata[0], 'client_request_id', `assistant:${KEY}`)).toBe(true);
  });
});
