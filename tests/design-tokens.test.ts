import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COLOR_TOKENS, DEFAULT_THEME_MODE, cssVarName, cssVarValue, glassColors, hex, palette, rgb, tokens,
} from '@/design/tokens';
import { DEFAULT_THEME } from '@/components/theme/theme-core';

const css = readFileSync('app/globals.css', 'utf8');

function block(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `selector ${selector} missing from globals.css`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

function cssVar(body: string, name: string): string {
  const m = new RegExp(`${name.replace(/[-]/g, '\\-')}:\\s*([^;]+);`).exec(body);
  expect(m, `${name} missing`).not.toBeNull();
  return m![1].trim();
}

describe('design tokens stay in sync with the web theme', () => {
  const dark = block(':root,\n.dark');
  const light = block('\n.light {');

  it('every color token matches its CSS custom property in both modes', () => {
    for (const token of COLOR_TOKENS) {
      const name = cssVarName(token);
      expect(cssVar(dark, name), `${name} (dark)`).toBe(cssVarValue(tokens.colors.dark[token]));
      expect(cssVar(light, name), `${name} (light)`).toBe(cssVarValue(tokens.colors.light[token]));
    }
  });

  it('glass alpha + border opacity match', () => {
    expect(Number(cssVar(dark, '--glass-alpha'))).toBe(tokens.glass.dark.alpha);
    expect(Number(cssVar(dark, '--glass-border'))).toBe(tokens.glass.dark.border);
    expect(Number(cssVar(light, '--glass-alpha'))).toBe(tokens.glass.light.alpha);
    expect(Number(cssVar(light, '--glass-border'))).toBe(tokens.glass.light.border);
  });

  it('radii and layout metrics match (rem → px at 16px root)', () => {
    const root = block(':root {');
    for (const [key, px] of Object.entries(tokens.radius)) {
      const rem = parseFloat(cssVar(root, `--radius-${key}`));
      expect(rem * 16, `--radius-${key}`).toBe(px);
    }
    expect(parseInt(cssVar(root, '--sidebar-width'), 10)).toBe(tokens.layout.sidebarWidth);
    expect(parseInt(cssVar(root, '--topbar-height'), 10)).toBe(tokens.layout.topbarHeight);
    expect(parseInt(cssVar(root, '--mobile-tab-height'), 10)).toBe(tokens.layout.mobileTabHeight);
  });

  it('font stack and default theme match the web implementation', () => {
    const root = block(':root {');
    expect(cssVar(root, '--font-sans').replace(/\s+/g, ' ')).toBe(tokens.font.stack);
    expect(DEFAULT_THEME_MODE).toBe(DEFAULT_THEME);
    expect(tokens.theme.modes).toEqual(['dark', 'light']);
  });
});

describe('token helpers', () => {
  it('formats colors for CSS and React Native', () => {
    expect(rgb([116, 75, 232])).toBe('rgb(116, 75, 232)');
    expect(rgb([116, 75, 232], 0.5)).toBe('rgba(116, 75, 232, 0.5)');
    expect(hex([116, 75, 232])).toBe('#744be8');
    expect(cssVarValue([3, 9, 15])).toBe('3 9 15');
    expect(cssVarName('brandText')).toBe('--brand-text');
    expect(cssVarName('bg')).toBe('--bg');
  });

  it('builds a full palette per mode with every token present', () => {
    const dark = palette('dark');
    const light = palette('light');
    for (const token of COLOR_TOKENS) {
      expect(dark[token]).toMatch(/^rgb\(/);
      expect(light[token]).toMatch(/^rgb\(/);
    }
    expect(dark.bg).not.toBe(light.bg);
    expect(glassColors('dark')).toEqual({ background: 'rgba(255, 255, 255, 0.04)', border: 'rgba(255, 255, 255, 0.1)' });
  });
});
