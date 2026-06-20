import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  THEME_KEY,
  THEMES,
  isTheme,
  nextTheme,
  resolveTheme,
} from '@/components/theme/theme-core';

// Pure theme logic shared by the hook, toggle, and pre-paint script. The DOM
// application (class on <html>) is exercised in the browser; here we lock down
// the resolution rules so the global theme behaves consistently everywhere.
describe('theme core', () => {
  it('defaults to dark and persists under a stable key', () => {
    expect(DEFAULT_THEME).toBe('dark');
    // Must match the key hard-coded in theme-script.tsx (no-flash loader).
    expect(THEME_KEY).toBe('familyos-theme');
  });

  it('validates theme values', () => {
    expect(THEMES).toEqual(['light', 'dark', 'system']);
    for (const t of THEMES) expect(isTheme(t)).toBe(true);
    expect(isTheme('blue')).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isTheme(undefined)).toBe(false);
  });

  it('resolves explicit preferences directly', () => {
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('falls back to the OS preference under "system"', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
  });

  it('toggles between the two concrete modes', () => {
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    // Toggling twice returns to the start.
    expect(nextTheme(nextTheme('dark'))).toBe('dark');
  });
});
