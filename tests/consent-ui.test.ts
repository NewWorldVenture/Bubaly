import { describe, it, expect } from 'vitest';
import {
  CONSENT_UI, presetAcceptAll, presetRejectNonEssential, normalizeState,
  shouldShowBanner, parseUtmParams,
} from '@/lib/marketing/consent-ui';
import { CONSENT_CATEGORIES } from '@/lib/marketing/consent';

describe('CONSENT_UI', () => {
  it('covers every category exactly once and only locks necessary', () => {
    expect(CONSENT_UI.map((c) => c.key).sort()).toEqual([...CONSENT_CATEGORIES].sort());
    expect(CONSENT_UI.filter((c) => c.locked).map((c) => c.key)).toEqual(['necessary']);
  });
});

describe('presets', () => {
  it('accept-all grants everything', () => {
    const s = presetAcceptAll();
    expect(Object.values(s).every(Boolean)).toBe(true);
  });

  it('reject keeps only necessary', () => {
    const s = presetRejectNonEssential();
    expect(s.necessary).toBe(true);
    expect(s.analytics).toBe(false);
    expect(s.personalization).toBe(false);
    expect(s.marketing_email).toBe(false);
    expect(s.marketing_sms).toBe(false);
  });
});

describe('normalizeState', () => {
  it('fills defaults and forces necessary on', () => {
    const s = normalizeState({ analytics: true, necessary: false });
    expect(s.necessary).toBe(true);
    expect(s.analytics).toBe(true);
    expect(s.marketing_email).toBe(false); // default
  });
});

describe('shouldShowBanner', () => {
  it('shows only when undecided and no GPC', () => {
    expect(shouldShowBanner({ decided: false, gpc: false })).toBe(true);
    expect(shouldShowBanner({ decided: true, gpc: false })).toBe(false);
    expect(shouldShowBanner({ decided: false, gpc: true })).toBe(false); // GPC honored silently
    expect(shouldShowBanner({ decided: true, gpc: true })).toBe(false);
  });
});

describe('parseUtmParams', () => {
  it('pulls utm params, falls back ref → source', () => {
    expect(parseUtmParams('?utm_source=newsletter&utm_medium=email&utm_campaign=launch'))
      .toEqual({ source: 'newsletter', medium: 'email', campaign: 'launch' });
    expect(parseUtmParams('?ref=partner')).toEqual({ source: 'partner', medium: null, campaign: null });
    expect(parseUtmParams('')).toEqual({ source: null, medium: null, campaign: null });
  });
});
