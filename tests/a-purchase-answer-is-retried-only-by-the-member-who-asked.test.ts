// "Try again" on a private purchase answer, called as each member of a
// household, as a member who did not ask, and with another household's approval.
//
// THE POLICY. The answer to "should we buy this?" is the REQUESTER's: it is
// delivered only into their own conversation, and a retry is "only by its
// owner, only for this specific read, and only against a persisted AI approval
// that has been granted" (lib/services/purchases/private-result.ts
// `retryPrivatePurchaseAnswer`, `ownedApproval`: the approval is read by id,
// the caller's family AND `requested_by_member_id = the caller`). The page
// offers the button only on the requester's own result page
// (app/(app)/dashboard/assistant/purchases/[approvalId]/page.tsx). No role
// may retry someone else's; any role that asked may retry its own, and the
// tool then runs under the requester's role, not a wider one.
//
// WHAT IS ASSERTED: the redirect the action answers with (the result page, or
// `?retry=failed`) AND what was written — the private answer in ai_messages,
// the conversation it lives in, and the approval's execution stamp. A
// non-owner's or another household's retry writes none of them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { CHILD_LOGIN_EMAIL_DOMAIN } from '@/lib/onboarding/child-login';

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  ctx: null as unknown,
  revalidatePath: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db, createServiceClient: () => mocks.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    if (!mocks.ctx) throw new Error('redirect:/login');
    return mocks.ctx;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { retryPurchaseAnswer } = await import('@/app/(app)/dashboard/assistant/purchases/[approvalId]/actions');

const FAMILY_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const FAMILY_B = 'bbbbbbbb-0000-4000-8000-000000000001';
const APPROVAL = 'eeeeeeee-0000-4000-8000-00000000000a';
const APPROVAL_B = 'eeeeeeee-0000-4000-8000-00000000000b';
const REQUEST = 'ffffffff-0000-4000-8000-00000000000a';
const REQUEST_B = 'ffffffff-0000-4000-8000-00000000000b';
const B_MEMBER = 'bbbbbbbb-1111-4000-8000-000000000001';
const B_USER = 'bbbbbbbb-2222-4000-8000-000000000001';

const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
type Caller = { role: string; member: string; user: string; email: string; name: string };
const CALLERS: Caller[] = [
  ...ROLES.map((role, i) => ({
    role, name: role, member: `aaaaaaaa-1111-4000-8000-00000000000${i + 1}`, user: `aaaaaaaa-2222-4000-8000-00000000000${i + 1}`, email: `${role}@example.com`,
  })),
  { role: 'child', name: 'child (kid login)', member: 'aaaaaaaa-1111-4000-8000-000000000009', user: 'aaaaaaaa-2222-4000-8000-000000000009', email: `kid@${CHILD_LOGIN_EMAIL_DOMAIN}` },
];
const PARENT = CALLERS[0];
const PAGE = `/dashboard/assistant/purchases/${APPROVAL}`;

let db: InMemorySupabase;

function signInAs(c: Caller) {
  mocks.ctx = {
    user: { id: c.user, email: c.email },
    active: { familyId: FAMILY_A, role: c.role, member: { id: c.member }, family: { id: FAMILY_A, timezone: 'UTC' } },
  };
}

const purchase = { name: 'finances.advisePurchase', args: { text: 'drill', priceDollars: 20, budgetCategory: 'tools' } };

/** Household A's approved purchase question, asked by `asker`; household B has its own. */
function seed(asker: Caller) {
  db.seed('family_members', [
    ...CALLERS.map((c) => ({ id: c.member, family_id: FAMILY_A, user_id: c.user, role: c.role, is_active: true })),
    { id: B_MEMBER, family_id: FAMILY_B, user_id: B_USER, role: 'parent', is_active: true },
  ]);
  db.seed('ai_requests', [
    { id: REQUEST, family_id: FAMILY_A, requested_by: asker.user, requested_by_member_id: asker.member, conversation_id: null },
    { id: REQUEST_B, family_id: FAMILY_B, requested_by: B_USER, requested_by_member_id: B_MEMBER, conversation_id: null },
  ]);
  db.seed('approval_requests', [
    { id: APPROVAL, family_id: FAMILY_A, requested_by_kind: 'ai', requested_by_member_id: asker.member, request_id: REQUEST, status: 'approved', payload_kind: 'tool', payload: purchase, executed_at: null, execution_result: null },
    { id: APPROVAL_B, family_id: FAMILY_B, requested_by_kind: 'ai', requested_by_member_id: B_MEMBER, request_id: REQUEST_B, status: 'approved', payload_kind: 'tool', payload: purchase, executed_at: null, execution_result: null },
  ]);
  db.seed('inventory_items', [{ id: 'c1c1c1c1-0000-4000-8000-000000000001', family_id: FAMILY_A, name: 'Cordless drill', quantity: 1, category: 'tools', tags: [] }]);
}

const written = () => structuredClone({
  messages: db.table('ai_messages'),
  conversations: db.table('ai_conversations'),
  approvals: db.table('approval_requests'),
});

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase({ uniques: { ai_conversations: [['id']], ai_messages: [['id']] } });
  mocks.db = db;
  mocks.ctx = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('retryPurchaseAnswer', () => {
  it.each(CALLERS.map((c) => [c.name, c] as const))('ACTION-D7CE64DF3169 a %s who asked gets their answer delivered into their own conversation', async (_n, c) => {
    seed(c);
    signInAs(c);

    await expect(retryPurchaseAnswer(APPROVAL)).rejects.toThrow(`redirect:${PAGE}`);

    expect(db.table('ai_conversations')).toEqual([expect.objectContaining({ id: APPROVAL, family_id: FAMILY_A, user_id: c.user })]);
    expect(db.table('ai_messages')).toEqual([expect.objectContaining({
      id: APPROVAL, family_id: FAMILY_A, conversation_id: APPROVAL, request_id: REQUEST, role: 'assistant',
      structured_content: { kind: 'purchase_advice_result', approvalId: APPROVAL },
    })]);
    expect(typeof db.table('approval_requests').find((r) => r.id === APPROVAL)?.executed_at).toBe('string');
    expect(db.table('approval_requests').find((r) => r.id === APPROVAL_B)).toMatchObject({ executed_at: null });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(PAGE);
  });

  it.each(CALLERS.filter((c) => c !== PARENT).map((c) => [c.name, c] as const))('ACTION-D7CE64DF3169 a parent cannot retry the answer a %s asked for, and nothing is delivered', async (_n, asker) => {
    seed(asker);
    signInAs(PARENT);
    const before = written();

    await expect(retryPurchaseAnswer(APPROVAL)).rejects.toThrow(`redirect:${PAGE}?retry=failed`);

    expect(written()).toEqual(before);
    expect(db.table('ai_messages')).toEqual([]);
  });

  it.each(CALLERS.filter((c) => c !== PARENT).map((c) => [c.name, c] as const))('ACTION-D7CE64DF3169 a %s cannot retry the answer a parent asked for, and nothing is delivered', async (_n, caller) => {
    seed(PARENT);
    signInAs(caller);
    const before = written();

    await expect(retryPurchaseAnswer(APPROVAL)).rejects.toThrow(`redirect:${PAGE}?retry=failed`);

    expect(written()).toEqual(before);
  });

  it.each(CALLERS.map((c) => [c.name, c] as const))('ACTION-D7CE64DF3169 a %s of household A cannot retry household B’s answer, and neither household changes', async (_n, c) => {
    seed(c);
    signInAs(c);
    const before = written();

    await expect(retryPurchaseAnswer(APPROVAL_B)).rejects.toThrow(`redirect:/dashboard/assistant/purchases/${APPROVAL_B}?retry=failed`);

    expect(written()).toEqual(before);
  });

  it('ACTION-D7CE64DF3169 household B’s approval naming the caller’s member id as its requester is still not theirs to retry', async () => {
    // A row in another family that names this caller's member id (copied,
    // forged or stale): ownership is family AND member, never member alone.
    seed(PARENT);
    Object.assign(db.table('approval_requests').find((r) => r.id === APPROVAL_B)!, { requested_by_member_id: PARENT.member });
    Object.assign(db.table('ai_requests').find((r) => r.id === REQUEST_B)!, { requested_by: PARENT.user, requested_by_member_id: PARENT.member });
    signInAs(PARENT);
    const before = written();

    await expect(retryPurchaseAnswer(APPROVAL_B)).rejects.toThrow(`redirect:/dashboard/assistant/purchases/${APPROVAL_B}?retry=failed`);

    expect(written()).toEqual(before);
  });

  it('ACTION-D7CE64DF3169 a signed-out caller is sent to sign in and nothing is delivered', async () => {
    seed(PARENT);
    const before = written();
    await expect(retryPurchaseAnswer(APPROVAL)).rejects.toThrow('redirect:/login');
    expect(written()).toEqual(before);
  });
});
