import { describe, expect, it } from 'vitest';
import {
  RETAILERS, retailerById, itemSearchUrl, buildShoppingText,
} from '@/lib/grocery/retailers';

describe('retailers', () => {
  it('exposes a non-empty, well-formed catalog', () => {
    expect(RETAILERS.length).toBeGreaterThanOrEqual(4);
    for (const r of RETAILERS) {
      expect(r.storeUrl).toMatch(/^https:\/\//);
      expect(r.search('milk')).toMatch(/^https:\/\//);
    }
  });
  it('looks up by id', () => {
    expect(retailerById('walmart')?.name).toBe('Walmart');
    expect(retailerById('nope')).toBeUndefined();
  });
});

describe('itemSearchUrl', () => {
  it('encodes the query into the retailer search', () => {
    const url = itemSearchUrl('instacart', 'almond milk');
    expect(url).toContain('almond+milk');
    expect(url).toContain('instacart.com');
  });
  it('falls back to the store landing page for a blank item', () => {
    expect(itemSearchUrl('target', '   ')).toBe(retailerById('target')!.storeUrl);
  });
  it('returns # for an unknown retailer', () => {
    expect(itemSearchUrl('ghost', 'eggs')).toBe('#');
  });
});

describe('buildShoppingText', () => {
  it('renders quantity + name lines and skips blanks', () => {
    const txt = buildShoppingText([
      { name: 'Eggs', quantity: '1 dozen' },
      { name: 'Bananas' },
      { name: '   ' },
    ]);
    expect(txt).toBe('1 dozen Eggs\nBananas');
  });
});
