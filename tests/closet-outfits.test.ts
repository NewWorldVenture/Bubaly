import { describe, expect, it } from 'vitest';
import {
  OCCASIONS, SEASONS, WARDROBE_CATEGORIES, WARDROBE_STATUSES, categoryMeta, closetSummary, costPerWear, dayDiff,
  neglectedItems, scoreItem, seasonFor, suggestOutfit, tempBand, warmthForTemp, weatherLabelFromTemp,
  type WardrobeItemLike,
} from '@/lib/closet/outfits';

const TODAY = new Date('2026-09-05T12:00:00');
let n = 0;
function item(p: Partial<WardrobeItemLike> & { category: WardrobeItemLike['category'] }): WardrobeItemLike {
  n += 1;
  return {
    id: `i${n}`, member_id: 'm1', name: `${p.category} ${n}`, warmth: 3, formality: 2, seasons: [], status: 'active',
    last_worn_on: null, wear_count: 0, price_cents: null, ...p,
  };
}

describe('catalogs', () => {
  it('cover every enum value with a label + emoji', () => {
    expect(WARDROBE_CATEGORIES).toHaveLength(10);
    expect(WARDROBE_STATUSES).toHaveLength(6);
    expect(SEASONS.map((s) => s.value)).toEqual(['spring', 'summer', 'fall', 'winter']);
    expect(OCCASIONS.find((o) => o.value === 'dressy')?.formality).toBe(5);
    expect(categoryMeta('nope' as never).value).toBe('top');
  });
});

describe('seasons + warmth', () => {
  it('maps dates to meteorological seasons', () => {
    expect(seasonFor(new Date('2026-01-10'))).toBe('winter');
    expect(seasonFor(new Date('2026-04-10'))).toBe('spring');
    expect(seasonFor(new Date('2026-07-10'))).toBe('summer');
    expect(seasonFor(TODAY)).toBe('fall');
  });
  it('maps temperature to a warmth target and band', () => {
    expect(warmthForTemp(30)).toBe(1);
    expect(warmthForTemp(24)).toBe(2);
    expect(warmthForTemp(17)).toBe(3);
    expect(warmthForTemp(10)).toBe(4);
    expect(warmthForTemp(-3)).toBe(5);
    expect(tempBand(17.6)).toEqual({ min: 14, max: 22 });
    expect(weatherLabelFromTemp(17)).toBe('mild');
    expect(dayDiff('2026-09-01', TODAY)).toBe(4);
  });
});

describe('scoreItem', () => {
  const ctx = { targetWarmth: 3, targetFormality: 2, season: 'fall' as const, today: TODAY };
  it('rewards the right warmth, formality, season and rotation', () => {
    const good = scoreItem(item({ category: 'top', seasons: ['fall'], last_worn_on: '2026-08-20' }), ctx);
    expect(good.score).toBeGreaterThan(110);
    expect(good.reasons).toContain('right warmth for today');
    expect(good.reasons).toContain('a fall piece');
  });
  it('penalises out-of-season, wrong warmth and just-worn items', () => {
    const bad = scoreItem(item({ category: 'top', warmth: 5, formality: 5, seasons: ['summer'], last_worn_on: '2026-09-04' }), ctx);
    expect(bad.score).toBeLessThan(20);
    expect(bad.reasons).toEqual(expect.arrayContaining(['too warm', 'a bit dressy', 'out of season', 'worn in the last two days']));
  });
});

describe('suggestOutfit', () => {
  it('picks top + bottom + outerwear + shoes for a cool everyday day from the member’s own items', () => {
    const items = [
      item({ category: 'top', name: 'Grey hoodie', warmth: 3 }),
      item({ category: 'top', name: 'Linen shirt', warmth: 1, seasons: ['summer'] }),
      item({ category: 'bottom', name: 'Blue jeans', warmth: 3 }),
      item({ category: 'outerwear', name: 'Rain jacket', warmth: 3 }),
      item({ category: 'shoes', name: 'Sneakers' }),
      item({ category: 'accessory', name: 'Beanie', warmth: 5 }),
      item({ category: 'top', name: 'Someone else’s', member_id: 'm2' }),
      item({ category: 'top', name: 'In laundry', status: 'laundry' }),
    ];
    const s = suggestOutfit(items, { memberId: 'm1', tempC: 15, occasion: 'everyday', date: TODAY });
    const names = s.picks.map((p) => p.item.name);
    expect(names).toEqual(['Grey hoodie', 'Blue jeans', 'Rain jacket', 'Sneakers']);
    expect(s.missing).toEqual([]);
    // A weather-appropriate accessory joins the outfit; the warm beanie above did not.
    const withCap = suggestOutfit([...items, item({ category: 'accessory', name: 'Cap', warmth: 3 })], { memberId: 'm1', tempC: 15, occasion: 'everyday', date: TODAY });
    expect(withCap.picks.map((p) => p.item.name)).toContain('Cap');
    expect(s.targetWarmth).toBe(3);
    expect(s.summary).toBe('Grey hoodie + Blue jeans + Rain jacket + Sneakers');
  });

  it('prefers a dress for a dressy occasion and skips outerwear in the heat', () => {
    const items = [
      item({ category: 'dress', name: 'Party dress', warmth: 1, formality: 5 }),
      item({ category: 'top', name: 'Tee', warmth: 1 }),
      item({ category: 'bottom', name: 'Shorts', warmth: 1 }),
      item({ category: 'outerwear', name: 'Coat', warmth: 5 }),
      item({ category: 'shoes', name: 'Flats', formality: 4 }),
    ];
    const s = suggestOutfit(items, { memberId: 'm1', tempC: 30, occasion: 'dressy', date: TODAY });
    expect(s.picks.map((p) => p.item.name)).toEqual(['Party dress', 'Flats']);
  });

  it('reports missing slots and an empty-closet summary', () => {
    const s = suggestOutfit([item({ category: 'top', name: 'Tee' })], { memberId: 'm1', tempC: 25, occasion: 'school', date: TODAY });
    expect(s.picks.map((p) => p.item.name)).toEqual(['Tee']);
    expect(s.missing).toEqual(['bottom', 'shoes']);
    expect(s.summary).toContain('nothing suitable for: bottom, shoes');
    expect(suggestOutfit([], { memberId: 'm1', tempC: 25, occasion: 'school', date: TODAY }).summary).toMatch(/Closet/i);
  });

  it('only offers sleepwear for sleep and never sleepwear elsewhere', () => {
    const items = [item({ category: 'sleepwear', name: 'PJs' }), item({ category: 'top', name: 'Tee' }), item({ category: 'bottom', name: 'Jeans' })];
    expect(suggestOutfit(items, { memberId: 'm1', tempC: 20, occasion: 'sleep', date: TODAY }).picks.map((p) => p.item.name)).toEqual(['PJs']);
    expect(suggestOutfit(items, { memberId: 'm1', tempC: 20, occasion: 'everyday', date: TODAY }).picks.map((p) => p.item.name)).toEqual(['Tee', 'Jeans']);
  });
});

describe('closet analytics', () => {
  it('flags neglected items and computes cost per wear', () => {
    const items = [
      item({ category: 'top', name: 'Old', last_worn_on: '2026-01-01', price_cents: 4000, wear_count: 4 }),
      item({ category: 'top', name: 'Fresh', last_worn_on: '2026-09-01', price_cents: 2000, wear_count: 20 }),
      item({ category: 'top', name: 'Never', price_cents: 6000 }),
      item({ category: 'top', name: 'Storage', status: 'storage', last_worn_on: '2025-01-01' }),
    ];
    expect(neglectedItems(items, TODAY).map((i) => i.name)).toEqual(['Old', 'Never']);
    expect(costPerWear(items[0])).toBe(1000);
    expect(costPerWear(items[2])).toBe(6000);
    expect(costPerWear({ price_cents: null, wear_count: 3 })).toBeNull();
  });

  it('summarises the closet', () => {
    const items = [
      item({ category: 'top', name: 'A', wear_count: 9, price_cents: 900 }),
      item({ category: 'top', name: 'B', status: 'laundry', wear_count: 3 }),
      item({ category: 'top', name: 'C', status: 'outgrown' }),
    ];
    const logs = [
      { member_id: 'm1', worn_on: '2026-09-04', item_ids: ['i1'] },
      { member_id: 'm1', worn_on: '2026-08-01', item_ids: ['i1'] },
    ];
    const s = closetSummary(items, logs, TODAY);
    expect(s).toMatchObject({ active: 1, laundry: 1, retire: 1, wornThisWeek: 1, avgCostPerWearCents: 100 });
    expect(s.mostWorn[0]).toEqual({ name: 'A', count: 9 });
    expect(s.text).toBe('1 ready · 1 in laundry · 1 outgrown');
    expect(closetSummary([], [], TODAY).text).toBe('Closet is empty');
  });
});
