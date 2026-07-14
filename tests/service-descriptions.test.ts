import { describe, it, expect } from 'vitest';
import {
  SERVICE_DESCRIPTIONS, SERVICE_DESCRIPTION_KEYS,
  mergeServiceDescriptions, serviceDescription,
} from '@/lib/services/descriptions';
import { APP_NAV_GROUPS } from '@/lib/constants/navigation';

describe('service descriptions — catalog coverage', () => {
  it('has a non-empty default for every service in the All Services catalog', () => {
    const keys = new Set<string>();
    for (const g of APP_NAV_GROUPS) for (const it of g.items) keys.add(it.href);
    const missing = [...keys].filter((k) => !(k in SERVICE_DESCRIPTIONS) || !SERVICE_DESCRIPTIONS[k].trim());
    expect(missing).toEqual([]);
  });

  it('every default is a concise single sentence-ish blurb (<= 400 chars)', () => {
    for (const [key, text] of Object.entries(SERVICE_DESCRIPTIONS)) {
      expect(text.length, key).toBeGreaterThan(10);
      expect(text.length, key).toBeLessThanOrEqual(400);
    }
  });

  it('exports its keys', () => {
    expect(SERVICE_DESCRIPTION_KEYS.length).toBe(Object.keys(SERVICE_DESCRIPTIONS).length);
  });
});

describe('mergeServiceDescriptions', () => {
  it('overlays non-empty overrides for known keys over the defaults', () => {
    const merged = mergeServiceDescriptions({ '/dashboard/calendar': 'Custom calendar blurb.' });
    expect(merged['/dashboard/calendar']).toBe('Custom calendar blurb.');
    // Untouched keys keep their default.
    expect(merged['/dashboard/meals']).toBe(SERVICE_DESCRIPTIONS['/dashboard/meals']);
  });

  it('ignores empty/whitespace overrides (keeps the default)', () => {
    const merged = mergeServiceDescriptions({ '/dashboard/calendar': '   ' });
    expect(merged['/dashboard/calendar']).toBe(SERVICE_DESCRIPTIONS['/dashboard/calendar']);
  });

  it('trims override whitespace', () => {
    const merged = mergeServiceDescriptions({ '/dashboard/calendar': '  spaced  ' });
    expect(merged['/dashboard/calendar']).toBe('spaced');
  });

  it('handles null/undefined overrides', () => {
    expect(mergeServiceDescriptions(null)['/dashboard/calendar']).toBe(SERVICE_DESCRIPTIONS['/dashboard/calendar']);
    expect(mergeServiceDescriptions(undefined)['/wallet']).toBe(SERVICE_DESCRIPTIONS['/wallet']);
  });

  it('does not mutate the defaults object', () => {
    const before = SERVICE_DESCRIPTIONS['/wallet'];
    mergeServiceDescriptions({ '/wallet': 'changed' });
    expect(SERVICE_DESCRIPTIONS['/wallet']).toBe(before);
  });
});

describe('serviceDescription', () => {
  it('returns the override when present, else the default, else empty', () => {
    expect(serviceDescription('/wallet', { '/wallet': 'Over' })).toBe('Over');
    expect(serviceDescription('/wallet')).toBe(SERVICE_DESCRIPTIONS['/wallet']);
    expect(serviceDescription('/not-a-real-service')).toBe('');
  });
});
