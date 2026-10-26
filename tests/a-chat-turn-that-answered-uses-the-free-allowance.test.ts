// household-roles round 10 (R9-RV3-FREE-ALLOWANCE-NOW-SKIPS-REAL-CHAT-USES):
// a chat turn that did the family's work uses up one of the Free plan's ten.
//
// Round 9 stopped counting a failed request toward the Free allowance unless
// it recorded model usage (lib/server/ai-access.ts, CALLS_THAT_DID_WORK:
// `status.neq.failed,prompt_tokens.gt.0`), because ten calls that failed in an
// outage had cost a family its month. The chat route reported no usage at all
// (`obs.used(provider.model, undefined)`), and a turn whose stream breaks
// before any text and whose non-streaming fallback then answers in full is
// settled 'failed' with the stream's error, by the route's own policy (which
// tests/assistant-cancellation-dispatch-boundary.test.ts pins). So a Free
// family whose streaming path always broke (a proxy that buffers SSE, the
// route's own example) chatted without limit.
//
// The route now records what the fallback reports it cost. The predicate
// stays: `model` is no marker of work, since voice/speak, voice/transcribe,
// lib/chores/ai.ts and the assistant engine's double failure all report the
// model before (or on) a provider failure. (The other case
// the review named, a stream that breaks after a tool ran and before any
// text, is closed by the provider itself: runToolsStream never throws once a
// tool has executed, it writes a closing summary, so the turn settles
// 'completed' and counts. A control below pins that.) Driven through the real
// POST /api/ai/chat, the real OpenAI
// provider over a stubbed fetch (no network), the real allowance gate
// (assertAIAccess) and the real request recorder, on the in-memory database
// with no count_family_ai_requests_month: the direct count 0493's absence
// selects.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider, type ToolSpec } from '@/lib/ai/provider';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = '00000000-0000-4000-8000-0000000c8801';
const PARENT_USER = '00000000-0000-4000-8000-0000000c8811';
const PARENT = '00000000-0000-4000-8000-0000000c8821';
const CONVERSATION = '00000000-0000-4000-8000-0000000c8831';
const NOW = new Date('2026-10-14T15:00:00Z');

const h = vi.hoisted(() => ({ db: null as unknown, tools: [] as unknown[], provider: null as unknown }));
const ctx = () => ({
  user: { id: PARENT_USER, email: 'dana@example.test' },
  memberships: [],
  active: {
    familyId: FAMILY, role: 'parent',
    member: { id: PARENT, display_name: 'Dana' },
    family: { id: FAMILY, name: 'The Riveras', timezone: 'UTC' },
  },
});
vi.mock('@/lib/i18n/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/i18n/server')>()),
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/auth')>()),
  requireUserContext: async () => ctx(),
  isSuperAdmin: async () => false,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => true,
  resolveProvider: async () => h.provider,
}));
// The durable per-minute limit has its own tests; the in-process one is real.
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: async () => ({ ok: true }) }));
// The tool registry and its trust wrapper have their own tests: one tool here.
vi.mock('@/lib/assistant/tools', () => ({ buildAssistantTools: () => h.tools }));
vi.mock('@/lib/assistant/trust-wrapper', () => ({ wrapToolsWithTrust: (tools: unknown[]) => tools }));

const { POST } = await import('@/app/api/ai/chat/route');

let db: InMemorySupabase;
const fetches = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const saved: string[] = [];
const tool: ToolSpec = {
  name: 'add_note', description: 'Save a note', input_schema: { type: 'object' },
  execute: async (args) => { saved.push(String(args.body)); return { ok: true, summary: `Saved ${String(args.body)}.` }; },
};
/** The non-streaming completion, with the usage OpenAI reports on every one. */
const answered = (content: string) => Response.json({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 812, completion_tokens: 24, total_tokens: 836 },
});
/** A streamed round that asks for one tool call, with no usage chunk. */
const streamedToolCall = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
  index: 0, id: 'call-0', type: 'function', function: { name: 'add_note', arguments: JSON.stringify({ body: 'milk' }) },
}] } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });

const turn = async () => {
  const res = await POST(new NextRequest('http://localhost/api/ai/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: CONVERSATION, message: 'What is for dinner?' }),
  }));
  return { status: res.status, body: await res.text() };
};
const chatRow = () => db.table('ai_requests').filter((r) => r.feature === 'chat.assistant').at(-1)!;
const settled = async () => { await vi.waitFor(() => expect(chatRow()?.completed_at).toBeTruthy()); return chatRow(); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = createInMemorySupabase();
  h.db = db;
  h.tools = [tool];
  h.provider = new OpenAIProvider('gpt-4o', 'synthetic-no-network-key');
  saved.length = 0;
  fetches.mockReset();
  vi.stubGlobal('fetch', fetches);
  // Free: no paid plan, no trial running.
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'UTC', trial_ends_at: null, closed_at: null }]);
  db.seed('family_members', [{ id: PARENT, family_id: FAMILY, user_id: PARENT_USER, display_name: 'Dana', role: 'parent', is_active: true }]);
  db.seed('ai_conversations', [{ id: CONVERSATION, family_id: FAMILY, user_id: PARENT_USER, title: 'Dinner' }]);
  // Nine settled uses this month: one more closes it.
  db.seed('ai_requests', Array.from({ length: 9 }, (_, i) => ({
    id: `00000000-0000-4000-8000-0000000c8d${String(i).padStart(2, '0')}`, family_id: FAMILY, requested_by: PARENT_USER,
    kind: 'feature', status: 'completed', request_text: 'earlier', created_at: new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString(),
  })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the Free allowance counts a chat turn that did the family\'s work', () => {
  it('a turn whose stream broke and whose fallback answered in full is the tenth use: the next turn is refused', async () => {
    fetches.mockRejectedValueOnce(new Error('synthetic: the proxy buffered the stream'));
    fetches.mockResolvedValueOnce(answered('Tacos, at six.'));

    const first = await turn();
    expect(first.status).toBe(200);
    expect(first.body).toContain('Tacos, at six.');
    const { id } = await settled();

    const next = await turn();
    expect(next.status).toBe(429);
    expect(JSON.parse(next.body)).toMatchObject({ code: 'allowance_exceeded' });
    expect(fetches).toHaveBeenCalledTimes(2);
    // Still the route's record of the broken stream, now with what the fallback cost.
    expect(db.table('ai_requests').find((r) => r.id === id)).toMatchObject({ status: 'failed', prompt_tokens: 812 });
  });

  it('control: a turn whose stream broke after a tool ran, before any text, is closed by the provider and is the tenth use too', async () => {
    fetches.mockResolvedValueOnce(streamedToolCall());
    fetches.mockRejectedValueOnce(new Error('synthetic: the stream dropped'));
    fetches.mockRejectedValueOnce(new Error('synthetic: and the closing summary failed'));

    const first = await turn();
    expect(first.status).toBe(200);
    expect(saved).toEqual(['milk']);
    expect(first.body).toContain('the connection dropped');
    expect((await settled()).status).toBe('completed');

    const next = await turn();
    expect(next.status).toBe(429);
    expect(fetches).toHaveBeenCalledTimes(3);
  });

  it('control: a turn whose stream and fallback both failed did no work and leaves the tenth use open', async () => {
    fetches.mockRejectedValueOnce(new Error('synthetic: the stream failed'));
    fetches.mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 529 }));

    expect((await turn()).status).toBe(200);
    expect(await settled()).toMatchObject({ status: 'failed' });
    expect(chatRow().prompt_tokens ?? 0).toBe(0);

    fetches.mockResolvedValueOnce(streamedToolCall());
    fetches.mockResolvedValueOnce(new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Saved.' } }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } }));
    expect((await turn()).status).toBe(200);
  });
});
