import { describe, it, expect } from 'vitest';
import {
  resolveConsent, DEFAULT_CONSENT, canRecordAnalytics, canPersonalize, canMarketEmail,
  toConsentCategory, type ConsentEvent,
} from '@/lib/marketing/consent';

const ev = (category: string, decision: string, created_at: string): ConsentEvent =>
  ({ category, decision, created_at }) as ConsentEvent;

describe('resolveConsent', () => {
  it('defaults: necessary + analytics on (legitimate interest), personalization/marketing off (opt-in)', () => {
    const s = resolveConsent([]);
    expect(s).toEqual(DEFAULT_CONSENT);
    expect(s.necessary).toBe(true);
    expect(canRecordAnalytics(s)).toBe(true);
    expect(canPersonalize(s)).toBe(false);
    expect(canMarketEmail(s)).toBe(false);
  });

  it('explicit grant turns an opt-in category on', () => {
    const s = resolveConsent([ev('marketing_email', 'granted', '2026-01-01T00:00:00Z')]);
    expect(canMarketEmail(s)).toBe(true);
  });

  it('latest decision wins (revocation)', () => {
    const s = resolveConsent([
      ev('analytics', 'granted', '2026-01-01T00:00:00Z'),
      ev('analytics', 'denied', '2026-02-01T00:00:00Z'),
    ]);
    expect(canRecordAnalytics(s)).toBe(false);
  });

  it('re-grant after a denial wins when it is newer', () => {
    const s = resolveConsent([
      ev('marketing_email', 'denied', '2026-01-01T00:00:00Z'),
      ev('marketing_email', 'granted', '2026-03-01T00:00:00Z'),
    ]);
    expect(canMarketEmail(s)).toBe(true);
  });

  it('GPC forces governed categories off when the visitor has not chosen', () => {
    const s = resolveConsent([], { gpc: true });
    expect(s.analytics).toBe(false);
    expect(s.personalization).toBe(false);
    expect(s.marketing_email).toBe(false);
    expect(s.necessary).toBe(true); // still on
  });

  it('an explicit choice overrides GPC for that category', () => {
    const s = resolveConsent([ev('analytics', 'granted', '2026-01-01T00:00:00Z')], { gpc: true });
    expect(s.analytics).toBe(true);       // explicit opt-in respected
    expect(s.marketing_email).toBe(false); // untouched → GPC keeps it off
  });

  it('necessary can never be turned off, even by a denial event', () => {
    const s = resolveConsent([ev('necessary', 'denied', '2026-01-01T00:00:00Z')]);
    expect(s.necessary).toBe(true);
  });

  it('ignores unknown categories via toConsentCategory', () => {
    expect(toConsentCategory('analytics')).toBe('analytics');
    expect(toConsentCategory('tracking')).toBeNull();
    expect(toConsentCategory(42)).toBeNull();
  });
});
