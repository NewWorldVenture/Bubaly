import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIProvider, type ToolSpec, type StreamEvent } from '@/lib/ai/provider';

// Build a fake streaming Response whose body yields the given SSE chunks.
function sseResponse(chunks: string[]) {
  let i = 0;
  const enc = new TextEncoder();
  return Promise.resolve({
    ok: true,
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined }) }) },
  } as unknown as Response);
}

async function collect(gen: AsyncGenerator<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

afterEach(() => vi.restoreAllMocks());

describe('OpenAIProvider.runToolsStream', () => {
  it('streams content deltas when no tool is called', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(sseResponse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ])));
    const provider = new OpenAIProvider('gpt-4o', 'test-key');
    const events = await collect(provider.runToolsStream({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }));
    const text = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('Hello world');
    expect(events.some((e) => e.type === 'action')).toBe(false);
  });

  it('accumulates streamed tool_call fragments, executes, then streams the reply', async () => {
    const fetchMock = vi.fn()
      // Round 1: a tool call streamed in argument fragments
      .mockReturnValueOnce(sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"add_note","arguments":"{\\"bo"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"dy\\":\\"hi\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]))
      // Round 2: final natural-language answer
      .mockReturnValueOnce(sseResponse([
        'data: {"choices":[{"delta":{"content":"Saved it."}}]}\n\n',
        'data: [DONE]\n\n',
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const got: Record<string, unknown>[] = [];
    const tools: ToolSpec[] = [{
      name: 'add_note', description: 'x', input_schema: { type: 'object' },
      execute: async (args) => { got.push(args); return { ok: true, summary: 'Saved a note.' }; },
    }];
    const provider = new OpenAIProvider('gpt-4o', 'test-key');
    const events = await collect(provider.runToolsStream({ system: 's', messages: [{ role: 'user', content: 'note hi' }], tools }));

    expect(got).toEqual([{ body: 'hi' }]); // fragments reassembled + parsed
    const action = events.find((e) => e.type === 'action') as { result: unknown } | undefined;
    expect(action?.result).toEqual({ ok: true, summary: 'Saved a note.' });
    const text = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('Saved it.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ─── The engine's card / run / approval events (§53) ─────────────────────────
//
// `createAssistantStream` is driven with a hand-built prepared turn and a fake
// provider, so this pins the wire contract in `lib/ai/result-cards.ts`
// without a household context or a model: an `action` is followed by its
// `card`, a run id becomes a `run` event, a gated result becomes an approval
// card read back from the family's own row, and the turn persists the same
// cards as `structured_content`.
import type { AIProvider } from '@/lib/ai/provider';
import type { ContextBundle } from '@/lib/ai/context/builder';
import { createAssistantStream, runAssistantTurn, type AssistantTurnInput, type PreparedAssistantTurn } from '@/lib/ai/assistant-engine';

type Row = Record<string, unknown>;

function fakeDb(opts: { approval?: Row | null; approvalError?: unknown } = {}) {
  const inserts: { table: string; rows: Row[] }[] = [];
  const reads: { table: string; filters: [string, unknown][] }[] = [];
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => { filters.push([col, val]); return chain; },
      order: () => chain,
      limit: () => chain,
      insert: (rows: Row[]) => { inserts.push({ table, rows }); return Promise.resolve({ error: null }); },
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      maybeSingle: () => {
        reads.push({ table, filters });
        if (table === 'approval_requests') return Promise.resolve({ data: opts.approvalError ? null : opts.approval ?? null, error: opts.approvalError ?? null });
        return Promise.resolve({ data: { title: 'Weekend plans' }, error: null });
      },
    };
    return chain;
  };
  return { db: { from } as never, inserts, reads };
}

function prepared(events: StreamEvent[]): PreparedAssistantTurn {
  const provider = {
    model: 'test-model',
    async *runToolsStream() { for (const e of events) yield e; },
    async runTools() { return { text: '', actions: [] }; },
  } as unknown as AIProvider;
  return {
    system: 's', messages: [], tools: [], provider,
    intent: { intent: 'plan_meals', confidence: 1, entities: {}, source: 'fast_path' },
    context: { header: { currency: 'USD' } } as unknown as ContextBundle,
    cardContext: { members: { m1: 'Sam' }, currency: 'USD' },
    // The stream opens an `ai_requests` row through this scope. Its `db` is the
    // same stub the rest of the turn uses, which has no `insert().select()`
    // chain — so the row fails to open, `withAiRequest` logs and carries on with
    // a null request id, and every assertion below is about the SSE wire exactly
    // as before. That is the wrapper's central promise (bookkeeping never fails
    // the family's work) being exercised rather than mocked away.
    scope: {
      db: undefined as never, familyId: 'fam-1', userId: 'user-1', memberId: 'm1',
      role: 'parent', actorKind: 'ai', tz: 'America/Chicago',
    },
  };
}

async function readSse(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value); }
  return text.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')) as Record<string, unknown>);
}

const input = (db: never): AssistantTurnInput => ({
  supabase: db, familyId: 'fam-1', userId: 'user-1', role: 'parent', familyName: 'The Hughens', tz: 'America/New_York',
  conversationId: '11111111-1111-4111-8111-111111111111', message: 'Plan dinners',
});

const PLAN_RESULT = {
  ok: true, summary: 'Planned 2 dinners',
  data: { planned: [{ id: 's1', date: '2026-09-07', meal_type: 'dinner', meal_id: null, name: 'Tacos' }, { id: 's2', date: '2026-09-08', meal_type: 'dinner', meal_id: null, name: 'Pasta' }], replaced: 0, created_meals: 1 },
};

describe('createAssistantStream card / run / approval events', () => {
  it('follows an action with its card, keeps plain actions card-less, and persists the cards', async () => {
    const { db, inserts } = fakeDb();
    const stream = createAssistantStream(input(db), prepared([
      { type: 'action', name: 'meals_planWeek', args: { entries: [] }, result: PLAN_RESULT },
      { type: 'action', name: 'add_grocery_item', args: { name: 'Milk' }, result: { ok: true, summary: 'Added milk.' } },
      { type: 'delta', text: 'Dinners are planned.' },
    ]));
    const events = await readSse(stream);
    expect(events.map((e) => e.type)).toEqual(['action', 'card', 'action', 'delta', 'done']);
    expect(events[0]).toEqual({ type: 'action', name: 'meals_planWeek', ok: true, summary: 'Planned 2 dinners' });
    expect(events[1]).toMatchObject({ type: 'card', card: { kind: 'meal_plan', title: 'Planned 2 dinners' } });
    expect((events[1].card as { days: unknown[] }).days).toHaveLength(2);
    expect(events[4]).toEqual({ type: 'done', content: 'Dinners are planned.', persisted: true });

    expect(inserts).toHaveLength(1);
    const assistantRow = inserts[0].rows[1];
    expect(assistantRow).toMatchObject({ role: 'assistant', model: 'test-model' });
    expect(assistantRow.structured_content).toMatchObject({ version: 1, runIds: [], cards: [{ kind: 'meal_plan' }] });
    // The user row carries no structured content — it is the assistant's outcome, not the ask.
    expect(inserts[0].rows[0].structured_content).toBeUndefined();
  });

  it('emits a run event (with the run page link) when a tool result points at a run', async () => {
    const { db, inserts } = fakeDb();
    const events = await readSse(createAssistantStream(input(db), prepared([
      { type: 'action', name: 'some_workflow', args: {}, result: { ok: true, summary: 'Bubaly is on it.', run_id: 'run-9', data: { state: 'executing' } } },
    ])));
    expect(events.map((e) => e.type)).toEqual(['action', 'run', 'done']);
    expect(events[1]).toEqual({ type: 'run', runId: 'run-9', href: '/dashboard/concierge/runs/run-9', status: 'executing', summary: 'Bubaly is on it.' });
    expect(inserts[0].rows[1].structured_content).toEqual({ version: 1, cards: [], runIds: ['run-9'] });
  });

  it('reads a gated result back as an approval card, family-scoped, with edit rights for a manager', async () => {
    const approval: Row = {
      id: 'ap-1', family_id: 'fam-1', domain: 'calendar', capability: 'create', requested_by_kind: 'ai', requested_by_member_id: null, agent: 'assistant',
      title: 'Add soccer at 9:00 AM Saturday', summary: 'Bubaly wants to add an event', payload: { name: 'calendar.createEvent', args: { title: 'Soccer', starts_at: '2026-09-12T13:00:00Z' } },
      payload_kind: 'tool', amount_cents: null, confidence: 0.9, reasoning: 'model chain', required_approvals: 1, approvals: [], status: 'pending', priority: 'normal',
      created_at: '2026-09-05T10:00:00Z', expires_at: '2026-09-07T10:00:00Z', run_id: null, plan_step_id: null, plan_step_ids: null,
      consequences: ['Adds soccer to the family calendar'], edited_payload: null,
    };
    const { db, reads } = fakeDb({ approval });
    const events = await readSse(createAssistantStream(input(db), prepared([
      { type: 'action', name: 'create_calendar_event', args: { title: 'Soccer' }, result: { ok: true, summary: 'Waiting for a parent to approve.', pending_approval: true, approval_id: 'ap-1' } },
    ])));
    expect(events.map((e) => e.type)).toEqual(['action', 'card', 'done']);
    const card = events[1].card as { kind: string; approval: Record<string, unknown> };
    expect(card.kind).toBe('approval');
    expect(card.approval).toMatchObject({ id: 'ap-1', title: 'Add soccer at 9:00 AM Saturday', requestedBy: 'Bubaly', consequences: ['Adds soccer to the family calendar'], canEdit: true });
    // The model's reasoning never reaches the card.
    expect(JSON.stringify(card)).not.toContain('model chain');
    expect(reads.find((r) => r.table === 'approval_requests')?.filters).toEqual([['id', 'ap-1'], ['family_id', 'fam-1']]);
  });

  it('degrades a failed approval read to the action line only, and logs it', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = fakeDb({ approvalError: { message: 'boom' } });
    const events = await readSse(createAssistantStream(input(db), prepared([
      { type: 'action', name: 'create_calendar_event', args: {}, result: { ok: true, summary: 'Waiting.', pending_approval: true, approval_id: 'ap-1' } },
    ])));
    expect(events.map((e) => e.type)).toEqual(['action', 'done']);
    expect(errorSpy).toHaveBeenCalledWith('[assistant-engine] approval card read failed', { message: 'boom' });
  });

  it('returns the same cards on the JSON transport', async () => {
    const { db } = fakeDb();
    const turn = prepared([]);
    (turn.provider as { runTools: unknown }).runTools = async () => ({ text: 'Planned.', actions: [{ name: 'meals.planWeek', args: {}, result: PLAN_RESULT }, { name: 'x', args: {}, result: { ok: true, summary: 'Started', run_id: 'run-1' } }] });
    const result = await runAssistantTurn(input(db), turn);
    expect(result.content).toBe('Planned.');
    expect(result.cards.map((c) => c.kind)).toEqual(['meal_plan']);
    expect(result.runIds).toEqual(['run-1']);
    expect(result.actions.map((a) => a.summary)).toEqual(['Planned 2 dinners', 'Started']);
  });
});
