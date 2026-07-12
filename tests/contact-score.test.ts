import { describe, it, expect } from 'vitest';
import {
  scoreContact, contactBandFor, type ContactSignals,
} from '@/lib/marketing/contact-score';

const base: ContactSignals = {
  hasEmail: false, identified: false, sessionCount: 0, daysSinceLastSeen: null,
  conversions: 0, startedDemo: false, marketingConsent: false, analyticsConsent: false,
  profileCompleteness: 0, isCustomer: false,
};

describe('contactBandFor', () => {
  it('maps score → band at the thresholds', () => {
    expect(contactBandFor(0)).toBe('cold');
    expect(contactBandFor(24)).toBe('cold');
    expect(contactBandFor(25)).toBe('warm');
    expect(contactBandFor(49)).toBe('warm');
    expect(contactBandFor(50)).toBe('hot');
    expect(contactBandFor(74)).toBe('hot');
    expect(contactBandFor(75)).toBe('qualified');
    expect(contactBandFor(100)).toBe('qualified');
  });
});

describe('scoreContact', () => {
  it('scores an empty contact at 0 (cold) with no factors', () => {
    const r = scoreContact(base);
    expect(r.score).toBe(0);
    expect(r.band).toBe('cold');
    expect(r.factors).toEqual([]);
  });

  it('builds a transparent ledger that sums to the score', () => {
    const r = scoreContact({ ...base, hasEmail: true, sessionCount: 3, analyticsConsent: true });
    // email 6 + sessions 3*2=6 + analytics 3 = 15
    expect(r.score).toBe(15);
    expect(r.factors.reduce((s, f) => s + f.points, 0)).toBe(15);
    expect(r.factors.map((f) => f.key)).toEqual(['email', 'sessions', 'analytics_consent']);
  });

  it('caps sessions at 10 and conversions at 3', () => {
    const r = scoreContact({ ...base, sessionCount: 50, conversions: 9 });
    const sessions = r.factors.find((f) => f.key === 'sessions')!;
    const conv = r.factors.find((f) => f.key === 'conversions')!;
    expect(sessions.points).toBe(20); // 10 * 2
    expect(conv.points).toBe(30);     // 3 * 10
  });

  it('rewards recency by band', () => {
    expect(scoreContact({ ...base, daysSinceLastSeen: 3 }).factors[0].points).toBe(12);
    expect(scoreContact({ ...base, daysSinceLastSeen: 20 }).factors[0].points).toBe(6);
    expect(scoreContact({ ...base, daysSinceLastSeen: 90 }).factors).toEqual([]);
  });

  it('clamps the total to 100 for a maxed-out lead', () => {
    const r = scoreContact({
      hasEmail: true, identified: true, sessionCount: 10, daysSinceLastSeen: 1,
      conversions: 3, startedDemo: true, marketingConsent: true, analyticsConsent: true,
      profileCompleteness: 1, isCustomer: true,
    });
    expect(r.score).toBe(100);
    expect(r.band).toBe('qualified');
  });

  it('scales profile completeness to ~12 points', () => {
    expect(scoreContact({ ...base, profileCompleteness: 1 }).factors[0].points).toBe(12);
    expect(scoreContact({ ...base, profileCompleteness: 0.5 }).factors[0].points).toBe(6);
    expect(scoreContact({ ...base, profileCompleteness: 0 }).factors).toEqual([]);
  });
});
