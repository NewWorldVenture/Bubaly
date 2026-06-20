'use client';

import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_THEME, THEME_KEY, isTheme, nextTheme, resolveTheme, type Theme } from './theme-core';

export type { Theme } from './theme-core';

function prefersLight(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: light)').matches;
}

function apply(theme: Theme) {
  const resolved = resolveTheme(theme, prefersLight());
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
}

/**
 * Theme controller. Persists choice to localStorage and applies it to <html>.
 * Defaults to dark; 'system' tracks the OS preference live.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    const stored = localStorage.getItem(THEME_KEY);
    setThemeState(isTheme(stored) ? stored : DEFAULT_THEME);
  }, []);

  // Keep 'system' in sync with OS changes.
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => apply('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(THEME_KEY, next);
    apply(next);
    setThemeState(next);
  }, []);

  const toggle = useCallback(() => {
    setTheme(nextTheme(resolveTheme(theme, prefersLight())));
  }, [theme, setTheme]);

  return { theme, setTheme, toggle };
}
