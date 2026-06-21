// Pure, framework-free theme logic — shared by the hook, the toggle, and the
// pre-paint script, and unit-tested in isolation. Keep this DOM/React-free.

export type Theme = 'dark' | 'light' | 'system';

/** localStorage key. MUST match the key used in theme-script.tsx. */
export const THEME_KEY = 'bubaly-theme';

/** Product default when nothing is stored. */
export const DEFAULT_THEME: Theme = 'dark';

/** Selectable themes (order used by any future segmented control). */
export const THEMES: readonly Theme[] = ['light', 'dark', 'system'];

export const isTheme = (v: unknown): v is Theme =>
  v === 'dark' || v === 'light' || v === 'system';

/** Resolve a stored preference to a concrete mode given the OS preference. */
export function resolveTheme(theme: Theme, prefersLight: boolean): 'dark' | 'light' {
  if (theme === 'system') return prefersLight ? 'light' : 'dark';
  return theme;
}

/** The mode you land on when toggling from the current resolved mode. */
export function nextTheme(resolved: 'dark' | 'light'): 'dark' | 'light' {
  return resolved === 'dark' ? 'light' : 'dark';
}
