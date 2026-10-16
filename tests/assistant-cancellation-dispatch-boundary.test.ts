import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider, type ToolSpec } from '@/lib/ai/provider';
import {
  createAssistantStream, runAssistantTurn,
  type AssistantTurnInput, type PreparedAssistantTurn,
} from '@/lib/ai/assistant-engine';
import { InMemorySupabase } from './helpers/in-memory-supabase';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { NextRequest } from 'next/server';
import * as providerModule from '@/lib/ai/provider';

// The provider, engine, persistence and observation lifecycle are real. Only
// the fixed provider HTTP host and the database are synthetic; no credential,
// provider request, external message or production database is used.
const ledger = vi.hoisted(() => ({ db: undefined as unknown, tools: [] as unknown[] }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ledger.db, createServer: async () => ledger.db }));
// The legacy route's authentication/entitlement/tool-construction seams are
// injected. Its handler, provider, cancellation, writes and persistence run;
// these cases do not claim Auth/RLS or household-policy verification.
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({
  user: { id: 'user-1' }, active: { familyId: 'family-1', role: 'parent',
    member: { id: 'member-1' }, family: { name: 'Family', timezone: 'UTC' } },
}) }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/ai-access', () => ({ AI_ASSISTANT_FEATURE_KEY: 'assistant', assertAIAccess: async () => ({ ok: true }), accessDeniedResponse: () => { throw new Error('unexpected denial'); } }));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: async () => ({ ok: true }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/assistant/tools', () => ({ buildAssistantTools: () => ledger.tools }));
vi.mock('@/lib/assistant/trust-wrapper', () => ({ wrapToolsWithTrust: (tools: unknown[]) => tools }));

const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const nativeFetch = globalThis.fetch;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function response(stream: boolean, calls: number, identical = false) {
  const toolCalls = Array.from({ length: calls }, (_, index) => ({
    index, id: `call-${index}`, type: 'function',
    function: { name: 'add_note', arguments: JSON.stringify({ body: identical || index === 0 ? 'first' : 'second' }) },
  }));
  if (!stream) return Response.json({ choices: [{ message: calls
    ? { tool_calls: toolCalls }
    : { content: 'Both notes saved.' } }] });
  const delta = calls ? { tool_calls: toolCalls } : { content: 'Both notes saved.' };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function fixture(signal?: AbortSignal) {
  const db = new InMemorySupabase({ userId: 'user-1' });
  ledger.db = db;
  db.seed('ai_conversations', [{ id: CONVERSATION, family_id: 'family-1', user_id: 'user-1', title: 'Notes' }]);
  const supabase = db as unknown as AssistantTurnInput['supabase'];
  // The extra signal property deliberately compiles on the original source:
  // the RED witness must prove runtime propagation, not a missing TS field.
  const input: AssistantTurnInput & { signal?: AbortSignal } = {
    supabase, familyId: 'family-1', userId: 'user-1', role: 'parent', familyName: 'Family',
    tz: 'UTC', conversationId: CONVERSATION, message: 'Save two notes', signal,
  };
  const started: string[] = [];
  let beforeWrite: (() => Promise<void>) | undefined;
  let afterWrite: (() => Promise<void>) | undefined;
  const tool: ToolSpec = {
    name: 'add_note', description: 'Save a note', input_schema: { type: 'object' },
    execute: async (args) => {
      const body = String(args.body);
      started.push(body);
      if (body === 'first') await beforeWrite?.();
      const saved = await db.from('notes').insert({ family_id: 'family-1', body }).select('id').single();
      if (saved.error) throw new Error(saved.error.message);
      if (body === 'first') await afterWrite?.();
      return { ok: true, summary: `Saved ${body}.`, data: saved.data };
    },
  };
  const turn: PreparedAssistantTurn = {
    system: 'Save the requested notes.', messages: [{ role: 'user', content: input.message }],
    tools: [tool], provider: new OpenAIProvider('gpt-4o', 'synthetic-no-network-key'),
    intent: { intent: 'plan_meals', confidence: 1, entities: {}, source: 'fast_path' },
    context: {} as PreparedAssistantTurn['context'], cardContext: { members: {}, currency: 'USD' },
    scope: { db: supabase, familyId: input.familyId, userId: input.userId, memberId: 'member-1', role: 'parent', actorKind: 'ai', tz: 'UTC' },
  };
  ledger.tools = [tool];
  const requests: RequestInit[] = [];
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
    requests.push(init ?? {});
    const body = JSON.parse(String(init?.body));
    return response(body.stream === true, requests.length === 1 ? 2 : 0);
  });
  vi.stubGlobal('fetch', fetch);
  return {
    db, input, turn, started, requests, fetch,
    beforeWrite: (hook: () => Promise<void>) => { beforeWrite = hook; },
    afterWrite: (hook: () => Promise<void>) => { afterWrite = hook; },
  };
}

async function saved(f: ReturnType<typeof fixture>) {
  await vi.waitFor(() => expect(f.db.table('ai_requests')[0]?.completed_at).toBeTruthy());
  expect(f.db.table('ai_messages')).toHaveLength(2);
  return f.db.table('ai_messages')[1];
}

function partial(f: ReturnType<typeof fixture>, message: Record<string, unknown>) {
  expect(f.started).toEqual(['first']);
  expect(f.db.table('notes').map((row) => row.body)).toEqual(['first']);
  expect(message.tool_calls).toEqual([{ name: 'add_note', args: { body: 'first' } }]);
  expect(message.tool_results).toEqual([{ name: 'add_note', ok: true, summary: 'Saved first.' }]);
  expect(JSON.stringify(message.structured_content)).toMatch(/stopp/i);
  expect(message.content).not.toBe('Done — I’ve updated that for you.');
  expect(f.db.table('ai_requests')[0].status).toBe('partially_completed');
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('actual assistant engine/provider cancellation', () => {
  it.each(['SSE', 'JSON'] as const)('healthy %s still executes and records both writes', async (transport) => {
    const f = fixture();
    if (transport === 'SSE') await new Response(createAssistantStream(f.input, f.turn)).text();
    else await runAssistantTurn(f.input, f.turn);
    const message = await saved(f);
    expect(f.started).toEqual(['first', 'second']);
    expect(f.db.table('notes').map((row) => row.body)).toEqual(['first', 'second']);
    expect(message.tool_results).toHaveLength(2);
    expect(message.content).toBe('Both notes saved.');
    expect(f.db.table('ai_requests')[0].status).toBe('completed');
  });

  it.each(['before commit', 'after commit'] as const)('reader cancellation %s retains the started write and prevents the second', async (phase) => {
    const f = fixture();
    const entered = deferred(); const release = deferred();
    const hold = async () => { entered.resolve(); await release.promise; };
    if (phase === 'before commit') f.beforeWrite(hold); else f.afterWrite(hold);
    const reader = createAssistantStream(f.input, f.turn).getReader();
    await entered.promise;
    await reader.cancel();
    release.resolve();
    partial(f, await saved(f));
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.requests[0].signal?.aborted).toBe(true);
  });

  it.each(['SSE', 'JSON'] as const)('request abort during the first %s write preserves its receipt and stops the second', async (transport) => {
    const stop = new AbortController();
    const f = fixture(stop.signal);
    f.afterWrite(async () => { stop.abort(); });
    if (transport === 'SSE') await new Response(createAssistantStream(f.input, f.turn)).text();
    else await runAssistantTurn(f.input, f.turn);
    partial(f, await saved(f));
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['SSE', 'JSON'] as const)('an already aborted %s request starts no model or tool', async (transport) => {
    const stop = new AbortController(); stop.abort();
    const f = fixture(stop.signal);
    if (transport === 'SSE') await new Response(createAssistantStream(f.input, f.turn)).text();
    else await runAssistantTurn(f.input, f.turn);
    const message = await saved(f);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.started).toEqual([]);
    expect(f.db.table('notes')).toEqual([]);
    expect(message.content).toMatch(/stopp/i);
    expect(f.db.table('ai_requests')[0].status).toBe('failed');
  });

  it('does not fall back when the reader cancels before the first provider response fails', async () => {
    const f = fixture();
    const entered = deferred(); const release = deferred();
    f.fetch.mockImplementationOnce(async () => {
      entered.resolve(); await release.promise;
      throw new Error('synthetic stream disconnected');
    });
    const reader = createAssistantStream(f.input, f.turn).getReader();
    await entered.promise; await reader.cancel(); release.resolve();
    const message = await saved(f);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.started).toEqual([]);
    expect(message.content).toMatch(/stopp/i);
    expect(f.db.table('ai_requests')[0].status).toBe('failed');
  });

  it('retains a JSON tool receipt when cancellation interrupts the next provider response', async () => {
    const stop = new AbortController();
    const f = fixture(stop.signal);
    const waiting = deferred();
    f.fetch.mockImplementationOnce(async () => response(false, 1));
    f.fetch.mockImplementationOnce(async (_url, init) => {
      waiting.resolve();
      return new Promise<Response>((_resolve, reject) => {
        // This is the actual signal installed by provider.withDeadline.
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
        // The original engine omits the signal; settle its synthetic HTTP
        // operation too so the RED records the lost-history defect, not a hang.
        stop.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
      });
    });
    const pending = runAssistantTurn(f.input, f.turn);
    await waiting.promise; stop.abort();
    await expect(pending).resolves.toMatchObject({ persisted: true });
    partial(f, await saved(f));
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it('a failed stream may fall back while connected, but cancelling its JSON tool stops further dispatch', async () => {
    const stop = new AbortController();
    const f = fixture(stop.signal);
    f.fetch.mockRejectedValueOnce(new Error('synthetic streaming unavailable'));
    f.afterWrite(async () => { stop.abort(); });
    await new Response(createAssistantStream(f.input, f.turn)).text();
    partial(f, await saved(f));
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it('non-streaming provider dispatch itself checks an abort between two already-returned tool calls', async () => {
    const stop = new AbortController();
    const f = fixture();
    f.afterWrite(async () => { stop.abort(); });
    const result = await f.turn.provider.runTools({ system: 's', messages: [], tools: f.turn.tools, signal: stop.signal });
    expect(f.started).toEqual(['first']);
    expect(f.db.table('notes').map((row) => row.body)).toEqual(['first']);
    expect(result.actions).toHaveLength(1);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('legacy route request cancellation', () => {
  it.each(['already stopped', 'during first write', 'healthy'] as const)('%s reaches the same provider dispatch boundary', async (phase) => {
    const stop = new AbortController();
    const f = fixture();
    vi.spyOn(providerModule, 'isAIConfigured').mockResolvedValue(true);
    vi.spyOn(providerModule, 'resolveProvider').mockResolvedValue(f.turn.provider);
    if (phase === 'already stopped') stop.abort();
    if (phase === 'during first write') f.afterWrite(async () => { stop.abort(); });
    const req = new NextRequest('http://localhost/api/ai/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: stop.signal,
      body: JSON.stringify({ conversationId: CONVERSATION, message: 'Save two notes' }),
    });
    const add = vi.spyOn(req.signal, 'addEventListener');
    const remove = vi.spyOn(req.signal, 'removeEventListener');
    const { POST } = await import('@/app/api/ai/chat/route');
    const reply = await POST(req);
    expect(reply.status).toBe(200);
    await reply.text();
    const message = await saved(f);
    for (const [event, listener] of add.mock.calls) {
      if (event === 'abort') expect(remove).toHaveBeenCalledWith('abort', listener);
    }
    if (phase === 'during first write') {
      partial(f, message);
      expect(f.fetch).toHaveBeenCalledTimes(1);
    } else if (phase === 'already stopped') {
      expect(f.started).toEqual([]);
      expect(f.fetch).not.toHaveBeenCalled();
      expect(message.content).toMatch(/stopp/i);
      expect(f.db.table('ai_requests')[0].status).toBe('failed');
    } else {
      expect(f.started).toEqual(['first', 'second']);
      expect(f.db.table('ai_requests')[0].status).toBe('completed');
    }
  });

  it('a cancelled fallback records its saved first write as partial, not the earlier stream error', async () => {
    const stop = new AbortController();
    const f = fixture();
    vi.spyOn(providerModule, 'isAIConfigured').mockResolvedValue(true);
    vi.spyOn(providerModule, 'resolveProvider').mockResolvedValue(f.turn.provider);
    f.fetch.mockRejectedValueOnce(new Error('synthetic streaming unavailable'));
    f.afterWrite(async () => { stop.abort(); });
    const { POST } = await import('@/app/api/ai/chat/route');
    const reply = await POST(new NextRequest('http://localhost/api/ai/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: stop.signal,
      body: JSON.stringify({ conversationId: CONVERSATION, message: 'Save two notes' }),
    }));
    expect(reply.status).toBe(200); await reply.text();
    partial(f, await saved(f));
    expect(f.db.table('ai_requests')[0].error).toMatch(/stopp/i);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('fallback receipts are executions, not unique argument values', () => {
  it.each([
    ['engine', true], ['legacy', true], ['engine', false], ['legacy', false],
  ] as const)('%s retains both identical calls (cancelled: %s)', async (surface, cancelled) => {
    const stop = new AbortController();
    const f = fixture(stop.signal);
    // Different provider call IDs, the same arguments: two requested writes.
    f.fetch.mockRejectedValueOnce(new Error('synthetic streaming unavailable'));
    f.fetch.mockImplementationOnce(async () => response(false, 2, true));
    f.fetch.mockImplementationOnce(async () => response(false, 0));
    f.afterWrite(async () => { if (cancelled && f.started.length === 2) stop.abort(); });
    if (surface === 'engine') {
      await new Response(createAssistantStream(f.input, f.turn)).text();
    } else {
      vi.spyOn(providerModule, 'isAIConfigured').mockResolvedValue(true);
      vi.spyOn(providerModule, 'resolveProvider').mockResolvedValue(f.turn.provider);
      const { POST } = await import('@/app/api/ai/chat/route');
      const reply = await POST(new NextRequest('http://localhost/api/ai/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: stop.signal,
        body: JSON.stringify({ conversationId: CONVERSATION, message: 'Save the same note twice' }),
      }));
      expect(reply.status).toBe(200); await reply.text();
    }
    const message = await saved(f);
    expect(f.started).toEqual(['first', 'first']);
    expect(f.db.table('notes').map((row) => row.body)).toEqual(['first', 'first']);
    expect(new Set(f.db.table('notes').map((row) => row.id)).size).toBe(2);
    expect(message.tool_calls).toEqual(Array.from({ length: 2 }, () => ({ name: 'add_note', args: { body: 'first' } })));
    expect(message.tool_results).toEqual(Array.from({ length: 2 }, () => ({ name: 'add_note', ok: true, summary: 'Saved first.' })));
    expect(f.fetch).toHaveBeenCalledTimes(cancelled ? 2 : 3);
    if (cancelled) {
      expect(f.db.table('ai_requests')[0].status).toBe('partially_completed');
      expect(f.db.table('ai_requests')[0].error).toMatch(/stopp/i);
      expect(message.content).toMatch(/stopp/i);
    } else {
      expect(message.content).toBe('Both notes saved.');
      // Preserve the legacy surface's first-stream-error observation policy.
      expect(f.db.table('ai_requests')[0].status).toBe(surface === 'legacy' ? 'failed' : 'completed');
    }
  });
});

describe('native fetch cancellation against an owned loopback provider', () => {
  it.each(['before headers', 'during body'] as const)('cancels %s without dispatch or retry and closes the owned socket', async (phase) => {
    const stop = new AbortController();
    const f = fixture(stop.signal);
    const received = deferred(); const closed = deferred();
    let count = 0;
    const server = createServer((request, reply) => {
      count++;
      request.resume();
      reply.on('close', closed.resolve);
      if (phase === 'during body') {
        reply.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // An incomplete function call never becomes an executable operation.
        reply.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-0","function":{"name":"add_note","arguments":"{\\"body\\":"}}]}}]}\n\n');
      }
      received.resolve();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing owned loopback address');
    f.fetch.mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
      return nativeFetch(`http://127.0.0.1:${address.port}/completion`, {
        ...init, headers: { 'Content-Type': 'application/json' },
      });
    });
    const pending = new Response(createAssistantStream(f.input, f.turn)).text();
    try {
      await received.promise;
      stop.abort();
      await vi.waitFor(() => expect(f.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true), { timeout: 500 });
      await pending;
      await closed.promise;
      const message = await saved(f);
      expect(f.started).toEqual([]);
      expect(f.db.table('notes')).toEqual([]);
      expect(count).toBe(1);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(message.content).toMatch(/stopp/i);
      expect(f.db.table('ai_requests')[0].status).toBe('failed');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await pending.catch(() => {});
      expect(server.listening).toBe(false);
    }
  });
});
