import { describe, it, expect } from 'vitest';
import { customerHealth, summarizeHealth, bandFor } from '@/lib/marketing/health';

const now = new Date('2026-06-22T00:00:00Z').getTime();
const recent = '2026-06-21T00:00:00Z';
const old = '2026-04-01T00:00:00Z';

describe('bandFor', () => {
  it('maps scores to bands', () => {
    expect(bandFor(85)).toBe('healthy');
    expect(bandFor(55)).toBe('monitor');
    expect(bandFor(20)).toBe('at_risk');
  });
});

describe('customerHealth', () => {
  it('scores an engaged active family high and low-risk', () => {
    const h = customerHealth({ lifecycle: 'active', memberCount: 4, lastActivityAt: recent }, now);
    expect(h.score).toBeGreaterThanOrEqual(80); // 75 +15 +8
    expect(h.band).toBe('healthy');
    expect(h.churnRisk).toBe(false);
  });

  it('flags a long-inactive lapsed family as churn risk', () => {
    const h = customerHealth({ lifecycle: 'lapsed', memberCount: 1, lastActivityAt: old }, now);
    expect(h.churnRisk).toBe(true);
    expect(h.band).toBe('at_risk');
    expect(h.inactiveDays).toBeGreaterThan(30);
  });

  it('treats unparseable dates as very inactive', () => {
    const h = customerHealth({ lifecycle: 'free', memberCount: 0, lastActivityAt: 'n/a' }, now);
    expect(h.inactiveDays).toBe(999);
    expect(h.churnRisk).toBe(true);
  });
});

describe('summarizeHealth', () => {
  it('tallies bands and averages', () => {
    const s = summarizeHealth([
      customerHealth({ lifecycle: 'active', memberCount: 4, lastActivityAt: recent }, now),
      customerHealth({ lifecycle: 'churned', memberCount: 1, lastActivityAt: old }, now),
    ]);
    expect(s.healthy).toBe(1);
    expect(s.atRisk).toBe(1);
    expect(s.churnRisk).toBe(1);
    expect(s.avgScore).not.toBeNull();
  });
  it('handles empty input', () => {
    expect(summarizeHealth([]).avgScore).toBeNull();
  });
});
