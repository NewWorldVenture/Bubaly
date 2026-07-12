import { describe, expect, it } from 'vitest';
import {
  answerMarketQuestion, marketSystemPrompt, routeMarketIntent, searchTerms,
  type MarketSnapshot, type SnapshotListing,
} from '@/lib/marketplace/assistant';

const listing = (over: Partial<SnapshotListing>): SnapshotListing => ({
  id: over.id ?? 'l1', title: 'Item', kind: 'sell', category: 'toys', condition: 'good',
  price_cents: 2000, status: 'available', member_id: 'm-other', ...over,
});

const SNAP: MarketSnapshot = {
  selfMemberId: 'm-me',
  listings: [
    listing({ id: 'b1', title: 'Kids balance bike', category: 'sports', price_cents: 4000 }),
    listing({ id: 'b2', title: 'Mountain bike 24"', category: 'sports', price_cents: 6000 }),
    listing({ id: 'b3', title: 'Bike helmet', category: 'sports', price_cents: 1500 }),
    listing({ id: 't1', title: 'Lego castle set', category: 'toys', price_cents: 3000 }),
    listing({ id: 'w1', title: 'Looking for a kids desk', kind: 'wanted', category: 'furniture', price_cents: 0 }),
    listing({ id: 'w2', title: 'Wanted: winter boots size 3', kind: 'wanted', category: 'clothing', price_cents: 0 }),
    listing({ id: 'w3', title: 'Wanted: bunk bed', kind: 'wanted', category: 'furniture', price_cents: 0 }),
    listing({ id: 'me1', title: 'My old skis', category: 'sports', member_id: 'm-me' }),
  ],
  offers: [
    { listing_id: 'me1', status: 'open', member_id: 'm-other' },
    { listing_id: 'b1', status: 'open', member_id: 'm-me' },
  ],
};

describe('routeMarketIntent', () => {
  it('routes the core intents', () => {
    expect(routeMarketIntent('What should I charge for a bike?')).toBe('price');
    expect(routeMarketIntent('find toys under $20')).toBe('find');
    expect(routeMarketIntent('how are my listings doing?')).toBe('mine');
    expect(routeMarketIntent("what's in demand right now")).toBe('demand');
    expect(routeMarketIntent('do you take a cut of fees?')).toBe('fees');
    expect(routeMarketIntent('is this safe to use?')).toBe('safety');
    expect(routeMarketIntent('how do I sell something?')).toBe('sell');
    expect(routeMarketIntent('hello there')).toBe('general');
  });
});

describe('searchTerms', () => {
  it('keeps meaningful words, drops stopwords and prices', () => {
    expect(searchTerms('find a balance bike under $50')).toEqual(['balance', 'bike']);
  });
});

describe('answerMarketQuestion', () => {
  it('prices from same-category comps with a real dollar figure', () => {
    const r = answerMarketQuestion('What should I charge for a kids bike in good condition?', SNAP);
    expect(r.intent).toBe('price');
    expect(r.reply).toMatch(/\$\d/);
    expect(r.reply).toContain('comparable');
    expect(r.links.some((l) => l.label.includes('60 seconds'))).toBe(true);
  });

  it('finds matching live listings within budget, with item links', () => {
    const r = answerMarketQuestion('find a bike under $50', SNAP);
    expect(r.intent).toBe('find');
    expect(r.reply).toContain('balance bike');
    expect(r.reply).not.toContain('Mountain bike'); // $60 > $50 budget
    expect(r.links[0].href).toMatch(/^\/marketplace\/item\//);
  });

  it('offers a saved-search alert when nothing matches', () => {
    const r = answerMarketQuestion('find a trampoline', SNAP);
    expect(r.reply).toContain('alert');
    expect(r.links.some((l) => l.href === '/marketplace/alerts')).toBe(true);
  });

  it('summarizes MY listings and open offers', () => {
    const r = answerMarketQuestion('how are my listings doing?', SNAP);
    expect(r.intent).toBe('mine');
    expect(r.reply).toContain('1 listing');
    expect(r.reply).toContain('1 open offer');
  });

  it('ranks demand from open wanted requests', () => {
    const r = answerMarketQuestion("what's in demand?", SNAP);
    expect(r.intent).toBe('demand');
    expect(r.reply).toContain('Furniture (2 requests)');
  });

  it('answers fees honestly (no commission)', () => {
    const r = answerMarketQuestion('what are the fees?', SNAP);
    expect(r.reply).toContain('no commission');
  });
});

describe('marketSystemPrompt', () => {
  it('embeds grounded board stats + scope rules', () => {
    const p = marketSystemPrompt(SNAP);
    expect(p).toContain('Marketplace specialist');
    expect(p).toContain('LIVE BOARD (8 available listings)');
    expect(p).toContain('sports:');
    expect(p).toContain('OPEN REQUESTS');
    expect(p).toContain('never invent');
  });
});
