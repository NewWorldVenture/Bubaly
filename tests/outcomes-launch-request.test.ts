// M25 — the outcome cards can start work, and what they start is not a guess.
//
// Two claims are pinned here, because between them they are the whole feature:
//
//   1. every outcome's launch sentence is recognised by a DETERMINISTIC fast
//      path as the intent the card promises. If it fell through to the
//      classifier model, "Prepare for an emergency" could come back as
//      `prepare_vacation` and the family would get a packing list;
//   2. pressing the button really files an `ai_requests` row — the same row
//      the bar files — carrying that request text and that interpreted intent,
//      so the launch shows up on the run timeline and in the ledger rather
//      than only in the browser.
//
// And a third, added after a review: what the card SAYS afterwards matches what
// the server actually did. `submitRequest` answers with four different outcomes
// and only one of them is work in flight, so the launcher's message is derived
// from the real response rather than from "the POST returned 2xx".
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { OUTCOMES, OUTCOME_INTENT, buildOutcomeLaunchRequest, describeOutcomeLaunch } from '@/lib/outcomes/launcher';
import { classifyIntentFast, INTENT_KEYS } from '@/lib/ai/context/intents';
import { templateFor } from '@/lib/ai/planner/templates/index';
import type { ServiceScope } from '@/lib/services/types';

const buildContext = vi.fn();
const planRequest = vi.fn();

vi.mock('@/lib/ai/context/builder', () => ({ buildContext: (...args: unknown[]) => buildContext(...args) }));
vi.mock('@/lib/ai/planner', () => ({ planRequest: (...args: unknown[]) => planRequest(...args) }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: vi.fn() }));

const { submitRequest } = await import('@/lib/ai/runs/intake');

const FAMILY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';

let db: InMemorySupabase;

function scope(): ServiceScope {
  return {
    db: db as never, familyId: FAMILY, userId: USER, memberId: MEMBER,
    role: 'parent', actorKind: 'member', tz: 'America/New_York',
  } as ServiceScope;
}

beforeEach(() => {
  db = createInMemorySupabase();
  buildContext.mockResolvedValue({ ok: true, data: { text: '', slices: [], intent: 'other' } });
  planRequest.mockResolvedValue({
    ok: true,
    data: { kind: 'plan', planId: 'plan-1', runId: 'run-1', stepCount: 4, riskLevel: 'low', requiresApproval: false, summary: 'On it.' },
  });
});

describe('every outcome maps to a workflow the concierge can actually run', () => {
  it('names a registered intent with a template behind it', () => {
    for (const outcome of OUTCOMES) {
      const intent = OUTCOME_INTENT[outcome.id];
      expect(INTENT_KEYS, outcome.id).toContain(intent);
      expect(templateFor(intent), `${outcome.id} → ${intent}`).not.toBeNull();
    }
  });

  it('classifies every launch sentence deterministically, with no model call', () => {
    for (const outcome of OUTCOMES) {
      const request = buildOutcomeLaunchRequest(outcome.id);
      const classified = classifyIntentFast(request.text, { now: new Date('2026-09-07T12:00:00Z') });
      expect(classified, `${outcome.id}: "${request.text}"`).not.toBeNull();
      expect(classified?.source, outcome.id).toBe('fast_path');
      expect(classified?.intent, `${outcome.id}: "${request.text}"`).toBe(request.intent);
    }
  });

  it('carries the outcome in the page context so the run says where it came from', () => {
    expect(buildOutcomeLaunchRequest('feed_family').context).toEqual({ module: 'outcomes:feed_family' });
  });
});

describe('the launch button files a request', () => {
  it('writes one ai_requests row with the launch text and the interpreted intent', async () => {
    const request = buildOutcomeLaunchRequest('prepare_unexpected');
    const result = await submitRequest(scope(), { text: request.text, context: request.context, conversationId: null, answers: null, clientRequestId: null }, { db: db as never, kick: vi.fn() });

    expect(result.ok).toBe(true);
    const rows = db.table('ai_requests');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      family_id: FAMILY,
      requested_by: USER,
      kind: 'concierge',
      request_text: request.text,
      interpreted_intent: 'emergency_prep',
    });
    // The planner was handed the same intent the card promised.
    expect(planRequest.mock.calls[0]?.[1]).toMatchObject({ intent: 'emergency_prep', requestText: request.text });
  });

  it('files the school outcome as back_to_school, not as a generic plan', async () => {
    const request = buildOutcomeLaunchRequest('prepare_school');
    await submitRequest(scope(), { text: request.text, context: request.context, conversationId: null, answers: null, clientRequestId: null }, { db: db as never, kick: vi.fn() });
    expect(db.table('ai_requests')[0]).toMatchObject({ interpreted_intent: 'back_to_school' });
  });

  it('leaves no request row when there is nothing to ask for', async () => {
    const result = await submitRequest(scope(), { text: '   ', context: null, conversationId: null, answers: null, clientRequestId: null }, { db: db as never, kick: vi.fn() });
    expect(result.ok).toBe(false);
    expect(db.table('ai_requests')).toHaveLength(0);
  });
});

// A 2xx is not "Bubaly is working on it". `stay_healthy` asks a question the
// planner answers inline; `celebrate` and the life-event launches are told to
// ask rather than guess. Both come back 2xx with no work under way, and the
// card used to claim there was — with no link to open, and the server's actual
// reply thrown away. These cases run the REAL intake so the shape they assert
// is the shape the server sends.
describe('the card says what the server actually did', () => {
  async function launch(id: Parameters<typeof buildOutcomeLaunchRequest>[0]) {
    const request = buildOutcomeLaunchRequest(id);
    const result = await submitRequest(
      scope(),
      { text: request.text, context: request.context, conversationId: null, answers: null, clientRequestId: null },
      { db: db as never, kick: vi.fn() },
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }

  it('a plan is the only outcome that reports work in flight, and it carries a run to open', async () => {
    const data = await launch('prepare_unexpected');
    expect(data.outcome).toBe('plan');
    const report = describeOutcomeLaunch(data);
    expect(report.kind).toBe('working');
    if (report.kind !== 'working') throw new Error('unreachable');
    expect(report.runHref).toContain('run-1');
  });

  it('an inline answer reports the answer, not work — there is no run row to follow', async () => {
    planRequest.mockResolvedValue({ ok: true, data: { kind: 'answer', text: 'Two check-ups are due and nothing else is outstanding.' } });
    const data = await launch('stay_healthy');
    // The server closed the request without creating a run.
    expect(data).toMatchObject({ outcome: 'answer', runId: null, planId: null, redirect: null });
    expect(db.table('family_automation_runs')).toHaveLength(0);
    expect(describeOutcomeLaunch(data)).toEqual({ kind: 'reply', reply: 'Two check-ups are due and nothing else is outstanding.' });
  });

  it('a recommendation reports the recommendation, not work', async () => {
    planRequest.mockResolvedValue({ ok: true, data: { kind: 'recommendation', recommendationId: 'rec-1', summary: 'Book the dentist before half term.' } });
    const data = await launch('stay_healthy');
    expect(data).toMatchObject({ outcome: 'recommendation', runId: null, redirect: null });
    expect(describeOutcomeLaunch(data)).toEqual({ kind: 'reply', reply: 'Book the dentist before half term.' });
  });

  it('a clarification reports the question and where to answer it — the run is parked, not working', async () => {
    planRequest.mockImplementation((_scope: unknown, input: { requestId: string }) =>
      Promise.resolve({ ok: true, data: { kind: 'clarification', question: 'Which holiday do you mean?', requestId: input.requestId } }));
    const data = await launch('celebrate');
    expect(data.outcome).toBe('clarification');
    expect(data.runId).toBeTruthy();
    const report = describeOutcomeLaunch(data);
    expect(report.kind).toBe('question');
    if (report.kind !== 'question') throw new Error('unreachable');
    expect(report.question).toBe('Which holiday do you mean?');
    expect(report.runHref).toBe(data.redirect);
  });

  it('never reports work in flight without a run to open', () => {
    for (const outcome of ['plan', 'answer', 'recommendation', 'clarification'] as const) {
      const report = describeOutcomeLaunch({ outcome, runId: null, redirect: null, summary: 'Something happened.' });
      expect(report.kind, outcome).not.toBe('working');
    }
    // A replayed answer carries no text at all; the card still must not invent work.
    expect(describeOutcomeLaunch({ outcome: 'answer', runId: null, redirect: null, summary: '' })).toEqual({ kind: 'reply', reply: '' });
  });
});
