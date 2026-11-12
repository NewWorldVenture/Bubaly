// Call-level role tests for the "Why this?" feedback write
// (app/(app)/dashboard/ai-feedback-actions.ts), Register B ACTION-2818A604DE3C
// (recordAiFeedbackAction).
//
// THE POLICY. Any member may tell Bubaly whether a recommendation helped: the
// live insert policy on ai_feedback is family membership
// (0143_ai_feedback.sql:36, `with check (public.is_family_member(family_id))`)
// and the action's own comment calls the log append-only and family-scoped.
// The family and the author are the SESSION's — the input carries neither — so
// no caller can file feedback into another household or under another member.
//
// WHAT IS ASSERTED: for each role in household A the real action appends one
// row to A, stamped with the caller's member and user ids and the validated,
// truncated input; household B's log is untouched; and an unknown surface or
// signal is refused before the session is even read, with nothing written.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ db: null as unknown, requireUserContext: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { recordAiFeedbackAction } = await import('@/app/(app)/dashboard/ai-feedback-actions');

const FAMILY_A = '00000000-0000-4000-8000-00000000000a';
const FAMILY_B = '00000000-0000-4000-8000-00000000000b';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;

let db: InMemorySupabase;

function signInAs(role: string) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `user-a-${role}`, email: `${role}@example.com` },
    active: { familyId: FAMILY_A, role, member: { id: `member-a-${role}` }, family: { id: FAMILY_A, timezone: 'UTC' } },
  });
}

const B_ROW = { id: 'feedback-b', family_id: FAMILY_B, member_id: 'member-b-parent', surface: 'insight', signal: 'helpful' };

beforeEach(() => {
  vi.resetAllMocks();
  db = createInMemorySupabase();
  mocks.db = db;
  db.seed('ai_feedback', [B_ROW]);
});
afterEach(() => vi.restoreAllMocks());

describe('recordAiFeedbackAction', () => {
  it.each(ROLES)('ACTION-2818A604DE3C signed in as %s, a member appends one row to their own family under their own name', async (role) => {
    signInAs(role);
    const result = await recordAiFeedbackAction({
      surface: 'autopilot', signal: 'not_helpful', refKind: 'suggestion', refId: 'ref-1',
      reason: 'x'.repeat(600), note: 'too early',
    });
    expect(result).toEqual({ ok: true });

    const mine = db.table('ai_feedback').filter((r) => r.family_id === FAMILY_A);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      family_id: FAMILY_A, member_id: `member-a-${role}`, created_by: `user-a-${role}`,
      surface: 'autopilot', signal: 'not_helpful', ref_kind: 'suggestion', ref_id: 'ref-1', note: 'too early',
    });
    expect(String(mine[0].reason)).toHaveLength(500);
    expect(db.table('ai_feedback').filter((r) => r.family_id === FAMILY_B)).toEqual([expect.objectContaining(B_ROW)]);
  });

  it.each([
    ['an unknown surface', { surface: 'wallet', signal: 'helpful' }, 'aiFeedbackActions.invalidSurface'],
    ['an unknown signal', { surface: 'insight', signal: 'love-it' }, 'aiFeedbackActions.invalidSignal'],
  ])('ACTION-2818A604DE3C %s is refused before the session is read, and nothing is written', async (_what, input, error) => {
    signInAs('parent');
    expect(await recordAiFeedbackAction(input as never)).toEqual({ ok: false, error });
    expect(mocks.requireUserContext).not.toHaveBeenCalled();
    expect(db.table('ai_feedback')).toHaveLength(1);
  });
});
