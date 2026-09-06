// A parent asks why their child's week looked the way it did.
//
// `/api/behavior/insight` answers 200 whatever happens, which is right — a
// parenting screen should not show a stack trace. The cost is that three quite
// different outcomes look identical from the outside, and until §33 none of them
// left a record:
//
//   - the coach answers usable JSON                  → real coaching
//   - the coach answers prose (no braces at all)     → a canned line
//   - the coach answers malformed braces             → a data-derived fallback
//   - the provider throws                            → the same fallback
//
// Two things this file exists to hold still, both of which a fix for the other
// one broke at least once:
//
//   1. The malformed-JSON case keeps the RICHER fallback — the family's own
//      numbers plus three concrete tips — and not the canned line. Catching the
//      parse to sanitise its message must not quietly downgrade the answer.
//   2. Nothing from the model's reply reaches `ai_requests.error`. V8 embeds a
//      snippet of the input in JSON.parse messages, and the input here is text
//      about a child's behaviour.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  resolveProvider: vi.fn(),
  complete: vi.fn(),
  rate: vi.fn(),
  createRequest: vi.fn(),
  updateRequest: vi.fn(),
  recordModelCall: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/ai/provider', () => ({ resolveProvider: mocks.resolveProvider }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: mocks.rate }));
vi.mock('@/lib/ai/runs/store', () => ({ createRequest: mocks.createRequest, updateRequest: mocks.updateRequest }));
vi.mock('@/lib/ai/usage', () => ({ recordModelCall: mocks.recordModelCall }));

import { POST } from '@/app/api/behavior/insight/route';

/** The child's own words, so a leak is unmistakable in an assertion. */
const CHILD_TEXT = 'Ava had three meltdowns about her sister this week';

const LOGS = [
  { member_id: 'member-1', kind: 'positive', category: 'kindness', note: CHILD_TEXT, points: 1, occurred_at: '2026-09-01T10:00:00.000Z' },
  { member_id: 'member-1', kind: 'positive', category: 'chores', note: CHILD_TEXT, points: 1, occurred_at: '2026-09-02T10:00:00.000Z' },
  { member_id: 'member-1', kind: 'concern', category: 'siblings', note: CHILD_TEXT, points: -1, occurred_at: '2026-09-03T10:00:00.000Z' },
];

function request() {
  return new Request('http://localhost/api/behavior/insight', {
    method: 'POST',
    body: JSON.stringify({ memberId: 'member-1' }),
    headers: { 'content-type': 'application/json' },
  }) as never;
}

/** Every error string the observability layer was asked to store. */
function recordedErrors(): string[] {
  return mocks.updateRequest.mock.calls
    .map(([, , patch]) => (patch as { error?: unknown }).error)
    .filter((e): e is string => typeof e === 'string');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: {
      familyId: 'family-1', role: 'parent',
      family: { name: 'Family One', timezone: 'America/Chicago' },
      member: { id: 'member-1' },
    },
  });
  mocks.rate.mockResolvedValue({ ok: true });
  // The route builds the query and THEN conditionally appends `.eq()` after
  // `.limit()`, so the chain has to stay chainable to the end and only resolve
  // when awaited. A stub that resolves at `.limit()` breaks on the `.eq()`.
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'gte', 'order', 'limit', 'eq', 'in']) chain[m] = () => chain;
  chain.then = (onF: (v: unknown) => unknown) => Promise.resolve({ data: LOGS, error: null }).then(onF);
  mocks.createServer.mockResolvedValue({ from: () => chain });
  mocks.resolveProvider.mockResolvedValue({ model: 'test-model', complete: mocks.complete });
  mocks.createRequest.mockResolvedValue({ ok: true, data: { id: 'req-1' } });
  mocks.updateRequest.mockResolvedValue({ ok: true, data: null });
  mocks.recordModelCall.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('malformed JSON keeps the richer fallback', () => {
  it('answers with the data-derived summary and three tips, not the canned line', async () => {
    // Braces present so the regex matches, contents unparseable so JSON.parse
    // throws. This is the case a fix for the leak downgraded once already.
    mocks.complete.mockResolvedValue({ text: `{ ${CHILD_TEXT} oops }`, usage: null });
    const body = await (await POST(request())).json() as { insight: string; tips: string[] };

    expect(body.tips, 'the three concrete tips must survive').toHaveLength(3);
    expect(body.insight).not.toBe('Keep logging — patterns will sharpen over time.');
    // The fallback is built from the family's own counts, so it names them.
    expect(body.insight).toMatch(/positive/);
    expect(body.insight).toMatch(/concern/);
  });

  it('records the failure with a constant message, never the reply', async () => {
    mocks.complete.mockResolvedValue({ text: `{ ${CHILD_TEXT} oops }`, usage: null });
    await POST(request());

    const errors = recordedErrors();
    expect(errors).toContain('The coach reply was not valid JSON.');
    // The whole point. V8 writes `Unexpected token 'A', "Ava had th"... is not
    // valid JSON`, and that must not reach a column the admin console renders.
    for (const e of errors) {
      expect(e, 'no part of the reply may reach the row').not.toContain('Ava');
      expect(e, 'nor the V8 parser wording that carries it').not.toContain('Unexpected token');
    }
  });
});

describe('the other two outcomes stay as they were', () => {
  it('returns real coaching when the reply parses, and settles completed', async () => {
    mocks.complete.mockResolvedValue({
      text: JSON.stringify({ insight: 'A good week overall.', tips: ['One', 'Two', 'Three'] }),
      usage: { promptTokens: 30, completionTokens: 20 },
    });
    const body = await (await POST(request())).json() as { insight: string; tips: string[] };
    expect(body.insight).toBe('A good week overall.');
    expect(body.tips).toEqual(['One', 'Two', 'Three']);
    expect(recordedErrors()).toEqual([]);
  });

  it('records the canned line as a failure when the reply carries no JSON at all', async () => {
    // No braces: the regex finds nothing, `parsed` stays empty, and the parent
    // gets a warm sentence indistinguishable from coaching. That is the case the
    // row exists to separate.
    mocks.complete.mockResolvedValue({ text: 'Sounds like a tricky week!', usage: null });
    const body = await (await POST(request())).json() as { insight: string };
    expect(body.insight).toBe('Keep logging — patterns will sharpen over time.');
    expect(recordedErrors().join(' ')).toContain('without a usable insight');
  });
});
