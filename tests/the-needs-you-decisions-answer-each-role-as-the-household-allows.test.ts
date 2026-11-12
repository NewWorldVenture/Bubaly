// Call-level role tests for app/(app)/dashboard/needs-you/actions.ts (Register B
// ACTION-2DCA2954497B confirmFactSuggestionAction, ACTION-AA44E6041AFD
// dismissFactSuggestionAction, ACTION-3C3E8B92B091 archiveInboxMessageAction).
//
// THE POLICY, from the sources:
//   - The action's own header: kids and guests see the list read-only and every
//     action re-checks the role on the server; the page passes
//     `canDecide={manager}` (app/(app)/dashboard/needs-you/page.tsx:54,187).
//   - The services agree: confirmFact and forgetFact({kind:'suggestion'}) take
//     `canManage` (lib/services/memory/index.ts:79-81, :771, :904), and the
//     inbox's setInboxMessageStatus takes `mayFile` = isManager
//     (lib/services/inbox/index.ts:46-48, :176).
//   - isManager = parent or adult (lib/constants/roles.ts).
//   - family_playbook_suggestions' RLS is still membership-wide (0126), which is
//     wider than the action, not narrower: nothing the action allows is denied.
//   - family_inbox_messages has no client write policy (0214); the archive runs
//     on the SERVICE client, so its family filter is the only family boundary.
// So a parent and an adult decide; a teen, a child (on a kid login too), a
// caregiver and a guest are refused with the action's sentence and nothing
// moves. Every id from another family answers "not found" and moves nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY_A = '00000000-0000-4000-8000-00000000000a';
const FAMILY_B = '00000000-0000-4000-8000-00000000000b';
const SUGGESTION_A = '00000000-0000-4000-8000-0000000005a1';
const SUGGESTION_B = '00000000-0000-4000-8000-0000000005b1';
const MESSAGE_A = '00000000-0000-4000-8000-0000000006a1';
const MESSAGE_B = '00000000-0000-4000-8000-0000000006b1';
const NOT_A_MANAGER = 'needsYouActions.onlyAParentOrAdultCan';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  createServiceClient: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: mocks.createServer,
  createServiceClient: mocks.createServiceClient,
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const { confirmFactSuggestionAction, dismissFactSuggestionAction, archiveInboxMessageAction } =
  await import('@/app/(app)/dashboard/needs-you/actions');

type Role = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';
const REFUSED = ['teen', 'child', 'caregiver', 'guest'] as const;

let db: InMemorySupabase;
let seeded: { suggestions: unknown[]; messages: unknown[] };

function signedInAs(role: Role, opts: { kidLogin?: boolean } = {}) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `user-${role}`, email: opts.kidLogin ? `kid-${role}@kids.bubaly.app` : `${role}@example.com` },
    memberships: [],
    active: {
      familyId: FAMILY_A,
      family: { id: FAMILY_A, timezone: 'America/New_York' },
      role,
      member: { id: `member-${role}` },
    },
  });
}

const suggestion = (id: string, family: string) => ({
  id,
  family_id: family,
  member_id: null,
  category: 'preferences',
  label: `Pizza night is Friday (${family === FAMILY_A ? 'A' : 'B'})`,
  value: 'Friday',
  evidence: 'Three Fridays in a row',
  confidence: 0.8,
  expires_at: null,
  signature: `playbook:pizza:${family}`,
  status: 'suggested',
  fact_id: null,
});

const message = (id: string, family: string) => ({
  id,
  family_id: family,
  channel: 'email',
  subject: `Field trip form (${family === FAMILY_A ? 'A' : 'B'})`,
  status: 'new',
});

const snapshot = () => structuredClone({
  suggestions: db.table('family_playbook_suggestions'),
  messages: db.table('family_inbox_messages'),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  db.seed('family_playbook_suggestions', [suggestion(SUGGESTION_A, FAMILY_A), suggestion(SUGGESTION_B, FAMILY_B)]);
  db.seed('family_inbox_messages', [message(MESSAGE_A, FAMILY_A), message(MESSAGE_B, FAMILY_B)]);
  seeded = snapshot();
  mocks.createServer.mockResolvedValue(db);
  mocks.createServiceClient.mockReturnValue(db);
});

const suggestionRow = (id: string) => db.table('family_playbook_suggestions').find((r) => r.id === id);
const messageRow = (id: string) => db.table('family_inbox_messages').find((r) => r.id === id);

describe('ACTION-2DCA2954497B confirmFactSuggestionAction', () => {
  it.each(['parent', 'adult'] as const)('ACTION-2DCA2954497B a %s confirms the card into one family fact', async (role) => {
    signedInAs(role);
    await expect(confirmFactSuggestionAction(SUGGESTION_A)).resolves.toEqual({ ok: true });
    const facts = db.table('family_facts');
    expect(facts.map(({ family_id, label, value, category, source, created_by }) =>
      ({ family_id, label, value, category, source, created_by }))).toEqual([{
      family_id: FAMILY_A, label: 'Pizza night is Friday (A)', value: 'Friday', category: 'preferences',
      source: 'ai_inferred', created_by: `user-${role}`,
    }]);
    expect(suggestionRow(SUGGESTION_A)).toMatchObject({ status: 'accepted', fact_id: facts[0].id });
    expect(suggestionRow(SUGGESTION_B)).toEqual(seeded.suggestions[1]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/needs-you');
  });

  it.each(REFUSED)('ACTION-2DCA2954497B a %s is refused and nothing is written', async (role) => {
    signedInAs(role);
    await expect(confirmFactSuggestionAction(SUGGESTION_A)).resolves.toEqual({ ok: false, error: NOT_A_MANAGER });
    expect(db.table('family_facts')).toEqual([]);
    expect(snapshot()).toEqual(seeded);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-2DCA2954497B a child on a kid login is refused and nothing is written', async () => {
    signedInAs('child', { kidLogin: true });
    await expect(confirmFactSuggestionAction(SUGGESTION_A)).resolves.toEqual({ ok: false, error: NOT_A_MANAGER });
    expect(db.table('family_facts')).toEqual([]);
    expect(snapshot()).toEqual(seeded);
  });

  it("ACTION-2DCA2954497B a parent naming another family's card is told it is not found, and neither family changes", async () => {
    signedInAs('parent');
    await expect(confirmFactSuggestionAction(SUGGESTION_B))
      .resolves.toEqual({ ok: false, error: 'That suggestion could not be found.' });
    expect(db.table('family_facts')).toEqual([]);
    expect(snapshot()).toEqual(seeded);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-2DCA2954497B a signed-out caller is sent away and nothing is written', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT /login'));
    await expect(confirmFactSuggestionAction(SUGGESTION_A)).rejects.toThrow('NEXT_REDIRECT');
    expect(db.table('family_facts')).toEqual([]);
    expect(snapshot()).toEqual(seeded);
  });
});

describe('ACTION-AA44E6041AFD dismissFactSuggestionAction', () => {
  it.each(['parent', 'adult'] as const)('ACTION-AA44E6041AFD a %s dismisses the card and it is kept as dismissed', async (role) => {
    signedInAs(role);
    await expect(dismissFactSuggestionAction(SUGGESTION_A)).resolves.toEqual({ ok: true });
    expect(suggestionRow(SUGGESTION_A)).toMatchObject({ status: 'dismissed', fact_id: null });
    expect(suggestionRow(SUGGESTION_B)).toEqual(seeded.suggestions[1]);
    expect(db.table('family_facts')).toEqual([]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/needs-you');
  });

  it.each(REFUSED)('ACTION-AA44E6041AFD a %s is refused and nothing is written', async (role) => {
    signedInAs(role);
    await expect(dismissFactSuggestionAction(SUGGESTION_A)).resolves.toEqual({ ok: false, error: NOT_A_MANAGER });
    expect(snapshot()).toEqual(seeded);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-AA44E6041AFD a child on a kid login is refused and nothing is written', async () => {
    signedInAs('child', { kidLogin: true });
    await expect(dismissFactSuggestionAction(SUGGESTION_A)).resolves.toEqual({ ok: false, error: NOT_A_MANAGER });
    expect(snapshot()).toEqual(seeded);
  });

  it("ACTION-AA44E6041AFD a parent naming another family's card is told it is not found, and neither family changes", async () => {
    signedInAs('parent');
    await expect(dismissFactSuggestionAction(SUGGESTION_B))
      .resolves.toEqual({ ok: false, error: 'That suggestion could not be found.' });
    expect(snapshot()).toEqual(seeded);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-AA44E6041AFD a signed-out caller is sent away and nothing is written', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT /login'));
    await expect(dismissFactSuggestionAction(SUGGESTION_A)).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toEqual(seeded);
  });
});

describe('ACTION-3C3E8B92B091 archiveInboxMessageAction', () => {
  it.each(['parent', 'adult'] as const)('ACTION-3C3E8B92B091 a %s archives the message, which is kept', async (role) => {
    signedInAs(role);
    await expect(archiveInboxMessageAction(MESSAGE_A)).resolves.toEqual({ ok: true });
    expect(messageRow(MESSAGE_A)).toMatchObject({ status: 'archived', subject: 'Field trip form (A)' });
    expect(messageRow(MESSAGE_B)).toEqual(seeded.messages[1]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/contact-center');
  });

  it.each(REFUSED)('ACTION-3C3E8B92B091 a %s is refused and nothing is written', async (role) => {
    signedInAs(role);
    await expect(archiveInboxMessageAction(MESSAGE_A)).resolves.toEqual({ ok: false, error: NOT_A_MANAGER });
    expect(snapshot()).toEqual(seeded);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-3C3E8B92B091 a child on a kid login is refused and nothing is written', async () => {
    signedInAs('child', { kidLogin: true });
    await expect(archiveInboxMessageAction(MESSAGE_A)).resolves.toEqual({ ok: false, error: NOT_A_MANAGER });
    expect(snapshot()).toEqual(seeded);
  });

  it("ACTION-3C3E8B92B091 a parent naming another family's message is told it is not found, though the write runs on the service client", async () => {
    signedInAs('parent');
    await expect(archiveInboxMessageAction(MESSAGE_B))
      .resolves.toEqual({ ok: false, error: 'That message could not be found.' });
    expect(mocks.createServiceClient).toHaveBeenCalled();
    expect(snapshot()).toEqual(seeded);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-3C3E8B92B091 a signed-out caller is sent away and nothing is written', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT /login'));
    await expect(archiveInboxMessageAction(MESSAGE_A)).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toEqual(seeded);
  });
});
