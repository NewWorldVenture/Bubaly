// M17 "Before you buy" — the deterministic half.
//
// Every assertion here runs with no provider, no key and no network: the
// verdict a family sees is computed from their own rows, so it has to hold
// offline. These tests are the proof that it does.
import { describe, expect, it } from 'vitest';
import {
  adviseOnPurchase,
  candidateTokens,
  describeAdvice,
  guessCategory,
  type BudgetRow,
  type FactRow,
  type HomeAssetRow,
  type InventoryRow,
  type WardrobeRow,
  type WishRow,
} from '@/lib/purchases/advisor';
import { classifyIntentFast, INTENT_KEYS, INTENT_SLICES } from '@/lib/ai/context/intents';
import type { InventoryCategory, InventoryStatus } from '@/lib/database.types';

function item(over: Partial<InventoryRow> & { id: string; name: string }): InventoryRow {
  return {
    category: 'other' as InventoryCategory,
    location_id: null,
    quantity: 1,
    value_cents: null,
    brand: null,
    model: null,
    serial_number: null,
    tags: [],
    status: 'in_place' as InventoryStatus,
    lent_to: null,
    lent_on: null,
    warranty_until: null,
    ...over,
  };
}

const asset = (over: Partial<HomeAssetRow> & { id: string; name: string }): HomeAssetRow => ({
  category: null,
  location: null,
  brand: null,
  model: null,
  serial_number: null,
  purchase_price: null,
  warranty_until: null,
  ...over,
});

const wardrobe = (over: Partial<WardrobeRow> & { id: string; name: string }): WardrobeRow => ({
  member_id: 'm-1',
  category: 'outerwear',
  brand: null,
  color: null,
  size: null,
  status: 'active',
  price_cents: null,
  ...over,
});

const fact = (over: Partial<FactRow> & { id: string; label: string; value: string }): FactRow => ({
  member_id: null,
  category: 'preference',
  is_pinned: false,
  ...over,
});

const wish = (over: Partial<WishRow> & { id: string; title: string }): WishRow => ({
  member_id: 'm-1',
  price: null,
  is_purchased: false,
  ...over,
});

const budget = (category: string, limitCents: number, spentCents: number): BudgetRow => ({ category, limitCents, spentCents });

describe('candidateTokens', () => {
  it('drops request wording and marketing filler but keeps what names the thing', () => {
    expect(candidateTokens('Should we buy another new cordless drill?')).toEqual(['cordless', 'drill']);
    expect(candidateTokens('Bosch 18V battery')).toEqual(['bosch', '18v', 'battery']);
  });

  it('is empty for text with nothing identifying in it', () => {
    expect(candidateTokens('   ')).toEqual([]);
    expect(candidateTokens('should we buy a new one')).toEqual([]);
  });
});

describe('guessCategory', () => {
  it('maps a product word to an inventory category, and stays null when unsure', () => {
    expect(guessCategory(['cordless', 'drill'])).toBe('tools');
    expect(guessCategory(['espresso', 'machine'])).toBe('kitchen');
    expect(guessCategory(['widget'])).toBeNull();
  });
});

describe('owned duplicates', () => {
  it('flags an item the family already owns, by name, and says where it is', () => {
    const advice = adviseOnPurchase({
      candidate: { text: 'Cordless drill' },
      inventory: [item({ id: 'i-1', name: 'Cordless drill', brand: 'Bosch', model: 'GSR 18V', location_id: 'loc-1' })],
      locations: [{ id: 'loc-1', name: 'Garage', kind: 'garage', parent_id: null }],
    });
    expect(advice.duplicates.map((d) => d.name)).toEqual(['Cordless drill']);
    expect(advice.duplicates[0].detail).toBe('Garage');
    expect(advice.duplicates[0].source).toBe('inventory');
    expect(advice.reason).toBe('owned_duplicate');
    expect(advice.verdict).toBe('tight');
  });

  it('flags a duplicate by MODEL when the wording never repeats the name', () => {
    const advice = adviseOnPurchase({
      candidate: { text: 'GSR 18V' },
      inventory: [item({ id: 'i-1', name: 'Drill', brand: 'Bosch', model: 'GSR 18V' })],
    });
    expect(advice.duplicates.map((d) => d.id)).toEqual(['i-1']);
    expect(advice.duplicates[0].matchedOn).toContain('model');
  });

  it('reads home assets and the closet, not just the inventory table', () => {
    const fromAssets = adviseOnPurchase({
      candidate: { text: 'dishwasher' },
      homeAssets: [asset({ id: 'a-1', name: 'Dishwasher', brand: 'Bosch', model: 'SMS4', location: 'Kitchen' })],
    });
    expect(fromAssets.duplicates.map((d) => [d.source, d.name])).toEqual([['home_asset', 'Dishwasher']]);

    const fromCloset = adviseOnPurchase({
      candidate: { text: 'ski jacket' },
      wardrobe: [wardrobe({ id: 'w-1', name: 'Ski jacket', color: 'red', size: 'M' })],
    });
    expect(fromCloset.duplicates.map((d) => [d.source, d.detail])).toEqual([['wardrobe', 'red · M']]);
  });

  it('ignores things the family no longer has', () => {
    const advice = adviseOnPurchase({
      candidate: { text: 'Cordless drill' },
      inventory: [
        item({ id: 'i-1', name: 'Cordless drill', status: 'disposed' as InventoryStatus }),
        item({ id: 'i-2', name: 'Cordless drill', status: 'lost' as InventoryStatus }),
      ],
    });
    expect(advice.duplicates).toEqual([]);
    expect(advice.verdict).toBe('clear');
  });

  it('does not count an outgrown garment as one the family already owns', () => {
    // 0240_closet_outfits.sql: active|laundry|storage|outgrown|donated|lost.
    // Replacing a coat that no longer fits is precisely the purchase this must
    // never argue against.
    const advice = adviseOnPurchase({
      candidate: { text: 'Winter coat' },
      wardrobe: [wardrobe({ id: 'c-1', name: 'Winter coat', status: 'outgrown' })],
    });
    expect(advice.duplicates).toEqual([]);
    expect(advice.compatibility).toEqual([]);
    expect(advice.verdict).toBe('clear');
    expect(advice.reason).toBe('clear');
  });

  it('says where a duplicate actually is, so "you own one" is not overstated', () => {
    const advice = adviseOnPurchase({
      candidate: { text: 'Cordless drill' },
      inventory: [item({ id: 'i-1', name: 'Cordless drill', status: 'lent' as InventoryStatus, lent_to: 'Sam' })],
    });
    expect(advice.duplicates.map((d) => d.status)).toEqual(['lent']);
  });

  it('does not call an unrelated item a duplicate just because a brand matched', () => {
    const advice = adviseOnPurchase({
      candidate: { text: 'Bosch dishwasher' },
      inventory: [item({ id: 'i-1', name: 'Cordless drill', brand: 'Bosch', model: 'GSR 18V' })],
    });
    expect(advice.duplicates).toEqual([]);
    expect(advice.compatibility.map((c) => c.name)).toEqual(['Cordless drill']);
    expect(advice.verdict).toBe('clear');
  });

  it('surfaces the brand and model of related kit so compatibility can be checked', () => {
    const advice = adviseOnPurchase({
      candidate: { text: '18V battery' },
      inventory: [item({ id: 'i-1', name: 'Cordless drill 18V', brand: 'Bosch', model: 'GSR 18V' })],
    });
    expect(advice.duplicates).toEqual([]);
    expect(advice.compatibility[0]).toMatchObject({ name: 'Cordless drill 18V', brand: 'Bosch', model: 'GSR 18V' });
  });
});

describe('affordability', () => {
  const budgets = [budget('Tools', 20_000, 18_500)];

  it('returns tight when the category budget is nearly spent', () => {
    const advice = adviseOnPurchase({
      candidate: { text: 'sander', priceCents: 1_000 },
      budgets,
    });
    expect(advice.budget).toMatchObject({ category: 'Tools', unbudgeted: false, remainingAfterCents: 500 });
    expect(advice.budget?.verdict).toBe('tight');
    expect(advice.verdict).toBe('tight');
    expect(advice.reason).toBe('budget_tight');
  });

  it('returns clear when there is real headroom', () => {
    const advice = adviseOnPurchase({
      candidate: { text: 'sander', priceCents: 1_000 },
      budgets: [budget('Tools', 20_000, 2_000)],
    });
    expect(advice.verdict).toBe('clear');
    expect(advice.reason).toBe('clear');
    expect(advice.budget?.remainingAfterCents).toBe(17_000);
  });

  it('calls it a conflict when the purchase would break the budget', () => {
    const advice = adviseOnPurchase({
      candidate: { text: 'sander', priceCents: 5_000 },
      budgets,
    });
    expect(advice.verdict).toBe('conflict');
    expect(advice.reason).toBe('over_budget');
  });

  it('does not pretend headroom is fine when no budget covers the category', () => {
    const advice = adviseOnPurchase({
      candidate: { text: 'espresso machine', priceCents: 40_000 },
      budgets: [budget('Groceries', 60_000, 10_000)],
    });
    expect(advice.budget?.unbudgeted).toBe(true);
    expect(advice.verdict).toBe('tight');
    expect(advice.reason).toBe('no_budget');
  });

  it('skips the money half entirely when no price is known', () => {
    const advice = adviseOnPurchase({ candidate: { text: 'espresso machine' }, budgets });
    expect(advice.budget).toBeNull();
    expect(advice.verdict).toBe('clear');
  });

  it('matches the budget the caller names before guessing one', () => {
    const advice = adviseOnPurchase({
      candidate: { text: 'birthday present', priceCents: 3_000, budgetCategory: 'Gifts' },
      budgets: [budget('Gifts', 10_000, 1_000), budget('Tools', 20_000, 0)],
    });
    expect(advice.budget?.category).toBe('Gifts');
  });
});

describe('preferences and wish lists', () => {
  it('surfaces the remembered facts that bear on the purchase, pinned first', () => {
    const advice = adviseOnPurchase({
      candidate: { text: 'wool sweater' },
      facts: [
        fact({ id: 'f-1', label: 'Maya shoe size', value: '4' }),
        fact({ id: 'f-2', label: 'Liam allergy', value: 'wool makes him itch', is_pinned: true }),
        fact({ id: 'f-3', label: 'Sweater size', value: 'Medium' }),
      ],
    });
    expect(advice.preferences.map((p) => p.id)).toEqual(['f-2', 'f-3']);
    expect(advice.preferences[0].value).toContain('wool');
  });

  it('flags a wish someone has already bought', () => {
    const advice = adviseOnPurchase({
      candidate: { text: 'Lego botanicals set' },
      wishes: [wish({ id: 'w-1', title: 'Lego botanicals set', is_purchased: true })],
    });
    expect(advice.alreadyOnList.map((w) => w.id)).toEqual(['w-1']);
    expect(advice.reason).toBe('already_purchased');
    expect(advice.verdict).toBe('tight');
  });

  it('does not report the wish it was opened from — an item is not evidence about itself', () => {
    const wishes = [wish({ id: 'w-1', title: 'Lego botanicals set', is_purchased: true })];
    // Without the exclusion this is the card's own row coming back as a finding:
    // "already on a wish list", "already bought", verdict downgraded — all of it
    // read off the very thing the family is looking at.
    expect(adviseOnPurchase({ candidate: { text: 'Lego botanicals set' }, wishes }).alreadyOnList).toHaveLength(1);

    const advice = adviseOnPurchase({ candidate: { text: 'Lego botanicals set' }, wishes, excludeWishId: 'w-1' });
    expect(advice.alreadyOnList).toEqual([]);
    expect(advice.reason).toBe('clear');
    expect(advice.verdict).toBe('clear');
  });

  it('still reports a MATCHING wish on someone else’s list when one exists', () => {
    const advice = adviseOnPurchase({
      candidate: { text: 'Lego botanicals set' },
      wishes: [
        wish({ id: 'w-1', title: 'Lego botanicals set' }),
        wish({ id: 'w-2', member_id: 'm-2', title: 'Lego botanicals set', is_purchased: true }),
      ],
      excludeWishId: 'w-1',
    });
    expect(advice.alreadyOnList.map((w) => w.id)).toEqual(['w-2']);
    expect(advice.reason).toBe('already_purchased');
  });

  it('never tells the owner of a wish that their present has been bought', () => {
    // 00431_wishlists.sql: `is_purchased` is "hidden from the owner in the UI so
    // it stays a surprise". A second opinion on a purchase is not a licence to
    // spoil it.
    const wishes = [wish({ id: 'w-1', member_id: 'm-1', title: 'Lego botanicals set', is_purchased: true })];
    const owner = adviseOnPurchase({ candidate: { text: 'Lego botanicals set' }, wishes, viewerMemberId: 'm-1' });
    expect(owner.alreadyOnList.map((w) => w.purchased)).toEqual([false]);
    expect(owner.reason).toBe('clear');

    const relative = adviseOnPurchase({ candidate: { text: 'Lego botanicals set' }, wishes, viewerMemberId: 'm-2' });
    expect(relative.alreadyOnList.map((w) => w.purchased)).toEqual([true]);
    expect(relative.reason).toBe('already_purchased');
  });

  it('does not call every wish a match on one short shared word', () => {
    const advice = adviseOnPurchase({
      candidate: { text: 'ski helmet' },
      wishes: [wish({ id: 'w-1', title: 'Ski poles' })],
    });
    expect(advice.alreadyOnList).toEqual([]);
  });
});

describe('the whole verdict', () => {
  it('lets the budget break the tie: an owned duplicate AND an overrun reads as over budget', () => {
    const advice = adviseOnPurchase({
      candidate: { text: 'Cordless drill', priceCents: 30_000 },
      inventory: [item({ id: 'i-1', name: 'Cordless drill' })],
      budgets: [budget('Tools', 20_000, 0)],
    });
    expect(advice.verdict).toBe('conflict');
    expect(advice.reason).toBe('over_budget');
    expect(advice.duplicates).toHaveLength(1);
  });

  it('is deterministic: the same rows give the same answer every time', () => {
    const input = {
      candidate: { text: 'Cordless drill', priceCents: 9_000 },
      inventory: [item({ id: 'i-1', name: 'Cordless drill', brand: 'Bosch' })],
      budgets: [budget('Tools', 20_000, 1_000)],
    };
    expect(adviseOnPurchase(input)).toEqual(adviseOnPurchase(input));
  });

  it('says nothing about ownership when the candidate has no identifying words', () => {
    const advice = adviseOnPurchase({
      candidate: { text: 'a new one' },
      inventory: [item({ id: 'i-1', name: 'Cordless drill' })],
    });
    expect(advice.tokens).toEqual([]);
    expect(advice.duplicates).toEqual([]);
  });
});

describe('the "should we buy X?" intent', () => {
  it('routes a purchase question to the advisor, and carries the item with it', () => {
    const advice = classifyIntentFast('Should we buy another cordless drill?');
    expect(advice?.intent).toBe('purchase_advice');
    expect(advice?.source).toBe('fast_path');
    expect(advice?.entities.item).toBe('another cordless drill');

    expect(classifyIntentFast('Do we really need a second car seat?')?.intent).toBe('purchase_advice');
    expect(classifyIntentFast('Is it worth replacing the dishwasher?')?.intent).toBe('purchase_advice');
    expect(classifyIntentFast('Can we afford a new sofa?')?.intent).toBe('purchase_advice');
  });

  it('leaves the neighbouring vocabulary alone', () => {
    // A shopping-list capture stays a capture, and a plain "should we…"
    // question that is not about buying stays a question.
    expect(classifyIntentFast('Buy batteries')?.intent).toBe('capture');
    expect(classifyIntentFast('Should we do soccer or swim this fall?')?.intent).toBe('answer_question');
    expect(classifyIntentFast('Why did we spend too much last month?')?.intent).toBe('spending_review');
  });

  it('loads what the household owns before what it can afford', () => {
    expect(INTENT_SLICES.purchase_advice).toEqual(['people', 'home', 'shopping', 'money', 'memory']);
    expect(INTENT_KEYS).toContain('purchase_advice');
  });
});

describe('describeAdvice', () => {
  it('grounds a model in what was actually found, including the honest negative', () => {
    const advice = adviseOnPurchase({
      candidate: { text: 'Cordless drill' },
      inventory: [item({ id: 'i-1', name: 'Cordless drill', brand: 'Bosch', location_id: 'loc-1' })],
      locations: [{ id: 'loc-1', name: 'Garage', kind: 'garage', parent_id: null }],
    });
    const text = describeAdvice('Cordless drill', advice);
    expect(text).toContain('Deterministic verdict: tight (owned_duplicate)');
    expect(text).toContain('Cordless drill — Bosch (Garage)');

    const empty = describeAdvice('Cordless drill', adviseOnPurchase({ candidate: { text: 'Cordless drill' } }));
    expect(empty).toContain('nothing matching in the household inventory');
  });
});
