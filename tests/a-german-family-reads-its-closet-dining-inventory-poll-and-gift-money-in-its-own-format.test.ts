// I18N-003 (finalaudit.md AQ-01), the family-modules group: Closet, Dining,
// Family Intelligence, Home Inventory, Relationship Helper and Group Voting.
//
// Every one of these used to write the currency symbol as TEXT —
//
//   `$${(cents / 100).toFixed(2)}`
//
// — so a German parent read "$2768.50": the American symbol position, no
// grouping, and a decimal POINT where they write a comma. Home Inventory was the
// half-fix, a locale swap on the number with the "$" still glued in front:
// "$2.769", which nobody writes.
//
// So this renders each REAL module under the reader's locale, the way the
// product mounts it (a LocaleProvider carrying that locale and that locale's
// catalogue), and asserts the string the reader sees. Only the data and browser
// boundaries are replaced — the realtime reads, the toast/router contexts, the
// server actions and the portal — never a formatter and never a catalogue.
// Revert any module to its hand-written "$" and its de-DE case fails.
//
// THE WORDS AROUND AN AMOUNT. Where an amount sat inside English, the whole
// phrase is now a catalogue key with the amount as a placeholder. The provider
// here gets the REAL catalogue and nothing under it, so a key the catalogue does
// not carry renders as the key and the case fails:
//   - en-US asserts the English sentence, typed out;
//   - de-DE asserts the de-DE catalogue's OWN sentence with the German amount in
//     it. The German wording is the translator's, so it is read from the
//     catalogue rather than typed here — and the de-DE catalogue must carry the
//     key itself, because an English fallback would pass the amount check while
//     a German parent read English.
// These cases are RED until the orchestrator's catalogue merge of this group's
// asks (and, for the voting conflict, the Decision Engine group's) lands, which
// happens in the same commit as this code.
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, getRawMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';
import { formatCents } from '@/lib/wallet/ledger';
import { categoryMeta } from '@/lib/inventory/finder';

const h = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  members: [] as { id: string; display_name: string; family_id: string }[],
  selfMember: null as { id: string; display_name: string; family_id: string } | null,
  openEveryModal: false,
}));

vi.mock('@/components/app/app-context', () => ({
  useApp: () => ({ familyId: 'fam-1', userId: 'user-1', members: h.members, selfMember: h.selfMember }),
}));
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: ({ table }: { table: string }) => ({
    data: h.tables[table] ?? [], loading: false, error: null, refresh: async () => undefined,
  }),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => undefined, error: () => undefined }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
// The real Modal portals into document.body, which a server render has none of.
// It renders its children when open — and, for the one case that needs a picker
// the reader opens by clicking, when the test says every modal is open.
vi.mock('@/components/ui/modal', async () => {
  const { createElement: element } = await import('react');
  return {
    Modal: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
      (open || h.openEveryModal ? element('section', { role: 'dialog', 'aria-label': title }, children) : null),
  };
});
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: '' } }) }) } }),
}));
vi.mock('@/app/(app)/dashboard/dining/actions', () => ({
  toggleFavoriteAction: vi.fn(), addRestaurantAction: vi.fn(), logVisitAction: vi.fn(),
}));
vi.mock('@/app/(app)/dashboard/family-signals/actions', () => ({
  refreshSignalsAction: vi.fn(), setSignalStatusAction: vi.fn(),
}));
vi.mock('@/app/(app)/dashboard/relationship/actions', () => ({ toggleDateOnCalendarAction: vi.fn() }));
vi.mock('@/app/(app)/dashboard/ai-feedback-actions', () => ({ recordAiFeedbackAction: vi.fn() }));

import { ClosetModule } from '@/components/modules/closet-module';
import { DiningModule, type DiningRow } from '@/components/modules/dining-module';
import { FamilySignalsModule, type SignalView } from '@/components/modules/family-signals-module';
import { InventoryModule } from '@/components/modules/inventory-module';
import { RelationshipModule } from '@/components/modules/relationship-module';
import { VotingModule } from '@/components/modules/voting-module';

/** The reader's real catalogue, as the app hands it to the provider — no floor under it. */
function renderAs(code: LocaleCode, node: ReactNode): string {
  // Annotated, not cast: the provider's props are checked, children included.
  const props: Parameters<typeof LocaleProvider>[0] = {
    locale: localeOrDefault(code), source: 'default', messages: getMessages(code), children: node,
  };
  return renderToStaticMarkup(createElement(LocaleProvider, props));
}

/** The amount a reader of `code` gets, from the formatter the modules use — not a typed literal. */
const usd = (code: LocaleCode, cents: number) => formatCents(cents, 'USD', code);

/** React escapes these in text, so a catalogue sentence is compared as it renders. */
const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

/** The de-DE catalogue's own template for `key`. Fails while de-DE does not carry it. */
function germanTemplate(key: string): string {
  const de = getRawMessages('de-DE');
  expect(de, `de-DE has no "${key}": a German parent would read the English fallback`).toHaveProperty([key]);
  return de[key];
}
/** The German sentence for `key`, unescaped (to nest inside another sentence). */
const germanText = (key: string, params?: Record<string, string | number>) => translate({ [key]: germanTemplate(key) }, key, params);
/** The German sentence for `key`, as it renders. */
const german = (key: string, params?: Record<string, string | number>) => escapeHtml(germanText(key, params));

/** Occurrences of `needle` in `html`. */
const count = (html: string, needle: string) => html.split(needle).length - 1;

// The shape every one of these used to print: a "$" written in front of digits.
const DOLLAR_GLUED_TO_DIGITS = /\$\s?\d/;
// A lucide dollar-sign glyph in front of a formatted amount prints the symbol
// twice for a reader whose locale puts it after the digits.
const DOLLAR_ICON = 'lucide-dollar-sign';
// 2,768.50 dollars, in cents. Big enough to group, with cents to show the mark.
const CENTS = 276_850;
const STAMPS = { created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' };

beforeEach(() => {
  h.tables = {};
  h.members = [];
  h.selfMember = null;
  h.openEveryModal = false;
});

// Every case below compares against the formatter's own output, so it would pass
// vacuously if the formatter ignored the locale. This pins that it does not.
describe('the formatter the modules use', () => {
  it('writes a German amount differently from an American one, without a "$" in front', () => {
    expect(usd('de-DE', CENTS)).not.toBe(usd('en-US', CENTS));
    expect(usd('de-DE', CENTS)).toContain('2.768,50');
    expect(usd('de-DE', CENTS)).not.toMatch(DOLLAR_GLUED_TO_DIGITS);
    expect(usd('en-US', CENTS)).toContain('2,768.50');
  });
});

describe('Closet: the cost per wear', () => {
  beforeEach(() => {
    // The member switcher picks its default in an effect, which a server render
    // does not run, so the first paint shows the initial ('') selection — and
    // these items are that selection's.
    h.tables.wardrobe_items = [{
      id: 'w-1', family_id: 'fam-1', member_id: '', name: 'Wool coat', category: 'outerwear', color: null, size: null,
      brand: null, warmth: 5, formality: 4, seasons: [], status: 'active', photo_path: null, purchased_on: null,
      price_cents: CENTS, wear_count: 1, last_worn_on: null, notes: null, created_by: 'user-1', ...STAMPS,
    }];
  });

  it('reads in German separators, with the symbol where German puts it, in a German sentence', () => {
    const html = renderAs('de-DE', createElement(ClosetModule));
    expect(html).toContain(german('closet.avgCostPerWear', { amount: usd('de-DE', CENTS) }));
    expect(html).toContain(german('closet.costPerWear', { amount: usd('de-DE', CENTS) }));
    expect(html).not.toMatch(DOLLAR_GLUED_TO_DIGITS);
  });

  it('still reads "avg $2,768.50 per wear" for an American reader', () => {
    const html = renderAs('en-US', createElement(ClosetModule));
    expect(html).toContain(`avg ${usd('en-US', CENTS)} per wear`);
    expect(html).toContain(`${usd('en-US', CENTS)}/wear`);
  });
});

describe('Dining: the 30-day spend tile and a visit total', () => {
  const visit: DiningRow = {
    id: 'v-1', name: 'Trattoria', kind: 'visit', cuisine: null, category: null, price_level: null, rating: null,
    distance_km: null, is_favorite: false, amount_cents: CENTS, item_count: 3, visited_at: '2026-09-20T19:00:00Z',
  };
  const stats = { favorites: 0, visits30d: 1, spend30dCents: CENTS, avgRating: null };
  const dining = () => createElement(DiningModule, { restaurants: [], visits: [visit], stats });

  it('reads in German separators with the symbol where German puts it', () => {
    const html = renderAs('de-DE', dining());
    // Once on the tile, once on the visit. Both stand alone, with no words around them.
    expect(count(html, usd('de-DE', CENTS))).toBe(2);
    expect(html).not.toMatch(DOLLAR_GLUED_TO_DIGITS);
  });

  it('still reads "$2,768.50" for an American reader', () => {
    const html = renderAs('en-US', dining());
    expect(count(html, usd('en-US', CENTS))).toBe(2);
  });
});

describe('Family Intelligence: a budget-drift signal\'s evidence', () => {
  // hard-signals.ts stores the evidence in DOLLARS, not cents.
  const signal: SignalView = {
    id: 's-1', kind: 'budget_drift', title: 'Over budget on Dining', detail: null, score: 80,
    evidence: { spent: 2768.5, limit: 400, recurring: true }, status: 'active', lastSeenAt: '2026-09-20T00:00:00Z',
  };
  const signals = () => createElement(FamilySignalsModule, { active: [signal], hidden: [] });

  it('reads in German separators, with the symbol where German puts it, in German chips', () => {
    const html = renderAs('de-DE', signals());
    expect(html).toContain(german('familySignals.amountSpent', { amount: usd('de-DE', CENTS) }));
    expect(html).toContain(german('familySignals.amountCap', { amount: usd('de-DE', 40_000) }));
    expect(html).toContain(german('familySignals.twoPeriods'));
    expect(html).not.toMatch(DOLLAR_GLUED_TO_DIGITS);
  });

  it('still reads "$2,768.50 spent" for an American reader', () => {
    const html = renderAs('en-US', signals());
    expect(html).toContain(`${usd('en-US', CENTS)} spent`);
    expect(html).toContain(`${usd('en-US', 40_000)} cap`);
    expect(html).toContain('2 periods');
  });
});

describe('Home Inventory: the replacement value, to the whole unit as before', () => {
  // 2,768.50 shows as 2,769 whole units, as it always has here.
  const WHOLE = 276_900;
  const top = (code: LocaleCode) => `${categoryMeta('electronics').label} ${usd(code, WHOLE)}`;

  beforeEach(() => {
    h.tables.inventory_items = [{
      id: 'i-1', family_id: 'fam-1', name: 'Laptop', category: 'electronics', location_id: null, owner_member_id: null,
      quantity: 1, value_cents: CENTS, purchased_on: null, brand: null, model: null, serial_number: null,
      warranty_until: null, photo_path: null, tags: [], status: 'in_place', lent_to: null, lent_on: null, notes: null,
      created_by: 'user-1', ...STAMPS,
    }];
  });

  it('reads "2.769 $", not the half-fix "$2.769", in a German line', () => {
    const html = renderAs('de-DE', createElement(InventoryModule));
    // The total tile, the top-category line and the item card.
    expect(count(html, usd('de-DE', WHOLE))).toBe(3);
    expect(html).toContain(german('inventoryModule.valuedItemsTop', { count: 1, top: top('de-DE') }));
    expect(html).not.toContain('$2.769');
    expect(html).not.toMatch(DOLLAR_GLUED_TO_DIGITS);
  });

  it('still reads "$2,769" for an American reader', () => {
    const html = renderAs('en-US', createElement(InventoryModule));
    expect(count(html, usd('en-US', WHOLE))).toBe(3);
    expect(html).toContain(`Valued items: 1 · top: ${top('en-US')}`);
  });

  it('asks for values in the reader\'s language when none is set', () => {
    h.tables.inventory_items = [];
    expect(renderAs('de-DE', createElement(InventoryModule))).toContain(german('inventoryModule.addValuesForInsurance'));
    expect(renderAs('en-US', createElement(InventoryModule))).toContain('Add values to build an insurance record');
  });
});

describe('Relationship Helper: gift prices and what is left to buy', () => {
  beforeEach(() => {
    const partner = { id: 'm-2', display_name: 'Sam', family_id: 'fam-1' };
    h.members = [{ id: 'm-1', display_name: 'Alex', family_id: 'fam-1' }, partner];
    h.selfMember = h.members[0];
    h.tables.relationship_profile = [{
      id: 'p-1', family_id: 'fam-1', created_by: 'user-1', partner_name: 'Sam', partner_member_id: 'm-2',
      interests: [], love_languages: [], gift_budget_cents: null, notes: null, ...STAMPS,
    }];
    h.tables.relationship_gift_ideas = [{
      id: 'g-1', family_id: 'fam-1', created_by: 'user-1', for_member_id: null, for_name: null, title: 'Record player',
      url: null, price_cents: CENTS, occasion: null, reason: null, source: 'manual', wishlist_item_id: null,
      status: 'idea', ...STAMPS,
    }];
    // wishlist_items.price is DOLLARS; suggestGiftsFromWishlist turns it into cents.
    // The second has no price, which the picker says in words.
    const wish = { family_id: 'fam-1', member_id: 'm-2', url: null, priority: 'high', notes: null, claimed_by: null, claimed_at: null, is_purchased: false, created_by: 'user-1', ...STAMPS };
    h.tables.wishlist_items = [
      { ...wish, id: 'wl-1', title: 'Espresso machine', price: 2768.5 },
      { ...wish, id: 'wl-2', title: 'Hand-written letter', price: null },
    ];
    // The wishlist picker is a modal the reader opens; show it open.
    h.openEveryModal = true;
  });

  it('reads in German separators, with the symbol where German puts it, in German words', () => {
    const html = renderAs('de-DE', createElement(RelationshipModule));
    // "… to go" keeps the amount's emphasis wherever the German sentence puts it.
    const [before, after] = germanTemplate('relationship.amountToGo').split('{amount}');
    expect(html).toContain(`${escapeHtml(before)}<span class="font-semibold text-fg">${usd('de-DE', CENTS)}</span>${escapeHtml(after)}`);
    // The summary, the gift card's price and the wishlist picker's price.
    expect(count(html, usd('de-DE', CENTS))).toBe(3);
    expect(html).toContain(german('relationship.noPrice'));
    expect(html).not.toMatch(DOLLAR_GLUED_TO_DIGITS);
    expect(html).not.toContain(DOLLAR_ICON);
  });

  it('still reads "$2,768.50 to go" for an American reader', () => {
    const html = renderAs('en-US', createElement(RelationshipModule));
    expect(html).toContain(`<span class="font-semibold text-fg">${usd('en-US', CENTS)}</span> to go`);
    expect(count(html, usd('en-US', CENTS))).toBe(3);
    expect(html).toContain('No price');
    expect(html).not.toContain(DOLLAR_ICON);
  });
});

describe('Group Voting: a poll\'s budget, an option\'s cost, and a favorite over budget', () => {
  const poll = (id: string, budgetCents: number | null, category: string) => ({
    id, family_id: 'fam-1', vacation_id: null, question: `Poll ${id}`, description: null, kind: 'single', status: 'open',
    closes_at: null, decision_category: category, budget_cents: budgetCents, required_tags: [], created_by: 'user-1', ...STAMPS,
  });
  const option = (pollId: string, key: string, label: string, sort: number, costCents: number | null, travel: number | null) => ({
    id: `${pollId}-${key}`, family_id: 'fam-1', poll_id: pollId, label, sort, cost_cents: costCents, travel_minutes: travel,
    tags: [], created_at: STAMPS.created_at,
  });

  beforeEach(() => {
    h.selfMember = { id: 'm-1', display_name: 'Alex', family_id: 'fam-1' };
    // One poll with its own cap, one that borrows the family's dining budget.
    h.tables.family_polls = [poll('p-1', CENTS, 'general'), poll('p-2', null, 'meal')];
    h.tables.family_poll_options = ['p-1', 'p-2'].flatMap((pollId) => [
      option(pollId, 'a', 'Pizza', 0, 123_450, null),
      option(pollId, 'b', 'Tacos', 1, null, 10),
    ]);
    // budgets.amount is DOLLARS.
    h.tables.budgets = [{ category: 'Dining', amount: 2768.5 }];
  });

  it('reads in German separators, with the symbol where German puts it, in German words', () => {
    const html = renderAs('de-DE', createElement(VotingModule));
    // Poll p-1's own cap, and poll p-2's borrowed from the family's dining budget.
    expect(html).toContain(german('voting.budgetAmount', { amount: usd('de-DE', CENTS) }));
    expect(html).toContain(german('voting.budgetFromYourBudget', { amount: usd('de-DE', CENTS) }));
    expect(count(html, usd('de-DE', 123_450))).toBe(2);
    expect(html).not.toMatch(DOLLAR_GLUED_TO_DIGITS);
    expect(html).not.toContain(DOLLAR_ICON);
  });

  it('still reads "budget $2,768.50" for an American reader', () => {
    const html = renderAs('en-US', createElement(VotingModule));
    expect(html).toContain(`budget ${usd('en-US', CENTS)} (from your budget)`);
    expect(count(html, `budget ${usd('en-US', CENTS)}`)).toBe(2);
    expect(count(html, usd('en-US', 123_450))).toBe(2);
    expect(html).not.toContain(DOLLAR_ICON);
  });

  describe('when the favorite is over budget', () => {
    beforeEach(() => {
      // Pizza leads 3–1 but costs 1,234.50 against a 1,000 cap: 234.50 over.
      h.tables.family_polls = [poll('p-3', 100_000, 'general')];
      h.tables.family_poll_options = [option('p-3', 'a', 'Pizza', 0, 123_450, null), option('p-3', 'b', 'Tacos', 1, null, 10)];
      h.tables.family_poll_votes = [
        ...['m-1', 'm-2', 'm-3'].map((memberId) => ({ id: `v-${memberId}`, family_id: 'fam-1', poll_id: 'p-3', option_id: 'p-3-a', member_id: memberId, created_at: STAMPS.created_at })),
        { id: 'v-m-4', family_id: 'fam-1', poll_id: 'p-3', option_id: 'p-3-b', member_id: 'm-4', created_at: STAMPS.created_at },
      ];
    });

    it('warns a German parent in one German sentence, the breach in German format inside it', () => {
      const html = renderAs('de-DE', createElement(VotingModule));
      const breach = germanText('decisionEngine.overBudgetBy', { amount: usd('de-DE', 23_450) });
      expect(html).toContain(german('votingConsensus.favoriteDoesNotFitClosestPick', { favorite: 'Pizza', reasons: breach, pick: 'Tacos' }));
      expect(html).not.toMatch(DOLLAR_GLUED_TO_DIGITS);
    });

    it('still warns an American one in English', () => {
      const html = renderAs('en-US', createElement(VotingModule));
      expect(html).toContain(escapeHtml(
        `The current favorite “Pizza” doesn't fit — over budget by ${usd('en-US', 23_450)}. Closest workable pick: “Tacos”.`,
      ));
    });
  });
});
