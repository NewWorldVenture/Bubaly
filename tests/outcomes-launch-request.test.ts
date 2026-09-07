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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { OUTCOMES, OUTCOME_INTENT, buildOutcomeLaunchRequest } from '@/lib/outcomes/launcher';
import { classifyIntentFast, INTENT_KEYS } from '@/lib/ai/context/intents';
import { templateFor } from '@/lib/ai/planner/templates/index';

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

function scope() {
  return {
    db: db as never, familyId: FAMILY, userId: USER, memberId: MEMBER,
    role: 'parent', actorKind: 'member' as const, tz: 'America/New_York',
  };
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
