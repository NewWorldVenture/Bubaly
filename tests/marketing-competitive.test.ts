import { describe, it, expect } from 'vitest';
import {
  normalizeDomain, isBacklinkStatus, clampScore, keywordOpportunity,
  rankKeywordOpportunities, summarizeBacklinks, BACKLINK_STATUSES,
  type BacklinkLike,
} from '@/lib/marketing/competitive';

describe('normalizeDomain', () => {
  it('strips scheme, www, path', () => {
    expect(normalizeDomain('https://www.HubSpot.com/pricing?x=1')).toBe('hubspot.com');
    expect(normalizeDomain('cozi.com')).toBe('cozi.com');
    expect(normalizeDomain('')).toBe('');
  });
});

describe('isBacklinkStatus', () => {
  it('validates statuses', () => {
    expect(BACKLINK_STATUSES.every(isBacklinkStatus)).toBe(true);
    expect(isBacklinkStatus('spam')).toBe(false);
  });
});

describe('clampScore', () => {
  it('clamps 0–100 and rounds; null passes', () => {
    expect(clampScore(120)).toBe(100);
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(42.6)).toBe(43);
    expect(clampScore(null)).toBeNull();
  });
});

describe('keywordOpportunity', () => {
  it('high volume + poor rank = high opportunity', () => {
    const hi = keywordOpportunity({ search_volume: 10_000, our_rank: null });
    const lo = keywordOpportunity({ search_volume: 100, our_rank: 1 });
    expect(hi).toBeGreaterThan(lo);
    expect(hi).toBe(100);
  });
  it('treats unranked as rank 100', () => {
    expect(keywordOpportunity({ search_volume: 5_000, our_rank: null }))
      .toBe(keywordOpportunity({ search_volume: 5_000, our_rank: 100 }));
  });
});

describe('rankKeywordOpportunities', () => {
  it('sorts by opportunity desc', () => {
    const out = rankKeywordOpportunities([
      { id: 'a', search_volume: 100, our_rank: 1 },
      { id: 'b', search_volume: 9000, our_rank: null },
    ]);
    expect(out[0].id).toBe('b');
  });
});

describe('summarizeBacklinks', () => {
  it('counts by status and averages authority', () => {
    const links: BacklinkLike[] = [
      { status: 'active', authority: 80 },
      { status: 'active', authority: 60 },
      { status: 'lost', authority: null },
      { status: 'toxic', authority: 10 },
    ];
    const s = summarizeBacklinks(links);
    expect(s.active).toBe(2);
    expect(s.lost).toBe(1);
    expect(s.toxic).toBe(1);
    expect(s.avgAuthority).toBe(50); // (80+60+10)/3
  });
});
