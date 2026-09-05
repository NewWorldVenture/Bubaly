import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  BRIEFING_RESPONSE_LIMITS as limits,
  BriefingResponseSchema,
  MAX_BRIEFING_RESPONSE_BYTES,
  parseBriefingResponse,
} from '@/lib/briefing/response-schema';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  isAIConfigured: vi.fn(),
  resolveProvider: vi.fn(),
  complete: vi.fn(),
  enforceAIRateLimit: vi.fn(),
  readBoundedRequestJsonOrEmpty: vi.fn(),
  buildConciergeDigest: vi.fn(),
  digestToPromptLines: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: mocks.isAIConfigured,
  resolveProvider: mocks.resolveProvider,
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: mocks.enforceAIRateLimit }));
vi.mock('@/lib/server/bounded-request-body', () => ({
  MAX_SMALL_JSON_BYTES: 16 * 1024,
  readBoundedRequestJsonOrEmpty: mocks.readBoundedRequestJsonOrEmpty,
}));
vi.mock('@/lib/concierge/digest', () => ({
  buildConciergeDigest: mocks.buildConciergeDigest,
  digestToPromptLines: mocks.digestToPromptLines,
}));

import { POST } from '@/app/api/ai/briefing/route';

function validBriefing() {
  return {
    greeting: 'Good morning, Alex!',
    subtitle: 'Saturday, September 5',
    familySummary: ['Soccer practice is this afternoon.'],
    schedule: [{ time: '3:00 PM', title: 'Soccer practice', member: 'Sam', emoji: '\u26bd', color: 'emerald' }],
    conflicts: [{ description: 'Two events overlap.', suggestion: 'Arrange a pickup.' }],
    kidsNeeds: [{ name: 'Sam', age: 10, items: ['Bring cleats.'] }],
    meals: [{ meal: 'Dinner', name: 'Tacos', status: 'planned', missing: ['Lettuce'] }],
    reminders: [{ text: 'Pay the electric bill.', urgency: 'high' }],
    operationsScore: {
      overall: 88,
      categories: [{ label: 'Schedule', score: 85, icon: '\ud83d\udcc5' }],
      stressLevel: 'moderate',
      stressReason: 'Two events overlap.',
      recommendation: 'Arrange a pickup.',
    },
    completed: ['Packed school bags.'],
    outstanding: [{ text: 'Pay the electric bill.', urgency: 'high' }],
    tomorrowPreview: { events: 3, notes: ['Soccer at 2pm.'] },
    weeklyHighlights: [{ category: 'School', emoji: '\ud83d\udcda', items: ['Bring library books.'] }],
    weeklyConflicts: [{ description: 'Practice overlaps with dinner.', suggestion: 'Move dinner later.' }],
  };
}

function changeField(path: string, value: unknown, remove = false) {
  const briefing = validBriefing();
  const keys = path.split('.');
  let target = briefing as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  const key = keys[keys.length - 1];
  if (remove) delete target[key];
  else target[key] = value;
  return briefing;
}

describe('Daily Brief response validation', () => {
  it('preserves the complete successful public payload', () => {
    const briefing = validBriefing();
    expect(parseBriefingResponse(` \n${JSON.stringify(briefing)}\n `)).toEqual(briefing);
  });

  it('preserves optional omissions, empty lists, empty member text, and nullable fields', () => {
    const full = validBriefing();
    const minimal = {
      greeting: full.greeting,
      subtitle: full.subtitle,
      familySummary: [],
      schedule: [{ ...full.schedule[0], member: '' }],
      conflicts: [],
      kidsNeeds: [{ name: 'Sam', items: [] }],
      meals: [{ meal: 'Dinner', name: null, status: 'not planned' }],
      reminders: [],
      operationsScore: { ...full.operationsScore, categories: [], stressReason: null },
    };
    expect(parseBriefingResponse(JSON.stringify(minimal))).toEqual(minimal);
  });

  it.each([undefined, null, false, 42, [], {}, validBriefing()])('rejects a non-string completion: %j', (raw) => {
    expect(parseBriefingResponse(raw)).toBeNull();
  });

  it.each(['', ' ', 'null', '[]', '[{}]', 'false', '42', '"text"', '{}', '{"greeting":'])('rejects invalid or incomplete JSON: %s', (raw) => {
    expect(parseBriefingResponse(raw)).toBeNull();
  });

  it.each([
    ['prose prefix', (json: string) => `Here is your briefing: ${json}`],
    ['prose suffix', (json: string) => `${json} Have a great day!`],
    ['markdown fence', (json: string) => `\x60\x60\x60json\n${json}\n\x60\x60\x60`],
    ['array wrapper', (json: string) => `[${json}]`],
    ['multiple objects', (json: string) => `${json}\n${json}`],
  ] as const)('rejects JSON inside %s', (_label, wrap) => {
    expect(parseBriefingResponse(wrap(JSON.stringify(validBriefing())))).toBeNull();
  });

  it.each([
    ['greeting', {}], ['subtitle', []], ['familySummary', {}], ['familySummary.0', {}],
    ['schedule', {}], ['schedule.0', null], ['schedule.0.time', 42], ['schedule.0.member', []],
    ['conflicts.0.description', {}], ['kidsNeeds.0.age', '10'], ['kidsNeeds.0.items', [false]],
    ['meals.0.name', {}], ['meals.0.status', 42], ['meals.0.missing', 'Lettuce'],
    ['reminders.0.text', []], ['operationsScore.overall', '88'], ['operationsScore.categories', {}],
    ['operationsScore.stressReason', false], ['completed', {}], ['outstanding', {}],
    ['tomorrowPreview.events', '3'], ['tomorrowPreview.notes', [null]],
    ['weeklyHighlights.0.category', {}], ['weeklyHighlights.0.items', {}],
    ['weeklyConflicts.0.description', null], ['completed', null], ['tomorrowPreview', null],
    ['kidsNeeds.0.age', null], ['meals.0.missing', null],
  ])('rejects the wrong type at %s', (path, value) => {
    expect(parseBriefingResponse(JSON.stringify(changeField(path as string, value)))).toBeNull();
  });

  it.each([
    'greeting', 'subtitle', 'familySummary', 'schedule', 'conflicts', 'kidsNeeds', 'meals',
    'reminders', 'operationsScore', 'schedule.0.time', 'schedule.0.title', 'schedule.0.member',
    'schedule.0.emoji', 'schedule.0.color', 'conflicts.0.description', 'conflicts.0.suggestion',
    'kidsNeeds.0.name', 'kidsNeeds.0.items', 'meals.0.meal', 'meals.0.name', 'meals.0.status',
    'reminders.0.text', 'reminders.0.urgency', 'operationsScore.overall',
    'operationsScore.categories', 'operationsScore.categories.0.label',
    'operationsScore.categories.0.score', 'operationsScore.categories.0.icon',
    'operationsScore.stressLevel', 'operationsScore.stressReason', 'operationsScore.recommendation',
    'outstanding.0.text', 'outstanding.0.urgency', 'tomorrowPreview.events', 'tomorrowPreview.notes',
    'weeklyHighlights.0.category', 'weeklyHighlights.0.emoji', 'weeklyHighlights.0.items',
    'weeklyConflicts.0.description', 'weeklyConflicts.0.suggestion',
  ])('rejects a missing required field at %s', (path) => {
    expect(parseBriefingResponse(JSON.stringify(changeField(path, undefined, true)))).toBeNull();
  });

  it.each([
    ['schedule.0.color', 'red'], ['reminders.0.urgency', 'urgent'],
    ['operationsScore.stressLevel', 'medium'], ['outstanding.0.urgency', 'low'],
  ])('rejects unsupported enum values at %s', (path, value) => {
    expect(parseBriefingResponse(JSON.stringify(changeField(path, value)))).toBeNull();
  });

  it.each([
    ['schedule.0.color', ['blue', 'purple', 'rose', 'emerald', 'amber', 'cyan', 'indigo']],
    ['reminders.0.urgency', ['high', 'medium', 'low']],
    ['operationsScore.stressLevel', ['low', 'moderate', 'high']],
    ['outstanding.0.urgency', ['high', 'medium']],
  ] as const)('accepts all supported enum values at %s', (path, values) => {
    for (const value of values) {
      const briefing = changeField(path, value);
      expect(parseBriefingResponse(JSON.stringify(briefing))).toEqual(briefing);
    }
  });

  it.each([
    ['operationsScore.overall', -1], ['operationsScore.overall', 101],
    ['operationsScore.categories.0.score', -1], ['operationsScore.categories.0.score', 101],
    ['kidsNeeds.0.age', -1], ['kidsNeeds.0.age', 1.5], ['kidsNeeds.0.age', limits.age + 1],
    ['tomorrowPreview.events', -1], ['tomorrowPreview.events', 1.5],
    ['tomorrowPreview.events', limits.eventCount + 1],
  ] as const)('rejects invalid numeric bounds at %s: %s', (path, value) => {
    expect(parseBriefingResponse(JSON.stringify(changeField(path, value)))).toBeNull();
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite scores: %s', (value) => {
    expect(BriefingResponseSchema.safeParse(changeField('operationsScore.overall', value)).success).toBe(false);
  });

  it.each([0, 88.5, 100])('accepts bounded numeric scores without coercion: %s', (value) => {
    expect(parseBriefingResponse(JSON.stringify(changeField('operationsScore.overall', value)))).not.toBeNull();
  });

  it.each([
    ['greeting', limits.label], ['subtitle', limits.label], ['familySummary.0', limits.text],
    ['schedule.0.time', limits.time], ['schedule.0.title', limits.label], ['schedule.0.member', limits.label],
    ['schedule.0.emoji', limits.icon], ['conflicts.0.description', limits.text], ['conflicts.0.suggestion', limits.text],
    ['kidsNeeds.0.name', limits.label], ['kidsNeeds.0.items.0', limits.text],
    ['meals.0.meal', limits.label], ['meals.0.name', limits.label], ['meals.0.status', limits.label],
    ['meals.0.missing.0', limits.label], ['reminders.0.text', limits.text],
    ['operationsScore.categories.0.label', limits.label], ['operationsScore.categories.0.icon', limits.icon],
    ['operationsScore.stressReason', limits.text], ['operationsScore.recommendation', limits.text],
    ['completed.0', limits.text], ['outstanding.0.text', limits.text], ['tomorrowPreview.notes.0', limits.text],
    ['weeklyHighlights.0.category', limits.label], ['weeklyHighlights.0.emoji', limits.icon],
    ['weeklyHighlights.0.items.0', limits.text], ['weeklyConflicts.0.description', limits.text],
    ['weeklyConflicts.0.suggestion', limits.text],
  ] as const)('bounds text at %s without truncating it', (path, max) => {
    const accepted = changeField(path, 'a'.repeat(max));
    expect(parseBriefingResponse(JSON.stringify(accepted))).toEqual(accepted);
    expect(parseBriefingResponse(JSON.stringify(changeField(path, 'a'.repeat(max + 1))))).toBeNull();
  });

  const sample = validBriefing();
  it.each([
    ['familySummary', 'Item', limits.listItems], ['schedule', sample.schedule[0], limits.listItems],
    ['conflicts', sample.conflicts[0], limits.listItems], ['kidsNeeds', sample.kidsNeeds[0], limits.listItems],
    ['kidsNeeds.0.items', 'Item', limits.nestedItems], ['meals', sample.meals[0], limits.listItems],
    ['meals.0.missing', 'Item', limits.nestedItems], ['reminders', sample.reminders[0], limits.listItems],
    ['operationsScore.categories', sample.operationsScore.categories[0], limits.categories],
    ['completed', 'Item', limits.listItems], ['outstanding', sample.outstanding[0], limits.listItems],
    ['tomorrowPreview.notes', 'Item', limits.nestedItems], ['weeklyHighlights', sample.weeklyHighlights[0], limits.listItems],
    ['weeklyHighlights.0.items', 'Item', limits.nestedItems], ['weeklyConflicts', sample.weeklyConflicts[0], limits.listItems],
  ] as const)('bounds the collection at %s', (path, item, max) => {
    expect(parseBriefingResponse(JSON.stringify(changeField(path, [])))).not.toBeNull();
    const accepted = changeField(path, Array.from({ length: max }, () => item));
    expect(parseBriefingResponse(JSON.stringify(accepted))).toEqual(accepted);
    expect(parseBriefingResponse(JSON.stringify(changeField(path, Array.from({ length: max + 1 }, () => item))))).toBeNull();
  });

  it.each([
    'href', 'schedule.0.href', 'conflicts.0.extra', 'kidsNeeds.0.extra', 'meals.0.url',
    'reminders.0.href', 'operationsScore.extra', 'operationsScore.categories.0.extra',
    'outstanding.0.href', 'tomorrowPreview.extra', 'weeklyHighlights.0.extra', 'weeklyConflicts.0.extra',
  ])('rejects unknown fields instead of forwarding or stripping them: %s', (path) => {
    expect(parseBriefingResponse(JSON.stringify(changeField(path, 'javascript:alert(1)')))).toBeNull();
  });

  it('rejects a JSON prototype key', () => {
    const json = JSON.stringify(validBriefing());
    expect(parseBriefingResponse(`{"__proto__":{"polluted":true},${json.slice(1)}`)).toBeNull();
  });

  it('enforces the raw completion byte cap before parsing, including padding', () => {
    const json = JSON.stringify(validBriefing());
    const padding = MAX_BRIEFING_RESPONSE_BYTES - new TextEncoder().encode(json).byteLength;
    expect(parseBriefingResponse(json + ' '.repeat(padding))).toEqual(validBriefing());
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(parseBriefingResponse(json + ' '.repeat(padding + 1))).toBeNull();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('bounds aggregate UTF-8 bytes even when every collection and string is within its limit', () => {
    const briefing = changeField('familySummary', Array.from({ length: limits.listItems }, () => '\u4e00'.repeat(500)));
    const json = JSON.stringify(briefing);
    expect(BriefingResponseSchema.safeParse(briefing).success).toBe(true);
    expect(json.length).toBeLessThan(MAX_BRIEFING_RESPONSE_BYTES);
    expect(new TextEncoder().encode(json).byteLength).toBeGreaterThan(MAX_BRIEFING_RESPONSE_BYTES);
    expect(parseBriefingResponse(json)).toBeNull();
  });
});

function queryResult(data: unknown[]) {
  const promise = Promise.resolve({ data, error: null });
  const query: Record<string, unknown> = { then: promise.then.bind(promise) };
  for (const method of ['select', 'eq', 'gte', 'lte', 'gt', 'order', 'limit', 'in', 'neq', 'is', 'not']) {
    query[method] = vi.fn(() => query);
  }
  return query;
}

describe('Daily Brief route schema boundary', () => {
  const now = new Date('2026-09-05T12:00:00.000Z');
  const event = { title: 'Soccer practice', starts_at: '2026-09-05T15:00:00.000Z', ends_at: null, location: null, category: 'sports', assignee_id: 'child' };
  const digest = {
    items: [
      { domain: 'bill', urgency: 'overdue', title: 'Electric bill', detail: 'Due yesterday' },
      { domain: 'pantry', urgency: 'soon', title: 'Milk', detail: 'Expires tomorrow' },
    ],
    counts: { overdue: 1, today: 0, soon: 1, total: 2 },
    byDomain: [{ domain: 'bill', count: 1 }, { domain: 'pantry', count: 1 }],
    headline: '2 items need attention',
  };

  function expectedFallback(type = 'morning') {
    return {
      greeting: `Good ${type === 'evening' ? 'evening' : 'morning'}, Alex!`,
      subtitle: now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
      familySummary: ['1 bill need attention', '1 pantry need attention'],
      schedule: [{ time: new Date(event.starts_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), title: event.title, member: 'Sam', emoji: '\ud83d\udcc5', color: 'blue' }],
      conflicts: [],
      kidsNeeds: [],
      meals: [],
      reminders: [
        { text: 'Electric bill \u2014 Due yesterday', urgency: 'high' },
        { text: 'Milk \u2014 Expires tomorrow', urgency: 'medium' },
      ],
      operationsScore: {
        overall: 60,
        categories: [],
        stressLevel: 'high',
        stressReason: digest.headline,
        recommendation: 'Start with: Electric bill \u2014 Due yesterday.',
      },
      outstanding: [{ text: 'Electric bill \u2014 Due yesterday', urgency: 'high' }],
    };
  }

  function requestBriefing(type = 'morning') {
    mocks.readBoundedRequestJsonOrEmpty.mockResolvedValue({ ok: true, value: { type } });
    return POST(new NextRequest('http://localhost/api/ai/briefing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    }));
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Live fetch is forbidden in briefing schema tests'); }));
    mocks.requireUserContext.mockResolvedValue({
      user: { id: 'user' },
      active: { familyId: 'family', family: { name: 'Example Family' }, member: { display_name: 'Alex Example' } },
    });
    mocks.createServer.mockResolvedValue({ from: mocks.from });
    mocks.from.mockImplementation((table: string) => queryResult(table === 'family_members'
      ? [{ id: 'child', display_name: 'Sam', role: 'child' }]
      : table === 'calendar_events' ? [event] : []));
    mocks.enforceAIRateLimit.mockResolvedValue({ ok: true });
    mocks.isAIConfigured.mockResolvedValue(true);
    mocks.resolveProvider.mockResolvedValue({ complete: mocks.complete });
    mocks.complete.mockResolvedValue({ text: JSON.stringify(validBriefing()), toolCalls: [] });
    mocks.buildConciergeDigest.mockReturnValue(digest);
    mocks.digestToPromptLines.mockReturnValue('- Electric bill: Due yesterday');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['morning', 'evening', 'weekly'])('preserves valid %s output and the public response envelope', async (type) => {
    const response = await requestBriefing(type);
    expect(response.status).toBe(200);
    // Every field the model wrote survives EXCEPT `completed`: "Completed
    // Today" is evidence, so the route replaces the model's list with the runs
    // that really finished. Here no run has, so the honest answer is none.
    expect(await response.json()).toEqual({ briefing: { ...validBriefing(), completed: [] }, digest, generatedAt: now.toISOString() });
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tools: [], maxTokens: 2000 }));
    expect(fetch).not.toHaveBeenCalled();
  });

  // ── "Completed Today" is evidence ───────────────────────────────────────
  // The system prompt asks the model to populate `completed`, and that list is
  // rendered as what Bubaly did for the family. So the route replaces it with
  // the runs that really reached a terminal state: the model may describe the
  // day, it does not decide what happened.
  describe('what Bubaly claims to have done', () => {
    const runs = [
      { id: 'run-done', summary: 'Planned the week', state: 'completed', progress: { total: 8, completed: 8 }, completed_at: '2026-09-05T11:00:00.000Z', updated_at: '2026-09-05T11:00:00.000Z' },
      { id: 'run-partial', summary: 'Prepared the trip', state: 'partially_completed', progress: { total: 8, completed: 6 }, completed_at: '2026-09-05T11:30:00.000Z', updated_at: '2026-09-05T11:30:00.000Z' },
    ];

    function withRuns(rows: unknown[]) {
      mocks.from.mockImplementation((table: string) => queryResult(
        table === 'family_members' ? [{ id: 'child', display_name: 'Sam', role: 'child' }]
          : table === 'calendar_events' ? [event]
          : table === 'family_automation_runs' ? rows
          : [],
      ));
    }

    it('reports the runs that finished, not the list the model wrote', async () => {
      withRuns(runs);
      mocks.complete.mockResolvedValue({ text: JSON.stringify({ ...validBriefing(), completed: ['Booked a holiday nobody asked for'] }), toolCalls: [] });

      const body = await (await requestBriefing('evening')).json();
      // Newest first, and the partial one is labelled as partial — a run that
      // did six of eight things must not read like one that did all eight.
      expect(body.briefing.completed).toEqual(['Prepared the trip — partly done', 'Planned the week']);
      expect(body.briefing.completed).not.toContain('Booked a holiday nobody asked for');
      // Everything else the model wrote is still its own.
      expect(body.briefing.greeting).toBe(validBriefing().greeting);
    });

    it('says nothing rather than something when no run finished', async () => {
      withRuns([]);
      mocks.complete.mockResolvedValue({ text: JSON.stringify({ ...validBriefing(), completed: ['Tidied the whole house'] }), toolCalls: [] });
      const body = await (await requestBriefing('evening')).json();
      expect(body.briefing.completed).toEqual([]);
    });

    it('ignores runs that did not reach a terminal state', async () => {
      withRuns([
        ...runs,
        { id: 'run-going', summary: 'Still working', state: 'executing', progress: { total: 4, completed: 1 }, completed_at: null, updated_at: '2026-09-05T11:45:00.000Z' },
        { id: 'run-failed', summary: 'Did not work', state: 'failed', progress: { total: 4, completed: 0 }, completed_at: null, updated_at: '2026-09-05T11:50:00.000Z' },
      ]);
      const body = await (await requestBriefing('evening')).json();
      expect(body.briefing.completed).toHaveLength(2);
      expect(body.briefing.completed.join(' ')).not.toMatch(/Still working|Did not work/);
    });

    it('still answers when the brief cannot be filed', async () => {
      // The fake client has no `upsert`; a storage problem must cost the row,
      // never the briefing.
      withRuns(runs);
      const response = await requestBriefing('evening');
      expect(response.status).toBe(200);
      expect((await response.json()).briefing.completed).toHaveLength(2);
    });
  });

  it.each([
    ['empty completion', ''], ['invalid JSON', '{'], ['empty object', '{}'],
    ['array', JSON.stringify([validBriefing()])], ['missing fields', '{"greeting":"Hello"}'],
    ['bad field type', JSON.stringify(changeField('schedule', 'invalid'))],
    ['unsupported enum', JSON.stringify(changeField('operationsScore.stressLevel', 'urgent'))],
    ['excessive text', JSON.stringify(changeField('greeting', 'x'.repeat(limits.label + 1)))],
    ['excessive list', JSON.stringify(changeField('reminders', Array.from({ length: limits.listItems + 1 }, () => validBriefing().reminders[0])))],
    ['prose-wrapped JSON', `Here it is: ${JSON.stringify(validBriefing())}`],
    ['oversized completion', ' '.repeat(MAX_BRIEFING_RESPONSE_BYTES + 1)],
  ])('uses the unchanged deterministic fallback for %s', async (_label, text) => {
    mocks.complete.mockResolvedValue({ text, toolCalls: [] });
    const response = await requestBriefing();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ briefing: { ...expectedFallback(), completed: [] }, digest, generatedAt: now.toISOString() });
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['morning', 'evening', 'weekly'])('preserves the unconfigured %s fallback without resolving a provider', async (type) => {
    mocks.isAIConfigured.mockResolvedValue(false);
    const response = await requestBriefing(type);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ briefing: { ...expectedFallback(type), completed: [] }, digest, generatedAt: now.toISOString() });
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the sparse-data fallback and its nullable stress reason', async () => {
    mocks.isAIConfigured.mockResolvedValue(false);
    mocks.from.mockImplementation(() => queryResult([]));
    const emptyDigest = { items: [], counts: { overdue: 0, today: 0, soon: 0, total: 0 }, byDomain: [], headline: 'All caught up' };
    mocks.buildConciergeDigest.mockReturnValue(emptyDigest);
    const response = await requestBriefing();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.digest).toEqual(emptyDigest);
    expect(body.briefing).toMatchObject({
      familySummary: ['Nothing outstanding \u2014 enjoy the open day!'],
      schedule: [],
      reminders: [],
      outstanding: [],
      operationsScore: { overall: 90, stressLevel: 'low', stressReason: null, recommendation: 'You are all caught up. Have a great day!' },
    });
    expect(BriefingResponseSchema.safeParse(body.briefing).success).toBe(true);
  });

  it.each(['configuration', 'resolution', 'completion'])('preserves the existing 500 response for a provider %s failure', async (stage) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failingMock = stage === 'configuration' ? mocks.isAIConfigured : stage === 'resolution' ? mocks.resolveProvider : mocks.complete;
    failingMock.mockRejectedValue(new Error('Mock provider unavailable'));
    const response = await requestBriefing();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to generate briefing' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
