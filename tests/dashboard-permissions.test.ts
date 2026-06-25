import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DASH_SETTINGS, normalizeSettings, canCustomizeDashboard, canManageFamilyDashboard, effectiveSavedKeys,
} from '@/lib/dashboard/permissions';

describe('normalizeSettings', () => {
  it('fills defaults', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_DASH_SETTINGS);
    expect(normalizeSettings({ allowChildCustomization: false })).toEqual({ allowChildCustomization: false, lockToFamilyDefault: false });
  });
});

describe('canCustomizeDashboard', () => {
  const open = { allowChildCustomization: true, lockToFamilyDefault: false };
  const noKids = { allowChildCustomization: false, lockToFamilyDefault: false };
  const locked = { allowChildCustomization: true, lockToFamilyDefault: true };

  it('parents can always customize when not locked', () => {
    expect(canCustomizeDashboard(true, open)).toBe(true);
    expect(canCustomizeDashboard(true, noKids)).toBe(true);
  });
  it('children only when allowed', () => {
    expect(canCustomizeDashboard(false, open)).toBe(true);
    expect(canCustomizeDashboard(false, noKids)).toBe(false);
  });
  it('locked-to-default: only parents may change', () => {
    expect(canCustomizeDashboard(true, locked)).toBe(true);
    expect(canCustomizeDashboard(false, locked)).toBe(false);
  });
});

describe('canManageFamilyDashboard', () => {
  it('is parent/admin only', () => {
    expect(canManageFamilyDashboard(true)).toBe(true);
    expect(canManageFamilyDashboard(false)).toBe(false);
  });
});

describe('effectiveSavedKeys', () => {
  const open = { allowChildCustomization: true, lockToFamilyDefault: false };
  const locked = { allowChildCustomization: true, lockToFamilyDefault: true };

  it('personal wins, then family, then null', () => {
    expect(effectiveSavedKeys(['a'], ['b'], open)).toEqual(['a']);
    expect(effectiveSavedKeys(null, ['b'], open)).toEqual(['b']);
    expect(effectiveSavedKeys(null, null, open)).toBeNull();
  });
  it('locked: family default always wins, ignoring personal', () => {
    expect(effectiveSavedKeys(['a'], ['b'], locked)).toEqual(['b']);
    expect(effectiveSavedKeys(['a'], null, locked)).toBeNull();
  });
});
