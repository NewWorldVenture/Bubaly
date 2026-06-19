'use client';

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light' | 'system';
const KEY = 'familyos-theme';

function systemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function apply(theme: Theme) {
  const resolved = theme === 'system' ? systemTheme() : theme;
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
}

/**
 * Theme controller. Persists choice to localStorage and (optionally) syncs to
 * Supabase user_preferences via the caller. Defaults to dark.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>('dark');

  useEffect(() => {
    const stored = (localStorage.getItem(KEY) as Theme | null) ?? 'dark';
    setThemeState(stored);
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
    localStorage.setItem(KEY, next);
    apply(next);
    setThemeState(next);
  }, []);

  const toggle = useCallback(() => {
    const resolved = theme === 'system' ? systemTheme() : theme;
    setTheme(resolved === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return { theme, setTheme, toggle };
}
