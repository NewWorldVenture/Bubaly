// design/tokens.ts — typed access to Bubaly's shared design tokens.
//
// This module is the ONE place the visual language is defined. The web app
// consumes the same values through app/globals.css + tailwind.config.ts (a unit
// test, tests/design-tokens.test.ts, fails the build if they drift) and the Expo
// mobile app imports this file directly (mobile/src/theme/tokens.ts).
//
// Keep this framework-free: no DOM, no React, no React Native imports — it must
// load identically under Node (vitest), Next.js, and Metro.
import tokensJson from './tokens.json';

export type RgbTriple = readonly [number, number, number];
export type ThemeMode = 'dark' | 'light';
export type ColorToken = keyof typeof tokensJson.colors.dark;
export type RadiusToken = keyof typeof tokensJson.radius;
export type SpacingToken = keyof typeof tokensJson.spacing;
export type FontSizeToken = keyof typeof tokensJson.font.size;

type ColorScale = Record<ColorToken, RgbTriple>;

export const tokens = tokensJson as typeof tokensJson & {
  colors: Record<ThemeMode, ColorScale>;
};

/** Every color token name, in declaration order (dark and light share keys). */
export const COLOR_TOKENS = Object.keys(tokensJson.colors.dark) as ColorToken[];

/** The product default when a user has no stored preference. */
export const DEFAULT_THEME_MODE = tokensJson.theme.default as ThemeMode;

const clamp = (n: number) => Math.min(255, Math.max(0, Math.round(n)));

/** `rgb(r, g, b)` or, with alpha < 1, `rgba(r, g, b, a)` — valid in CSS and React Native. */
export function rgb(triple: RgbTriple, alpha = 1): string {
  const [r, g, b] = triple.map(clamp);
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
}

/** `#rrggbb` form, for places that only accept hex (e.g. native config files). */
export function hex(triple: RgbTriple): string {
  return `#${triple.map((c) => clamp(c).toString(16).padStart(2, '0')).join('')}`;
}

/** The space-separated `r g b` form used by the CSS custom properties. */
export function cssVarValue(triple: RgbTriple): string {
  return triple.map(clamp).join(' ');
}

/** `brandText` → `--brand-text` (the exact custom property name in globals.css). */
export function cssVarName(token: ColorToken): string {
  return `--${token.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
}

/** Concrete color strings for a mode — what a React Native stylesheet wants. */
export function palette(mode: ThemeMode): Record<ColorToken, string> {
  const scale = tokens.colors[mode];
  return Object.fromEntries(COLOR_TOKENS.map((k) => [k, rgb(scale[k])])) as Record<ColorToken, string>;
}

/** Glassmorphism surface + border colors for a mode (same recipe as `.glass` on web). */
export function glassColors(mode: ThemeMode): { background: string; border: string } {
  const base = tokens.colors[mode].glass;
  const g = tokens.glass[mode];
  return { background: rgb(base, g.alpha), border: rgb(base, g.border) };
}

export const radius = tokens.radius;
export const spacing = tokens.spacing;
export const font = tokens.font;
export const layout = tokens.layout;
export const motion = tokens.motion;
