// N15 — the Reasoning Graph page scores how complete the household model is
// on the VIEWER's session. 0481's family_places_select returns a guest no
// places, so for a guest in a family with a saved home the card said Bubaly
// did not know "Where home is" (linking to /dashboard/locator, which a guest is
// sent away from) and lowered the score. lib/twin/completeness-server.ts's own
// comment names this misreport as the one thing it must not do. "Where the
// money sits" is left out of a guest's score too, but for a different reason:
// the released schema DOES return a guest the household's financial_accounts
// (financial_accounts_select is membership only; the held 0509 would close
// it), and the slot links to /dashboard/family-cfo, which a guest is also sent
// away from (GUEST_WITHHELD_PREFIXES).
//
// Driven through the real page and the real loader over the in-memory
// database, which stands in for each viewer's session. For the guest it holds
// the rows RLS returns them on the released schema: no places, and the
// household's account.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

const FAMILY = '00000000-0000-4000-8000-00000000d501';
const h = vi.hoisted(() => ({ db: null as unknown, role: 'guest' }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'u-1', email: null }, memberships: [],
    active: { familyId: FAMILY, role: h.role, member: { id: 'm-1' }, family: { id: FAMILY, name: 'Fixture', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
// The graph itself and its summary are other tests' subject.
vi.mock('@/lib/reasoning/context', () => ({ loadFamilyContext: async () => ({ stats: { entities: 0 }, orphanCount: 0 }), contextSummary: () => '' }));
vi.mock('@/components/modules/graph-module', () => ({ GraphModule: () => null }));

const { default: GraphPage } = await import('@/app/(app)/dashboard/graph/page');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: InMemorySupabase;

beforeEach(() => {
  db = createInMemorySupabase();
  h.db = db;
  db.seed('family_members', [{ id: 'm-1', family_id: FAMILY, display_name: 'Grandma', birthday: '1950-04-02', is_active: true }]);
  db.seed('family_routines', [{ id: 'r-1', family_id: FAMILY, member_id: 'm-1', status: 'active' }]);
});

const page = async () => textOf(await renderServerPage(await GraphPage()));

describe('the graph completeness card', () => {
  it('does not ask a guest for the home place their session cannot read, nor score them on the accounts', async () => {
    h.role = 'guest';
    // What the guest's session reads of financial_accounts on 0001-0486.
    db.seed('financial_accounts', [{ id: 'acct-1', family_id: FAMILY }]);
    const text = await page();

    expect(text).not.toContain(t('graphCompleteness.whereHomeIs'));
    expect(text).not.toContain(t('graphCompleteness.whereTheMoneySits'));
    // Scored without both slots: members and routines (2), and one member's
    // three. Not 6 of 6: the account the guest reads does not score either.
    expect(text).toContain(t('graphCompleteness.nOfNFactsFilledIn', { filled: 5, expected: 5 }));
  });

  it('control: still asks a parent for them when the family has neither', async () => {
    h.role = 'parent';
    const text = await page();

    expect(text).toContain(t('graphCompleteness.whereHomeIs'));
    expect(text).toContain(t('graphCompleteness.whereTheMoneySits'));
    expect(text).toContain(t('graphCompleteness.nOfNFactsFilledIn', { filled: 5, expected: 7 }));
  });
});
