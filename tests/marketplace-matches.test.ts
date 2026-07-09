import { describe, it, expect } from 'vitest';
import { titleTerms, sharedTerms, scoreMatch, computeMatches, type MatchListing } from '@/lib/marketplace/matches';

const L = (o: Partial<MatchListing> & { id: string; kind: string }): MatchListing => ({
  category: 'other', status: 'available', title: '', member_id: null, price_cents: 0, ...o,
});

describe('titleTerms / sharedTerms', () => {
  it('drops stopwords + short tokens and de-dupes', () => {
    expect(titleTerms('A red Balance BIKE for the kids')).toEqual(['red', 'balance', 'bike']);
  });
  it('finds the meaningful overlap between two titles', () => {
    expect(sharedTerms('Looking for a kids bike', 'Balance bike, like new')).toEqual(['bike']);
  });
});

describe('scoreMatch', () => {
  it('returns null when neither category nor a term matches', () => {
    const w = L({ id: 'w', kind: 'wanted', category: 'sports', title: 'trampoline' });
    const s = L({ id: 's', kind: 'sell', category: 'books', title: 'harry potter' });
    expect(scoreMatch(w, s)).toBeNull();
  });

  it('scores a same-category + shared-term free item highest', () => {
    const w = L({ id: 'w', kind: 'wanted', category: 'sports', title: 'kids bike' });
    const s = L({ id: 's', kind: 'free', category: 'sports', title: 'balance bike' });
    const m = scoreMatch(w, s)!;
    expect(m.sameCategory).toBe(true);
    expect(m.sharedTerms).toEqual(['bike']);
    expect(m.supplyFree).toBe(true);
    // base10 + cat45 + 1 term*22 + free12 = 89
    expect(m.score).toBe(89);
  });

  it('matches on a shared term even across categories', () => {
    const w = L({ id: 'w', kind: 'wanted', category: 'other', title: 'need a drill' });
    const s = L({ id: 's', kind: 'borrow', category: 'tools', title: 'cordless drill' });
    const m = scoreMatch(w, s)!;
    expect(m.sameCategory).toBe(false);
    expect(m.sharedTerms).toEqual(['drill']);
    expect(m.score).toBe(32); // base10 + 1 term*22
  });

  it('does not treat category "other" as a category match', () => {
    const w = L({ id: 'w', kind: 'wanted', category: 'other', title: 'thing one' });
    const s = L({ id: 's', kind: 'sell', category: 'other', title: 'thing two' });
    // shared term "thing" carries it; category must not add its 45
    expect(scoreMatch(w, s)!.score).toBe(32);
  });
});

describe('computeMatches', () => {
  it('pairs open wanted items with open supply from other members', () => {
    const rows: MatchListing[] = [
      L({ id: 'w1', kind: 'wanted', category: 'sports', title: 'kids bike', member_id: 'dad' }),
      L({ id: 's1', kind: 'free', category: 'sports', title: 'balance bike', member_id: 'mom' }),
      L({ id: 's2', kind: 'sell', category: 'books', title: 'novel', member_id: 'mom' }),
    ];
    const matches = computeMatches(rows);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ wantedId: 'w1', supplyId: 's1' });
  });

  it('never matches a member to their own supply', () => {
    const rows: MatchListing[] = [
      L({ id: 'w1', kind: 'wanted', category: 'toys', title: 'lego set', member_id: 'kid' }),
      L({ id: 's1', kind: 'sell', category: 'toys', title: 'lego city', member_id: 'kid' }),
    ];
    expect(computeMatches(rows)).toHaveLength(0);
  });

  it('ignores withdrawn/completed listings on both sides', () => {
    const rows: MatchListing[] = [
      L({ id: 'w1', kind: 'wanted', category: 'toys', title: 'lego', member_id: 'a', status: 'available' }),
      L({ id: 's1', kind: 'sell', category: 'toys', title: 'lego', member_id: 'b', status: 'withdrawn' }),
      L({ id: 'w2', kind: 'wanted', category: 'toys', title: 'lego', member_id: 'a', status: 'completed' }),
    ];
    expect(computeMatches(rows)).toHaveLength(0);
  });

  it('caps matches per wanted and sorts by score desc', () => {
    const rows: MatchListing[] = [
      L({ id: 'w1', kind: 'wanted', category: 'games', title: 'board game', member_id: 'a' }),
      L({ id: 's1', kind: 'free', category: 'games', title: 'board game', member_id: 'b' }),
      L({ id: 's2', kind: 'sell', category: 'games', title: 'card game', member_id: 'b' }),
      L({ id: 's3', kind: 'sell', category: 'games', title: 'dice game', member_id: 'b' }),
      L({ id: 's4', kind: 'sell', category: 'games', title: 'video game', member_id: 'b' }),
    ];
    const matches = computeMatches(rows, 3);
    expect(matches).toHaveLength(3);
    expect(matches[0].supplyId).toBe('s1'); // free + shared "board" scores highest
    expect(matches[0].score).toBeGreaterThanOrEqual(matches[1].score);
  });
});
