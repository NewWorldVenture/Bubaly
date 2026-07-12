import { describe, it, expect } from 'vitest';
import { decideStitch, shouldCarryConsent } from '@/lib/marketing/identity-core';

describe('decideStitch', () => {
  it('links an unlinked visitor to the contact', () => {
    expect(decideStitch({ visitorFound: true, visitorContactId: null, targetContactId: 'c1' })).toBe('link');
  });

  it('no-ops when the visitor is already linked to this same contact', () => {
    expect(decideStitch({ visitorFound: true, visitorContactId: 'c1', targetContactId: 'c1' })).toBe('noop');
  });

  it('no-ops when there is no visitor spine to attach', () => {
    expect(decideStitch({ visitorFound: false, visitorContactId: null, targetContactId: 'c1' })).toBe('noop');
  });

  it('forks when the visitor is tied to a DIFFERENT contact (shared device)', () => {
    expect(decideStitch({ visitorFound: true, visitorContactId: 'c1', targetContactId: 'c2' })).toBe('fork');
  });

  it('forks even if visitorFound is somehow false but a foreign link exists', () => {
    expect(decideStitch({ visitorFound: false, visitorContactId: 'c1', targetContactId: 'c2' })).toBe('fork');
  });
});

describe('shouldCarryConsent', () => {
  it('carries consent for same-person outcomes, never on a fork', () => {
    expect(shouldCarryConsent('link')).toBe(true);
    expect(shouldCarryConsent('noop')).toBe(true);
    expect(shouldCarryConsent('fork')).toBe(false);
  });
});
