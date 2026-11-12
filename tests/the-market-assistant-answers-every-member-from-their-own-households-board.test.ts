// Call-level role tests for askMarketAssistantAction
// (app/(app)/marketplace/assistant-actions.ts), Register B row ACTION-BAA4633EC108.
//
// THE POLICY, from the sources rather than from the action:
//   - The assistant sits in the right rail of /marketplace for every reader
//     (app/(app)/marketplace/page.tsx:385, no role condition); /marketplace is
//     plan level 0 and not manager-only (lib/constants/navigation.ts:173) and is
//     not a guest-withheld area (lib/auth/guest-scope.ts). It writes no
//     household row. So every role may ask, and is answered.
//   - Its answer is grounded in the asker's OWN household's open board: both
//     reads are `.eq('family_id', familyId)` (assistant-actions.ts:62-77).
//     Another family's listings are not part of what it tells the model.
//   - The model tier is metered: every member's request goes through the
//     family's monthly AI allowance (lib/server/ai-access.ts assertAIAllowance;
//     the owner's F19 decision quoted at assistant-actions.ts:96-100). A family
//     past it still gets the grounded answer, which reaches no provider.
//   - Every model door is rate-limited per user (assistant-actions.ts:52-58).
//
// The model itself cannot run here: `resolveProvider` is replaced with a fake
// that records the prompt it is handed, and withAiRequest with a pass-through,
// so every gate up to the provider call is the real code.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  isAIConfigured: vi.fn(),
  resolveProvider: vi.fn(),
  complete: vi.fn(),
  assertAIAllowance: vi.fn(),
  enforceAIRateLimit: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  const messages = getMessages('en-US');
  return {
    getLocaleContext: async () => ({ locale: localeOrDefault('en-US'), source: 'default', messages }),
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params),
  };
});
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: mocks.isAIConfigured,
  resolveProvider: mocks.resolveProvider,
}));
vi.mock('@/lib/server/ai-access', () => ({ assertAIAllowance: mocks.assertAIAllowance }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: mocks.enforceAIRateLimit }));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: async (_scope: unknown, _meta: unknown, run: (obs: { used: () => void; failed: () => void }) => Promise<string>) =>
    run({ used: () => {}, failed: () => {} }),
}));

const { askMarketAssistantAction } = await import('@/app/(app)/marketplace/assistant-actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const FAMILY_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const FAMILY_B = 'bbbbbbbb-0000-4000-8000-000000000001';
const A_SIBLING = 'aaaaaaaa-0000-4000-8000-0000000000f1';
const B_SELLER = 'bbbbbbbb-0000-4000-8000-0000000000b1';

const MEMBER_IDS: Record<string, string> = {
  parent: 'aaaaaaaa-0000-4000-8000-0000000000a1',
  adult: 'aaaaaaaa-0000-4000-8000-0000000000a2',
  teen: 'aaaaaaaa-0000-4000-8000-0000000000a3',
  child: 'aaaaaaaa-0000-4000-8000-0000000000a4',
  kid: 'aaaaaaaa-0000-4000-8000-0000000000a5',
  caregiver: 'aaaaaaaa-0000-4000-8000-0000000000a6',
  guest: 'aaaaaaaa-0000-4000-8000-0000000000a7',
};
type Role = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';

let db: InMemorySupabase;

function signInAs(role: Role, kid = false) {
  const id = MEMBER_IDS[kid ? 'kid' : role];
  const userId = `user-${role}${kid ? '-kid' : ''}`;
  mocks.requireUserContext.mockResolvedValue({
    user: { id: userId, email: kid ? `${role}@kids.bubaly.app` : `${role}@example.com` },
    memberships: [],
    active: { familyId: FAMILY_A, family: { id: FAMILY_A, timezone: 'UTC' }, role, member: { id, family_id: FAMILY_A, display_name: role } },
  });
  return { id, userId };
}

const listing = (id: string, familyId: string, memberId: string, over: Record<string, unknown> = {}) => ({
  id, family_id: familyId, member_id: memberId, title: `Listing ${id}`, kind: 'sell', category: 'toys',
  condition: null, price_cents: 1_000, rent_period: null, status: 'available', ...over,
});

const everything = () => structuredClone({
  listings: db.table('marketplace_listings'),
  offers: db.table('marketplace_offers'),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  mocks.createServer.mockImplementation(async () => db);
  mocks.isAIConfigured.mockResolvedValue(false);
  mocks.assertAIAllowance.mockResolvedValue({ ok: true });
  mocks.enforceAIRateLimit.mockResolvedValue({ ok: true });
  mocks.complete.mockResolvedValue({ text: 'A model answer.', usage: { inputTokens: 1, outputTokens: 1 } });
  mocks.resolveProvider.mockResolvedValue({ model: 'fake-model', complete: mocks.complete });
  // Household A: one listing each for every member, plus a sibling's. Household B: three of its own,
  // one of them a request whose title must never reach A's model prompt.
  db.seed('marketplace_listings', [
    ...Object.values(MEMBER_IDS).map((m) => listing(`a-${m.slice(-2)}`, FAMILY_A, m)),
    listing('a-sib', FAMILY_A, A_SIBLING),
    listing('b-1', FAMILY_B, B_SELLER),
    listing('b-2', FAMILY_B, B_SELLER),
    listing('b-3', FAMILY_B, B_SELLER, { kind: 'wanted', title: 'Household B wants a tandem bike' }),
  ]);
  // An open offer from the sibling on every member's listing.
  db.seed('marketplace_offers', Object.values(MEMBER_IDS).map((m) => ({
    id: `o-${m.slice(-2)}`, family_id: FAMILY_A, listing_id: `a-${m.slice(-2)}`, status: 'open', member_id: A_SIBLING,
  })));
});

const ASKERS: { label: string; role: Role; kid: boolean }[] = [
  { label: 'parent', role: 'parent', kid: false },
  { label: 'adult', role: 'adult', kid: false },
  { label: 'teen', role: 'teen', kid: false },
  { label: 'child', role: 'child', kid: false },
  { label: 'child on a kid login', role: 'child', kid: true },
  { label: 'caregiver', role: 'caregiver', kid: false },
  { label: 'guest', role: 'guest', kid: false },
];

describe('ACTION-BAA4633EC108 askMarketAssistantAction', () => {
  it.each(ASKERS)('ACTION-BAA4633EC108 a $label is answered from their own listings, and nothing is written', async ({ role, kid }) => {
    const { userId } = signInAs(role, kid);
    const before = everything();

    const answer = await askMarketAssistantAction('How am I doing?');

    expect(answer).toMatchObject({ ok: true, source: 'engine', reply: 'You have 1 listing up and 1 open offer waiting on you.' });
    expect(mocks.enforceAIRateLimit).toHaveBeenCalledWith(db, `ai-requests:${userId}`, { limit: 20, windowMs: 60_000 });
    expect(everything()).toEqual(before);
  });

  it.each(ASKERS)('ACTION-BAA4633EC108 a $label’s model prompt holds household A’s board and none of household B’s', async ({ role, kid }) => {
    signInAs(role, kid);
    mocks.isAIConfigured.mockResolvedValue(true);

    const answer = await askMarketAssistantAction('What is selling?');

    expect(answer).toMatchObject({ ok: true, source: 'llm', reply: 'A model answer.' });
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    const system = String(mocks.complete.mock.calls[0][0].system);
    // Seven members' listings and the sibling's: eight, never eleven.
    expect(system).toContain('LIVE BOARD (8 available listings)');
    expect(system).not.toContain('Household B wants a tandem bike');
  });

  it('ACTION-BAA4633EC108 a family past its AI allowance gets the grounded answer and no provider call', async () => {
    signInAs('teen');
    mocks.isAIConfigured.mockResolvedValue(true);
    mocks.assertAIAllowance.mockResolvedValue({ ok: false, status: 402, code: 'quota', error: 'Over the monthly allowance.' });

    const answer = await askMarketAssistantAction('How am I doing?');

    expect(answer).toMatchObject({ ok: true, source: 'engine', reply: 'You have 1 listing up and 1 open offer waiting on you.' });
    expect(mocks.assertAIAllowance).toHaveBeenCalledTimes(1);
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('ACTION-BAA4633EC108 the allowance is checked for the asker’s own household', async () => {
    signInAs('child');
    mocks.isAIConfigured.mockResolvedValue(true);
    await askMarketAssistantAction('What is selling?');
    expect(mocks.assertAIAllowance.mock.calls[0][0]).toMatchObject({ active: { familyId: FAMILY_A, role: 'child' } });
  });

  it('ACTION-BAA4633EC108 a rate-limited asker is refused before the board is read or a model is asked', async () => {
    signInAs('parent');
    mocks.isAIConfigured.mockResolvedValue(true);
    mocks.enforceAIRateLimit.mockResolvedValue({ ok: false });
    const from = vi.spyOn(db, 'from');

    expect(await askMarketAssistantAction('What is selling?')).toEqual({ ok: false, error: t('inboxActions.tooManyRequestsRightNow') });

    expect(from).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('ACTION-BAA4633EC108 an empty question is answered with a prompt, before the caller is even looked up', async () => {
    expect(await askMarketAssistantAction('   ')).toEqual({ ok: false, error: t('assistantActions.askMeAnythingAboutThe') });
    expect(mocks.requireUserContext).not.toHaveBeenCalled();
    expect(mocks.enforceAIRateLimit).not.toHaveBeenCalled();
  });
});
