import { describe, it, expect } from 'vitest';
import {
  parseListingHints, suggestPricing, buildDraft, buildTags,
  buildSeoDescription, draftReadiness,
} from '@/lib/marketplace/listing-draft';

describe('parseListingHints', () => {
  it('extracts category, condition, mode, color, size, brand from a sentence', () => {
    const h = parseListingHints('Renting out my like new blue Nike jacket, size medium');
    expect(h.category).toBe('clothing');
    expect(h.condition).toBe('like_new');
    expect(h.modes).toContain('rent');
    expect(h.color).toBe('blue');
    expect(h.brand).toBe('nike');
    expect(h.size).toContain('medium');
  });
  it('detects a wanted/borrow request', () => {
    const h = parseListingHints('Looking to borrow a stroller this weekend');
    expect(h.modes).toContain('wanted');
    expect(h.category).toBe('baby');
  });
  it('detects a giveaway as donate', () => {
    expect(parseListingHints('Giving away free books').modes).toContain('donate');
  });
});

describe('suggestPricing', () => {
  it('scales price by condition and derives rent + deposit', () => {
    const newPrice = suggestPricing('electronics', 'new');
    const wornPrice = suggestPricing('electronics', 'worn');
    expect(newPrice.priceCents).toBeGreaterThan(wornPrice.priceCents);
    expect(newPrice.rentDayCents).toBeGreaterThan(0);
    expect(newPrice.depositCents).toBeGreaterThan(0);
    expect(newPrice.priceCents % 100).toBe(0); // rounded to the dollar
  });
});

describe('buildDraft', () => {
  it('assembles a full draft from one sentence with sensible defaults', () => {
    const d = buildDraft({ text: 'Selling my good condition red Lego set' });
    expect(d.category).toBe('toys');
    expect(d.condition).toBe('good');
    expect(d.modes).toContain('buy');
    expect(d.priceCents).toBeGreaterThan(0);
    expect(d.tags.length).toBeGreaterThan(0);
    expect(d.seoDescription).toContain('Bubaly');
    expect(d.aiSuggested).toBe(true);
    expect(d.safetyNotes.length).toBeGreaterThan(0);
  });

  it('zeroes the buy price for a wanted/borrow request and rent gets a rate + deposit', () => {
    const wanted = buildDraft({ text: 'Looking to borrow a black cocktail dress size M' });
    expect(wanted.priceCents).toBe(0);
    const rent = buildDraft({ text: 'Renting out a tent', modes: ['rent'] });
    expect(rent.rentDayCents).toBeGreaterThan(0);
    expect(rent.depositCents).toBeGreaterThan(0);
    expect(rent.priceCents).toBe(0); // rent-only → no buy price
  });

  it('honors explicit overrides and marks aiSuggested false when user-specified', () => {
    const d = buildDraft({ text: 'a bike', title: 'My Bike', category: 'sports', priceCents: 12000, modes: ['buy'] });
    expect(d.title).toBe('My Bike');
    expect(d.priceCents).toBe(12000);
    expect(d.aiSuggested).toBe(false);
  });
});

describe('tags + seo', () => {
  it('dedupes and slugs tags, capped at 12', () => {
    const tags = buildTags({ category: 'clothing', color: 'blue', brand: 'Nike', modes: ['rent'], keywords: ['jacket', 'jacket', 'the'] });
    expect(tags).toContain('clothing');
    expect(tags).toContain('nike');
    expect(new Set(tags).size).toBe(tags.length); // no dupes
    expect(tags.length).toBeLessThanOrEqual(12);
  });
  it('builds a readable SEO line', () => {
    const d = buildDraft({ text: 'like new blue Nike jacket for sale' });
    expect(buildSeoDescription(d)).toMatch(/Bubaly Marketplace\.$/);
  });
});

describe('draftReadiness (publish gate)', () => {
  it('flags missing essentials and never auto-passes an empty draft', () => {
    expect(draftReadiness({}).ready).toBe(false);
    expect(draftReadiness({}).missing).toContain('title');
  });
  it('requires a sale price for buy mode and a rate for rent mode', () => {
    expect(draftReadiness({ title: 'Bike', category: 'sports', modes: ['buy'], priceCents: 0 }).missing).toContain('sale price');
    expect(draftReadiness({ title: 'Tent', category: 'sports', modes: ['rent'], rentDayCents: 0 }).missing).toContain('rental rate');
  });
  it('passes a complete draft', () => {
    const d = buildDraft({ text: 'Selling my good red Lego set' });
    expect(draftReadiness(d).ready).toBe(true);
  });
  it('does not require a price for a wanted request', () => {
    expect(draftReadiness({ title: 'Want a dress', category: 'clothing', modes: ['wanted'] }).ready).toBe(true);
  });
});
