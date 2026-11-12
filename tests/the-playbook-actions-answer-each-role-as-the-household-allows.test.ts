// The three Family Playbook actions, called the way the page calls them, by
// every household role, with valid input and with another family's ids.
//
// THE POLICY, from the sources rather than from the action:
//   - Accepting a suggestion writes a confirmed `family_facts` row for the whole
//     household, and dismissing one is permanent (a dismissed signature is never
//     re-offered). Both are a parent's or adult's call: `confirmFact` and
//     `forgetFact(kind: 'suggestion')` refuse anyone else (lib/services/memory
//     `canManage`, index.ts:79), and the action's own comments say why
//     (playbook-actions.ts, SRV-C02). The database is looser — 0126 grants every
//     member all four verbs on `family_playbook_suggestions` — so the service is
//     the boundary these cases pin.
//   - Refreshing mines the household and inserts NEW suggestions as
//     'suggested' only; it never changes an accepted or dismissed one. 0126's
//     `is_family_member` insert policy is the live rule, the page offers the
//     Refresh button to every member (components/modules/playbook-module.tsx),
//     and navigation lists the Playbook at minLevel 0. Every member but a guest
//     is pinned as allowed; a guest is reported for an owner decision (0126 lets
//     a guest insert; lib/constants/roles.ts describes a guest as viewing).
//   - The family is the session's: every read and write carries the active
//     family, and another family's suggestion is "not found".
//
// No table here carries 0464's guest guard, so no guard is modelled.
// Mocked: the session, the server client factory and the translator (the real
// en-US source catalogue). The clock is real: nothing asserted depends on it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { CALLERS, FAMILY_A, FAMILY_B, memberRows, userIdOf, type Caller } from './helpers/role-callers';

const harness = vi.hoisted(() => ({
  caller: 'parent' as string | null,
  db: null as unknown,
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/supabase/auth', async () => {
  const callers = await import('./helpers/role-callers');
  return {
    requireUserContext: async () => (harness.caller
      ? callers.contextFor(harness.caller as Caller)
      : callers.signedOut()),
  };
});
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' }, source: 'default', messages: SOURCE_MESSAGES }),
  };
});

const { acceptSuggestionAction, dismissSuggestionAction, refreshPlaybookAction } =
  await import('@/app/(app)/dashboard/playbook/playbook-actions');

const CARD_A = 'a0000000-0000-4000-8000-0000000c0001';
const CARD_B = 'b0000000-0000-4000-8000-0000000c0001';
const NOT_FOUND = 'That suggestion could not be found.';
const ONLY_MANAGERS_CONFIRM = 'Only a parent or adult can confirm what Bubaly remembers.';
const ONLY_MANAGERS_DISMISS = 'Only a parent or adult can dismiss what Bubaly noticed.';

const MANAGERS: Caller[] = ['parent', 'adult'];
const NON_MANAGERS: Caller[] = CALLERS.filter((c) => c !== 'parent' && c !== 'adult');
/** Every caller pinned for Refresh; a guest is the owner's decision and is left out. */
const REFRESHERS: Caller[] = CALLERS.filter((c) => c !== 'guest');

let db: InMemorySupabase;
const cards = () => db.table('family_playbook_suggestions');
const card = (id: string) => cards().find((row) => row.id === id) as Row | undefined;
const facts = () => db.table('family_facts');
const snapshot = () => structuredClone({ cards: cards(), facts: facts() });

function suggestion(id: string, family: string, value: string): Row {
  return {
    id, family_id: family, member_id: null, category: 'preference', label: 'Grocery staple', value,
    evidence: 'Added to the list 5 times', confidence: 70, signature: `grocery:${value.toLowerCase()}`,
    status: 'suggested', fact_id: null, expires_at: null, created_by: userIdOf('parent', family),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ uniques: { family_playbook_suggestions: [['family_id', 'signature']] } });
  harness.db = db;
  harness.caller = 'parent';
  db.seed('family_members', [...memberRows(FAMILY_A), ...memberRows(FAMILY_B)]);
  db.seed('family_playbook_suggestions', [suggestion(CARD_A, FAMILY_A, 'Oat milk'), suggestion(CARD_B, FAMILY_B, 'Rye bread')]);
});

const as = (caller: Caller | null) => { harness.caller = caller; };

describe('acceptSuggestionAction (ACTION-749B60DB8A71)', () => {
  it.each(MANAGERS)('ACTION-749B60DB8A71 a %s confirms a card into one family fact and marks it accepted', async (caller) => {
    as(caller);
    expect(await acceptSuggestionAction({ id: CARD_A })).toEqual({ ok: true });

    expect(facts()).toEqual([expect.objectContaining({
      family_id: FAMILY_A, label: 'Grocery staple', value: 'Oat milk', source: 'ai_inferred', created_by: userIdOf(caller),
    })]);
    expect(card(CARD_A)).toEqual(expect.objectContaining({ status: 'accepted', fact_id: facts()[0].id }));
    expect(card(CARD_B)?.status).toBe('suggested');
  });

  it.each(NON_MANAGERS)('ACTION-749B60DB8A71 a %s is refused, and no fact is written', async (caller) => {
    as(caller);
    const before = snapshot();
    expect(await acceptSuggestionAction({ id: CARD_A })).toEqual({ ok: false, error: ONLY_MANAGERS_CONFIRM });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-749B60DB8A71 a signed-out caller is sent to sign in and nothing is written', async () => {
    as(null);
    const before = snapshot();
    await expect(acceptSuggestionAction({ id: CARD_A })).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toEqual(before);
  });

  it("ACTION-749B60DB8A71 another family's card is not found, and neither family gains a fact", async () => {
    const before = snapshot();
    expect(await acceptSuggestionAction({ id: CARD_B })).toEqual({ ok: false, error: NOT_FOUND });
    expect(snapshot()).toEqual(before);
  });
});

describe('dismissSuggestionAction (ACTION-02925240D5D8)', () => {
  it.each(MANAGERS)('ACTION-02925240D5D8 a %s dismisses a card of their own family', async (caller) => {
    as(caller);
    expect(await dismissSuggestionAction({ id: CARD_A })).toEqual({ ok: true });
    expect(card(CARD_A)?.status).toBe('dismissed');
    expect(card(CARD_B)?.status).toBe('suggested');
    expect(facts()).toEqual([]);
  });

  it.each(NON_MANAGERS)('ACTION-02925240D5D8 a %s is refused and the card stays open for the parents', async (caller) => {
    as(caller);
    const before = snapshot();
    expect(await dismissSuggestionAction({ id: CARD_A })).toEqual({ ok: false, error: ONLY_MANAGERS_DISMISS });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-02925240D5D8 a signed-out caller is sent to sign in and nothing is written', async () => {
    as(null);
    const before = snapshot();
    await expect(dismissSuggestionAction({ id: CARD_A })).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toEqual(before);
  });

  it("ACTION-02925240D5D8 another family's card is not found and stays open", async () => {
    const before = snapshot();
    expect(await dismissSuggestionAction({ id: CARD_B })).toEqual({ ok: false, error: NOT_FOUND });
    expect(snapshot()).toEqual(before);
  });
});

describe('refreshPlaybookAction (ACTION-FB26742D7D6C)', () => {
  beforeEach(() => {
    // Four adds of the same thing is a staple (lib/playbook/learn.ts MIN.grocery).
    // Family A buys bananas; family B buys kale, which A must never learn.
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    db.seed('grocery_items', [
      ...[1, 2, 3, 4].map((n) => ({ family_id: FAMILY_A, name: 'Bananas', created_at: recent, id: `a0000000-0000-4000-8000-00000000900${n}` })),
      ...[1, 2, 3, 4].map((n) => ({ family_id: FAMILY_B, name: 'Kale', created_at: recent, id: `b0000000-0000-4000-8000-00000000900${n}` })),
    ]);
  });

  it.each(REFRESHERS)('ACTION-FB26742D7D6C a %s stocks their own family\'s inbox with one new open card', async (caller) => {
    as(caller);
    expect(await refreshPlaybookAction()).toEqual({ ok: true, added: 1 });

    const learned = cards().filter((row) => row.signature === 'grocery:bananas');
    expect(learned).toEqual([expect.objectContaining({
      family_id: FAMILY_A, value: 'Bananas', status: 'suggested', created_by: userIdOf(caller),
    })]);
    expect(card(CARD_A)?.status).toBe('suggested');
  });

  it("ACTION-FB26742D7D6C learns nothing from another family's list, and leaves their inbox alone", async () => {
    const before = structuredClone(cards().filter((row) => row.family_id === FAMILY_B));
    await refreshPlaybookAction();

    expect(cards().filter((row) => row.value === 'Kale')).toEqual([]);
    expect(cards().filter((row) => row.family_id === FAMILY_B)).toEqual(before);
  });

  it('ACTION-FB26742D7D6C never reopens a card the family already decided', async () => {
    db.seed('family_playbook_suggestions', [{ ...suggestion('a0000000-0000-4000-8000-0000000c0002', FAMILY_A, 'Bananas'), signature: 'grocery:bananas', status: 'dismissed' }]);
    as('child');
    expect(await refreshPlaybookAction()).toEqual({ ok: true, added: 0 });
    expect(cards().filter((row) => row.signature === 'grocery:bananas')).toEqual([expect.objectContaining({ status: 'dismissed' })]);
  });

  it('ACTION-FB26742D7D6C a signed-out caller is sent to sign in and nothing is written', async () => {
    as(null);
    const before = snapshot();
    await expect(refreshPlaybookAction()).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toEqual(before);
  });
});
