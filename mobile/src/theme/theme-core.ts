// Pure, framework-free theme logic — mirrors components/theme/theme-core.ts on
// the web (same preference model, same default) and is unit-tested from the
// repo root (tests/mobile-core.test.ts). Keep React Native imports out.
import { DEFAULT_THEME_MODE, type ThemeMode } from './tokens';

export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = ThemeMode;

/** AsyncStorage key (mirrors the web's localStorage key). */
export const THEME_STORAGE_KEY = 'bubaly-theme';

/** Product default when nothing is stored: dark, like the web. */
export const DEFAULT_THEME: ThemePreference = DEFAULT_THEME_MODE;

export const THEME_PREFERENCES: readonly ThemePreference[] = ['dark', 'light', 'system'];

export const isThemePreference = (v: unknown): v is ThemePreference =>
  v === 'dark' || v === 'light' || v === 'system';

/**
 * Resolve a preference to a concrete mode given the OS scheme. Anything other
 * than an explicit 'light' (including React Native's 'unspecified') is dark —
 * the same rule the web applies to `prefers-color-scheme`.
 */
export function resolveTheme(preference: ThemePreference, systemScheme: string | null | undefined): ResolvedTheme {
  if (preference === 'system') return systemScheme === 'light' ? 'light' : 'dark';
  return preference;
}

/** The mode you land on when toggling from the current resolved mode. */
export function nextTheme(resolved: ResolvedTheme): ResolvedTheme {
  return resolved === 'dark' ? 'light' : 'dark';
}
