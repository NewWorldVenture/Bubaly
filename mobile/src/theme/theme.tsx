import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { font, glassColors, layout, motion, palette, radius, spacing, type ColorToken } from './tokens';
import {
  DEFAULT_THEME, THEME_STORAGE_KEY, isThemePreference, nextTheme, resolveTheme,
  type ResolvedTheme, type ThemePreference,
} from './theme-core';

export type Theme = {
  mode: ResolvedTheme;
  preference: ThemePreference;
  colors: Record<ColorToken, string>;
  glass: { background: string; border: string };
  radius: typeof radius;
  spacing: typeof spacing;
  font: typeof font;
  layout: typeof layout;
  motion: typeof motion;
  setPreference: (preference: ThemePreference) => void;
  toggle: () => void;
};

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>(DEFAULT_THEME);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(THEME_STORAGE_KEY)
      .then((stored) => { if (alive && isThemePreference(stored)) setPreferenceState(stored); })
      .catch(() => { /* fall back to the default */ });
    return () => { alive = false; };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    AsyncStorage.setItem(THEME_STORAGE_KEY, next).catch(() => { /* best-effort persistence */ });
  }, []);

  const mode = resolveTheme(preference, systemScheme);
  const toggle = useCallback(() => setPreference(nextTheme(mode)), [mode, setPreference]);

  const value = useMemo<Theme>(() => ({
    mode, preference, colors: palette(mode), glass: glassColors(mode),
    radius, spacing, font, layout, motion, setPreference, toggle,
  }), [mode, preference, setPreference, toggle]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('useTheme must be used inside <ThemeProvider>');
  return theme;
}
