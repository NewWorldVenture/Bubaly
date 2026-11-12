// The approval card's two server actions, called as each member of a household
// and with another household's approval id.
//
// THE POLICY. Deciding an approval is a manager's: lib/constants/roles.ts
// (`isManager` = parent or adult; "Managers can edit shared data and approve
// chores"), the service gate both actions share (lib/services/approvals/index.ts
// `openForDecision`: "Only a parent or adult in the family can decide
// approvals."), and the approval card, which offers Edit only to a manager
// (`listPending` → `canEdit: isManager(scope.role)`). The service reads the
// approval by id AND the caller's family, so another household's id is "not found".
//
// WHAT IS ASSERTED, per role: the reply AND the approval_requests row read back
// (status, votes, decided_by, edited_payload) and the tool call it released.
// A parent or adult approves, declines or edits-and-approves; a teen, child,
// caregiver or guest is refused and the row is exactly as it was, with no tool
// run; household B's pending approval is not found and stays pending.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { CHILD_LOGIN_EMAIL_DOMAIN } from '@/lib/onboarding/child-login';

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  ctx: null as unknown,
  revalidatePath: vi.fn(),
  executed: [] as { name: string; args: unknown }[],
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db, createServiceClient: () => mocks.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    if (!mocks.ctx) throw new Error('redirect:/login');
    return mocks.ctx;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/ai/runs/continue', () => ({
  kickRun: () => {},
  continueRun: async () => ({ status: 'unavailable', completed: 0, failed: 0, pending: 0, awaitingApproval: 0, claimed: false }),
}));
// The tool the approval releases is not on trial; what reaches it is.
vi.mock('@/lib/ai/tools/execute', () => ({
  executeTool: async (_scope: unknown, name: string, args: unknown) => {
    mocks.executed.push({ name, args });
    return { status: 'ok', data: { id: 'ev-1' }, summary: `Did ${name}`, toolCallId: 'call-1', verified: true };
  },
}));

const { decideApproval, editAndApproveApproval } = await import('@/app/(app)/dashboard/approvals-actions');

const FAMILY_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const FAMILY_B = 'bbbbbbbb-0000-4000-8000-000000000001';
const APPROVAL_A = 'dddddddd-0000-4000-8000-00000000000a';
const APPROVAL_B = 'dddddddd-0000-4000-8000-00000000000b';

const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
type Caller = { role: string; member: string; user: string; email: string; name: string };
const CALLERS: Caller[] = [
  ...ROLES.map((role, i) => ({
    role, name: role, member: `aaaaaaaa-1111-4000-8000-00000000000${i + 1}`, user: `aaaaaaaa-2222-4000-8000-00000000000${i + 1}`, email: `${role}@example.com`,
  })),
  { role: 'child', name: 'child (kid login)', member: 'aaaaaaaa-1111-4000-8000-000000000009', user: 'aaaaaaaa-2222-4000-8000-000000000009', email: `kid@${CHILD_LOGIN_EMAIL_DOMAIN}` },
];
const MANAGERS = CALLERS.filter((c) => c.role === 'parent' || c.role === 'adult');
const NON_MANAGERS = CALLERS.filter((c) => c.role !== 'parent' && c.role !== 'adult');

let db: InMemorySupabase;

function signInAs(c: Caller) {
  mocks.ctx = {
    user: { id: c.user, email: c.email },
    active: { familyId: FAMILY_A, role: c.role, member: { id: c.member }, family: { id: FAMILY_A, timezone: 'UTC' } },
  };
}

function approvalRow(id: string, family: string): Record<string, unknown> {
  return {
    id, family_id: family, domain: 'calendar', capability: 'automate',
    requested_by_kind: 'ai', requested_by_member_id: null, agent: 'Concierge',
    title: 'Add soccer Saturday', summary: null,
    payload: { name: 'calendar.createEvent', args: { title: 'Soccer', starts_at: '2026-09-06T13:00:00Z' } },
    payload_kind: 'tool', amount_cents: null, confidence: 0.9, policy_id: null, reasoning: 'risk tier',
    approval_model: 'single', required_approvals: 1, approvals: [], status: 'pending', priority: 'normal',
    decided_by: null, decided_at: null, expires_at: '2099-01-01T00:00:00Z', executed_at: null, execution_result: null,
    request_id: null, run_id: null, plan_step_id: null, plan_step_ids: [], consequences: [], evidence: null,
    edited_payload: null, reviewed_by: null, review_note: null,
  };
}

const approvalIn = (id: string) => structuredClone(db.table('approval_requests').find((r) => r.id === id));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executed = [];
  db = createInMemorySupabase();
  mocks.db = db;
  mocks.ctx = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_members', CALLERS.map((c) => ({
    id: c.member, family_id: FAMILY_A, user_id: c.user, display_name: c.name, role: c.role, is_active: true,
  })));
  db.seed('approval_requests', [approvalRow(APPROVAL_A, FAMILY_A), approvalRow(APPROVAL_B, FAMILY_B)]);
  // The trust engine's own filing line (service-role only, 0260): Bubaly filed both.
  db.seed('trust_audit_logs', [
    { family_id: FAMILY_A, actor_kind: 'ai_agent', actor_id: 'concierge', approval_id: APPROVAL_A, decision: 'require_approval' },
    { family_id: FAMILY_B, actor_kind: 'ai_agent', actor_id: 'concierge', approval_id: APPROVAL_B, decision: 'require_approval' },
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe('decideApproval', () => {
  it.each(MANAGERS.map((c) => [c.name, c] as const))('ACTION-03B29F75B827 a %s approves household A’s request and the tool it holds runs once', async (_n, c) => {
    signInAs(c);
    const theirs = approvalIn(APPROVAL_B);

    const res = await decideApproval({ id: APPROVAL_A, decision: 'approved' });

    expect(res).toMatchObject({ ok: true, data: { status: 'approved' } });
    expect(approvalIn(APPROVAL_A)).toMatchObject({ status: 'approved', decided_by: c.member, approvals: [expect.objectContaining({ member_id: c.member, decision: 'approved' })] });
    expect(mocks.executed).toEqual([{ name: 'calendar.createEvent', args: expect.objectContaining({ title: 'Soccer' }) }]);
    expect(approvalIn(APPROVAL_B)).toEqual(theirs);
  });

  it.each(MANAGERS.map((c) => [c.name, c] as const))('ACTION-03B29F75B827 a %s declines household A’s request and nothing runs', async (_n, c) => {
    signInAs(c);

    const res = await decideApproval({ id: APPROVAL_A, decision: 'rejected', note: 'Not this week' });

    expect(res).toMatchObject({ ok: true, data: { status: 'rejected', executed: false } });
    expect(approvalIn(APPROVAL_A)).toMatchObject({ status: 'rejected', decided_by: c.member, review_note: 'Not this week' });
    expect(mocks.executed).toEqual([]);
  });

  it.each(NON_MANAGERS.flatMap((c) => (['approved', 'rejected'] as const).map((d) => [c.name, d, c] as const)))(
    'ACTION-03B29F75B827 a %s cannot record %s, and the request is untouched', async (_n, decision, c) => {
      signInAs(c);
      const before = structuredClone(db.table('approval_requests'));

      const res = await decideApproval({ id: APPROVAL_A, decision });

      expect(res).toMatchObject({ ok: false, code: 'denied', error: 'Only a parent or adult in the family can decide approvals.' });
      expect(db.table('approval_requests')).toEqual(before);
      expect(mocks.executed).toEqual([]);
    },
  );

  it.each(MANAGERS.flatMap((c) => (['approved', 'rejected'] as const).map((d) => [c.name, d, c] as const)))(
    'ACTION-03B29F75B827 a %s of household A cannot record %s on household B’s request', async (_n, decision, c) => {
      signInAs(c);
      const before = structuredClone(db.table('approval_requests'));

      const res = await decideApproval({ id: APPROVAL_B, decision });

      expect(res).toMatchObject({ ok: false, code: 'not_found' });
      expect(db.table('approval_requests')).toEqual(before);
      expect(approvalIn(APPROVAL_B)?.status).toBe('pending');
      expect(mocks.executed).toEqual([]);
    },
  );

  it('ACTION-03B29F75B827 a signed-out caller is sent to sign in and nothing is decided', async () => {
    const before = structuredClone(db.table('approval_requests'));
    await expect(decideApproval({ id: APPROVAL_A, decision: 'approved' })).rejects.toThrow('redirect:/login');
    expect(db.table('approval_requests')).toEqual(before);
  });
});

describe('editAndApproveApproval', () => {
  it.each(MANAGERS.map((c) => [c.name, c] as const))('ACTION-38840F5B33E9 a %s edits and approves household A’s request; the edited version is what runs', async (_n, c) => {
    signInAs(c);
    const theirs = approvalIn(APPROVAL_B);

    const res = await editAndApproveApproval({ id: APPROVAL_A, edits: { title: 'Football' } });

    expect(res).toMatchObject({ ok: true, data: { status: 'modified' } });
    expect(approvalIn(APPROVAL_A)).toMatchObject({ status: 'modified', decided_by: c.member, edited_payload: expect.objectContaining({ title: 'Football' }) });
    expect(mocks.executed).toEqual([{ name: 'calendar.createEvent', args: expect.objectContaining({ title: 'Football' }) }]);
    expect(approvalIn(APPROVAL_B)).toEqual(theirs);
  });

  it.each(NON_MANAGERS.map((c) => [c.name, c] as const))('ACTION-38840F5B33E9 a %s cannot edit and approve, and the request is untouched', async (_n, c) => {
    signInAs(c);
    const before = structuredClone(db.table('approval_requests'));

    const res = await editAndApproveApproval({ id: APPROVAL_A, edits: { title: 'Football' } });

    expect(res).toMatchObject({ ok: false, code: 'denied', error: 'Only a parent or adult in the family can decide approvals.' });
    expect(db.table('approval_requests')).toEqual(before);
    expect(mocks.executed).toEqual([]);
  });

  it.each(MANAGERS.map((c) => [c.name, c] as const))('ACTION-38840F5B33E9 a %s of household A cannot edit household B’s request', async (_n, c) => {
    signInAs(c);
    const before = structuredClone(db.table('approval_requests'));

    const res = await editAndApproveApproval({ id: APPROVAL_B, edits: { title: 'Football' } });

    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(db.table('approval_requests')).toEqual(before);
    expect(mocks.executed).toEqual([]);
  });

  it('ACTION-38840F5B33E9 a signed-out caller is sent to sign in and nothing is edited', async () => {
    const before = structuredClone(db.table('approval_requests'));
    await expect(editAndApproveApproval({ id: APPROVAL_A, edits: { title: 'Football' } })).rejects.toThrow('redirect:/login');
    expect(db.table('approval_requests')).toEqual(before);
  });
});
