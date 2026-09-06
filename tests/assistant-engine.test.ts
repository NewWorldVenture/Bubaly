import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent, ToolRunResult } from '@/lib/ai/provider';

type Row = Record<string, unknown>;
const tables: Record<string, { rows?: Row[]; error?: unknown; single?: Row | null }> = {};
const inserts: { table: string; rows: unknown }[] = [];
const updates: { table: string; patch: unknown }[] = [];

function chain(table: string) {
  const t = tables[table] ?? {};
  const c: Record<string, unknown> = {
    // The context builder (lib/ai/context) reads through the domain services,
    // which use the full filter vocabulary — every filter is a no-op here and
    // the table's fixture decides what comes back.
    select: () => c, eq: () => c, neq: () => c, in: () => c, is: () => c, not: () => c, or: () => c, ilike: () => c,
    gte: () => c, gt: () => c, lte: () => c, lt: () => c, order: () => c, limit: () => c, range: () => c,
    insert: (rows: unknown) => { inserts.push({ table, rows }); return { then: (onF: (v: { error: unknown }) => unknown) => Promise.resolve({ error: t.error ?? null }).then(onF) }; },
    update: (patch: unknown) => { updates.push({ table, patch }); return { eq: () => Promise.resolve({ error: null }) }; },
    maybeSingle: () => Promise.resolve({ data: t.error ? null : (t.single ?? null), error: t.error ?? null }),
    single: () => Promise.resolve({ data: t.error ? null : (t.single ?? null), error: t.error ?? null }),
    then: (onF: (v: { data: Row[] | null; error: unknown }) => unknown) => Promise.resolve({ data: t.error ? null : (t.rows ?? []), error: t.error ?? null }).then(onF),
  };
  return c;
}
const supabase = { from: (table: string) => chain(table) } as never;

const provider = {
  model: 'test-model',
  runTools: vi.fn<() => Promise<ToolRunResult>>(),
  runToolsStream: vi.fn<() => AsyncGenerator<StreamEvent>>(),
};
vi.mock('@/lib/ai/provider', () => ({
  resolveProvider: async () => provider,
  describeAIError: (e: unknown) => ({ code: 'x', message: e instanceof Error ? e.message : String(e), detail: '' }),
}));

const wrapSpy = vi.fn();
vi.mock('@/lib/assistant/trust-wrapper', () => ({
  wrapToolsWithTrust: (tools: unknown[], _db: unknown, familyId: string, role: unknown) => { wrapSpy(familyId, role); return tools; },
}));
vi.mock('@/lib/assistant/tools', () => ({
  buildAssistantTools: () => [
    { name: 'add_chore', description: 'rich chore', input_schema: { type: 'object' }, execute: async () => ({ ok: true }) },
    { name: 'create_calendar_event', description: 'rich event', input_schema: { type: 'object' }, execute: async () => ({ ok: true }) },
  ],
}));
const runAction = vi.fn();
vi.mock('@/lib/ai/actions', () => ({
  AI_TOOLS: [
    { name: 'create_calendar_event', description: 'simple event', input_schema: { type: 'object' } },
    { name: 'create_meal_plan_entry', description: 'Plan a meal on a given date.', input_schema: { type: 'object' } },
  ],
  runAction: (...args: unknown[]) => runAction(...args),
}));

import {
  buildAssistantSystemPrompt, createAssistantStream, finalizeAssistantContent, persistAssistantTurn,
  prepareAssistantTurn, runAssistantTurn, summarizeToolResult, type AssistantTurnInput,
} from '@/lib/ai/assistant-engine';

const input: AssistantTurnInput = {
  supabase, familyId: 'fam-1', userId: 'user-1', role: 'parent', familyName: 'The Hughens', tz: 'America/New_York',
  conversationId: '11111111-1111-4111-8111-111111111111', message: 'Plan tacos for Saturday',
};

async function readSse(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value); }
  return text.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  inserts.length = 0; updates.length = 0;
  tables.ai_messages = { rows: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] };
  // The context builder fails closed on the family header, so the fake must
  // serve `families` (name + zone) and a roster row that belongs to the caller.
  tables.families = { single: { id: 'fam-1', name: 'The Hughens', timezone: 'America/New_York' } };
  tables.family_members = { rows: [{ id: 'm1', user_id: 'user-1', display_name: 'Dan', role: 'parent', is_active: true }] };
  tables.calendar_events = { rows: [{ title: 'Soccer', starts_at: '2026-09-06T14:00:00Z', category: 'sports' }] };
  tables.chore_assignments = { rows: [{ status: 'todo' }, { status: 'in_progress' }] };
  tables.meals = { rows: [{ name: 'Tacos', meal_type: 'dinner' }] };
  tables.ai_conversations = { single: { title: 'New conversation' } };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('prepareAssistantTurn', () => {
  it('merges the assistant toolbox with lib/ai/actions.ts tools (toolbox wins on collisions) behind the trust wrapper', async () => {
    const prepared = await prepareAssistantTurn(input);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const names = prepared.turn.tools.map((t) => t.name);
    // The toolbox is three sets now, not two: the assistant toolbox, the
    // lib/ai/actions.ts bridge, and the rest of the lib/ai/tools registry, which
    // the engine started offering so the ~20 tools the registry added over the
    // old toolbox are reachable from chat instead of only from the run executor.
    //
    // The legacy-named tools still come first, in the same precedence order, and
    // `create_calendar_event` still resolves to the toolbox's richer version.
    expect(names.slice(0, 3)).toEqual(['add_chore', 'create_calendar_event', 'create_meal_plan_entry']);
    expect(prepared.turn.tools.find((t) => t.name === 'create_calendar_event')?.description).toBe('rich event');
    // Everything after them is the registry, under its underscored canonical
    // spelling. A capability the first two sets already cover is excluded rather
    // than merged, because the two spellings are different strings that
    // `mergeToolSets` cannot see as one tool — so the registry knows `add_chore`
    // as `tasks.createChore` and `create_calendar_event` as
    // `calendar.createEvent`, and offers neither a second time.
    expect(names).toContain('calendar_updateEvent');
    expect(names).toContain('tasks_assignTodo');
    expect(names).toContain('groceries_checkItem');
    expect(names).not.toContain('calendar_createEvent');
    expect(names).not.toContain('tasks_createChore');
    expect(new Set(names).size).toBe(names.length);
    expect(wrapSpy).toHaveBeenCalledWith('fam-1', 'parent');
    expect(prepared.turn.messages).toEqual([
      { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'Plan tacos for Saturday' },
    ]);
    expect(prepared.turn.system).toContain('Family: The Hughens');
    // The system prompt is now the context builder's rendering (lib/ai/context),
    // chosen by intent: "Plan tacos for Saturday" is a capture, which carries the
    // roster, schedule, tasks and shopping slices, and every row-derived string
    // is fenced as untrusted. The old flat "Open chores: N" / "meal plan" lines
    // are gone by design; the same facts appear in the tasks section, and the
    // event title from the fixture must be fenced rather than pasted raw.
    expect(prepared.turn.system).toContain('0 open to-dos, 2 open chores');
    expect(prepared.turn.system).toMatch(/<<<UNTRUSTED_EVENT_TITLE_[A-Za-z0-9_-]+>>>Soccer<<<END_EVENT_TITLE_/);
    expect(prepared.turn.system).toContain('Asking: Dan (parent).');
    expect(prepared.turn.provider).toBe(provider);

    runAction.mockResolvedValueOnce({ ok: true, summary: 'Planned "Tacos" for 2026-09-06.' });
    const meal = prepared.turn.tools.find((t) => t.name === 'create_meal_plan_entry')!;
    await meal.execute({ meal_name: 'Tacos', plan_date: '2026-09-06' });
    expect(runAction).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: 'fam-1', userId: 'user-1' }),
      { name: 'create_meal_plan_entry', args: { meal_name: 'Tacos', plan_date: '2026-09-06' } },
    );
  });

  it('fails closed when any context read errors', async () => {
    tables.calendar_events = { error: { message: 'boom' } };
    const prepared = await prepareAssistantTurn(input);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error).toBeTruthy();
  });
});

describe('runAssistantTurn (JSON transport)', () => {
  it('runs the tool loop, persists both turns, and summarizes actions', async () => {
    provider.runTools.mockResolvedValueOnce({ text: '', actions: [
      { name: 'create_meal_plan_entry', args: { meal_name: 'Tacos' }, result: { ok: true, summary: 'Planned "Tacos".' } },
      { name: 'add_chore', args: { title: 'Dishes' }, result: { ok: false, error: 'Could not create the chore.' } },
    ] });
    const prepared = await prepareAssistantTurn(input);
    if (!prepared.ok) throw new Error('prepare failed');
    const result = await runAssistantTurn(input, prepared.turn);
    // This fixture is one success and one FAILURE, and the assertion here used
    // to be 'Done — I’ve updated that for you.' — the bug, pinned by its own
    // test. The chore was not created and the family was told it was. The
    // action chips were right all along; only the sign-off lied.
    expect(result.content).toBe('I’ve done part of that. Could not create the chore.');
    expect(result.actions).toEqual([
      { name: 'create_meal_plan_entry', ok: true, summary: 'Planned "Tacos".' },
      { name: 'add_chore', ok: false, summary: 'Could not create the chore.' },
    ]);
    expect(result.persisted).toBe(true);
    expect(result.model).toBe('test-model');
    // Addressed by table, not by position: the turn now also asks for an
    // `ai_requests` row, so `inserts[0]` is no longer a stable way to name the
    // message write.
    const messageInsert = inserts.find((i) => i.table === 'ai_messages');
    expect(messageInsert, 'the turn must persist its messages').toBeTruthy();
    // The request row is attributed to the PERSON who typed the message, even
    // though the scope's actorKind is 'ai' for the tool writes. `createRequest`
    // reads only familyId/userId/memberId from the scope, and this pins that.
    // (This stub's `insert` has no `.select().single()`, so the row never
    // actually opens — `withAiRequest` logs and continues with a null request
    // id. What is asserted here is the payload the engine asked for.)
    const requestInsert = inserts.find((i) => i.table === 'ai_requests');
    expect(requestInsert, 'the turn must open a request row').toBeTruthy();
    expect(requestInsert!.rows).toMatchObject({
      family_id: input.familyId,
      requested_by: input.userId,
      conversation_id: input.conversationId,
      feature: 'assistant.turn',
      request_text: 'Plan tacos for Saturday',
    });
    const rows = messageInsert!.rows as Row[];
    expect(rows[0]).toMatchObject({ role: 'user', content: 'Plan tacos for Saturday', conversation_id: input.conversationId });
    expect(rows[1]).toMatchObject({ role: 'assistant', content: 'I’ve done part of that. Could not create the chore.' });
    expect((rows[1].tool_calls as unknown[]).length).toBe(2);
    expect(updates[0].patch).toEqual({ model: 'test-model', title: 'Plan tacos for Saturday' });
  });

  it('reports a persistence failure without losing the answer', async () => {
    provider.runTools.mockResolvedValueOnce({ text: 'Sure thing.', actions: [] });
    const prepared = await prepareAssistantTurn(input);
    if (!prepared.ok) throw new Error('prepare failed');
    // History was already read; make the insert fail.
    tables.ai_messages = { error: { message: 'insert failed' } };
    const result = await runAssistantTurn(input, prepared.turn);
    expect(result.content).toBe('Sure thing.');
    expect(result.persisted).toBe(false);
    expect(result.persistenceError).toBeTruthy();
  });
});

describe('createAssistantStream (SSE transport)', () => {
  it('emits action → delta → done and persists', async () => {
    provider.runToolsStream.mockImplementationOnce(async function* () {
      yield { type: 'action', name: 'create_meal_plan_entry', args: {}, result: { ok: true, summary: 'Planned.' } };
      yield { type: 'delta', text: 'Tacos ' };
      yield { type: 'delta', text: 'are planned.' };
    });
    const prepared = await prepareAssistantTurn(input);
    if (!prepared.ok) throw new Error('prepare failed');
    const events = await readSse(createAssistantStream(input, prepared.turn));
    expect(events).toEqual([
      { type: 'action', name: 'create_meal_plan_entry', ok: true, summary: 'Planned.' },
      { type: 'delta', text: 'Tacos ' },
      { type: 'delta', text: 'are planned.' },
      { type: 'done', content: 'Tacos are planned.', persisted: true },
    ]);
    expect(inserts.find((i) => i.table === 'ai_messages'), 'the stream must persist its messages').toBeTruthy();
    // The streaming transport names itself separately from the JSON one, so a
    // family reporting "it stops halfway" can be told which transport they were
    // on — the two fail in different ways.
    expect(inserts.find((i) => i.table === 'ai_requests')?.rows)
      .toMatchObject({ feature: 'assistant.stream', conversation_id: input.conversationId });
  });

  it('falls back to a non-streaming run when the stream dies before any text', async () => {
    provider.runToolsStream.mockImplementationOnce(async function* () { throw new Error('proxy closed'); });
    provider.runTools.mockResolvedValueOnce({ text: 'Recovered.', actions: [] });
    const prepared = await prepareAssistantTurn(input);
    if (!prepared.ok) throw new Error('prepare failed');
    const events = await readSse(createAssistantStream(input, prepared.turn));
    expect(events.map((e) => e.type)).toEqual(['delta', 'done']);
    expect(events[1]).toEqual({ type: 'done', content: 'Recovered.', persisted: true });
  });

  it('surfaces a mid-stream failure but keeps the partial answer', async () => {
    provider.runToolsStream.mockImplementationOnce(async function* () { yield { type: 'delta', text: 'Partial' }; throw new Error('cut'); });
    const prepared = await prepareAssistantTurn(input);
    if (!prepared.ok) throw new Error('prepare failed');
    const events = await readSse(createAssistantStream(input, prepared.turn));
    expect(events.map((e) => e.type)).toEqual(['delta', 'error', 'done']);
    expect(events[2].content).toBe('Partial');
    expect(provider.runTools).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('summarizes tool results for the UI', () => {
    expect(summarizeToolResult({ ok: true, summary: 'Saved.' })).toEqual({ ok: true, summary: 'Saved.' });
    expect(summarizeToolResult({ ok: false, error: 'Nope.' })).toEqual({ ok: false, summary: 'Nope.' });
    expect(summarizeToolResult({ ok: false })).toEqual({ ok: false, summary: 'That didn’t work.' });
    expect(summarizeToolResult('raw')).toEqual({ ok: true, summary: 'Done.' });
  });
  it('finalizes content with outcome-aware fallbacks', () => {
    const done = { result: { ok: true, summary: 'Added.' } };
    const denied = { result: { ok: false, error: 'Blocked by household policy: children cannot post announcements' } };
    const pending = { result: { ok: true, summary: '⏳ Sent for parent approval', pending_approval: true, approval_id: 'a1' } };

    // The model's own words always win.
    expect(finalizeAssistantContent('  Hi  ', [])).toBe('Hi');
    expect(finalizeAssistantContent('  Hi  ', [denied])).toBe('Hi');

    expect(finalizeAssistantContent('', [])).toBe('I’m not sure how to help with that yet.');
    expect(finalizeAssistantContent('', [done, done])).toBe('Done — I’ve updated that for you.');

    // THE BUG THIS REPLACES: a turn whose every action was refused by the
    // household's own policy used to sign off "Done — I’ve updated that for
    // you." The child believed the announcement was posted; it never was.
    expect(finalizeAssistantContent('', [denied]))
      .toBe('Blocked by household policy: children cannot post announcements');
    expect(finalizeAssistantContent('', [denied, denied]))
      .toBe('Blocked by household policy: children cannot post announcements');

    // A queued approval is not "done" either — nothing is written yet.
    expect(finalizeAssistantContent('', [pending])).toBe('That needs a parent’s OK, so I’ve sent it for approval.');
    expect(finalizeAssistantContent('', [pending, pending])).toBe('Those need a parent’s OK, so I’ve sent them for approval.');

    // Mixed turns name each part rather than letting the happiest one speak.
    expect(finalizeAssistantContent('', [done, denied]))
      .toBe('I’ve done part of that. Blocked by household policy: children cannot post announcements');
    expect(finalizeAssistantContent('', [done, pending])).toBe('I’ve done part of that. 1 of them needs a parent’s OK.');
    expect(finalizeAssistantContent('', [done, pending, pending, denied]))
      .toBe('I’ve done part of that. 2 of them need a parent’s OK. Blocked by household policy: children cannot post announcements');
  });

  it('reads the pending flag in the shape the wrapper and the registry both emit', () => {
    // legacy-adapter.ts returns snake_case `pending_approval`; the trust
    // wrapper used to return camelCase. Both are accepted so a turn that mixes
    // a registry tool and a wrapped one cannot be scored two different ways.
    const snake = { result: { ok: true, summary: 'x', pending_approval: true } };
    const camel = { result: { ok: true, summary: 'x', pendingApproval: true } };
    expect(finalizeAssistantContent('', [snake])).toBe('That needs a parent’s OK, so I’ve sent it for approval.');
    expect(finalizeAssistantContent('', [camel])).toBe('That needs a parent’s OK, so I’ve sent it for approval.');
  });
  it('builds a system prompt with a localized snapshot', () => {
    const system = buildAssistantSystemPrompt({
      familyName: 'Fam', tz: 'Europe/Paris', members: [{ display_name: 'A', role: 'parent' }],
      events: [{ title: 'Dentist', starts_at: '2026-09-07T08:30:00Z' }], openChores: 1, meals: [],
      now: new Date('2026-09-05T10:00:00Z'),
    });
    expect(system).toContain('Time zone: Europe/Paris.');
    expect(system).toContain('Members: A (parent)');
    expect(system).toContain('Dentist — Mon, Sep 7, 10:30 AM');
    expect(system).toContain('Saved meals: none');
    expect(buildAssistantSystemPrompt({ familyName: 'F', tz: 'Not/AZone', members: [], events: [{ title: 'E', starts_at: '2026-09-07T08:30:00Z' }], openChores: 0, meals: [] })).toContain('E — 2026-09-07T08:30');
  });
  it('persistAssistantTurn only titles brand-new conversations', async () => {
    tables.ai_conversations = { single: { title: 'Weekend plans' } };
    const res = await persistAssistantTurn(supabase, { familyId: 'fam-1', conversationId: 'c', message: 'm', assistantContent: 'a', actions: [], model: 'x' });
    expect(res).toEqual({ ok: true });
    expect(updates[0].patch).toEqual({ model: 'x' });
  });
});
