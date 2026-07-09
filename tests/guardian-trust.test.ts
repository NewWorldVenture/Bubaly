import { describe, it, expect } from 'vitest';
import {
  shouldRingImmediately, isBlocked, requiresScreening, trustFromSpamScore, explainTrustDecision,
  TRUST_LEVELS, type TrustLevel,
} from '@/lib/guardian/trust';

describe('routing predicates', () => {
  it('shouldRingImmediately only for family + trusted friend', () => {
    const ring: TrustLevel[] = ['immediate_family', 'close_family', 'trusted_friend'];
    for (const l of TRUST_LEVELS) {
      expect(shouldRingImmediately(l)).toBe(ring.includes(l));
    }
  });

  it('isBlocked only for blocked', () => {
    for (const l of TRUST_LEVELS) expect(isBlocked(l)).toBe(l === 'blocked');
  });

  it('requiresScreening for known/unknown/suspected', () => {
    const screen: TrustLevel[] = ['known_contact', 'unknown', 'suspected_spam'];
    for (const l of TRUST_LEVELS) expect(requiresScreening(l)).toBe(screen.includes(l));
  });

  it('a level is never both ring-through and blocked/screened', () => {
    for (const l of TRUST_LEVELS) {
      if (shouldRingImmediately(l)) {
        expect(isBlocked(l)).toBe(false);
        expect(requiresScreening(l)).toBe(false);
      }
    }
  });
});

describe('trustFromSpamScore', () => {
  it('maps score bands to trust levels', () => {
    expect(trustFromSpamScore(95)).toBe<TrustLevel>('blocked');
    expect(trustFromSpamScore(90)).toBe<TrustLevel>('blocked');
    expect(trustFromSpamScore(89)).toBe<TrustLevel>('suspected_spam');
    expect(trustFromSpamScore(70)).toBe<TrustLevel>('suspected_spam');
    expect(trustFromSpamScore(69)).toBe<TrustLevel>('unknown');
    expect(trustFromSpamScore(0)).toBe<TrustLevel>('unknown');
  });
});

describe('explainTrustDecision', () => {
  it('names the caller and explains the routing', () => {
    expect(explainTrustDecision('immediate_family', 'Mom', 0)).toMatch(/Mom.*Immediate Family.*rings? through/i);
    expect(explainTrustDecision('blocked', 'Spam Co', 95)).toMatch(/blocked.*ended immediately/i);
    expect(explainTrustDecision('known_contact', 'Dr. Lee', 10)).toMatch(/AI screens first/i);
  });

  it('includes the spam score for suspected spam and falls back to "This caller"', () => {
    const msg = explainTrustDecision('suspected_spam', null, 82);
    expect(msg).toMatch(/This caller/);
    expect(msg).toMatch(/82\/100/);
  });

  it('describes an unknown caller as screened + summarised', () => {
    expect(explainTrustDecision('unknown', null, 30)).toMatch(/unknown caller.*screened.*summarize/i);
  });
});
