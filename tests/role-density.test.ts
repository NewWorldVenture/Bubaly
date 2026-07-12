import { describe, it, expect } from 'vitest';
import {
  resolveDensity, DENSITY_FONT_PCT, DENSITY_OPTIONS,
} from '@/lib/ui/role-surface';

describe('resolveDensity', () => {
  it('uses the role default when there is no valid override', () => {
    expect(resolveDensity('parent', null)).toBe('comfortable');
    expect(resolveDensity('child', 'auto')).toBe('playful');
    expect(resolveDensity('teen', undefined)).toBe('cozy');
    expect(resolveDensity('caregiver', 'nonsense')).toBe('comfortable');
  });

  it('lets an explicit override win over the role default', () => {
    expect(resolveDensity('child', 'comfortable')).toBe('comfortable'); // child default is playful
    expect(resolveDensity('parent', 'playful')).toBe('playful');
    expect(resolveDensity('adult', 'cozy')).toBe('cozy');
  });
});

describe('DENSITY_FONT_PCT', () => {
  it('scales up from the comfortable baseline', () => {
    expect(DENSITY_FONT_PCT.comfortable).toBe(100);
    expect(DENSITY_FONT_PCT.cozy).toBeGreaterThan(100);
    expect(DENSITY_FONT_PCT.playful).toBeGreaterThan(DENSITY_FONT_PCT.cozy);
  });
});

describe('DENSITY_OPTIONS', () => {
  it('offers the three densities in increasing order', () => {
    expect(DENSITY_OPTIONS).toEqual(['comfortable', 'cozy', 'playful']);
  });
});
