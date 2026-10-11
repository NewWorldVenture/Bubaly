import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { between, bodyOf } from './helpers/source-order';

const SOURCE_EXTENSIONS = new Set(['.css', '.ts', '.tsx']);

function collectSource(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectSource(path);
      return SOURCE_EXTENSIONS.has(extname(entry.name)) ? readFileSync(path, 'utf8') : '';
    })
    .join('\n');
}

describe('accessible brand color roles', () => {
  it('defines separate action-background and text colors in both themes', () => {
    const globals = readFileSync(resolve('app/globals.css'), 'utf8');
    const tailwind = readFileSync(resolve('tailwind.config.ts'), 'utf8');

    expect(globals.match(/--brand-text:/g)).toHaveLength(2);
    expect(tailwind).toContain("text: 'rgb(var(--brand-text) / <alpha-value>)'");
  });

  it('does not reuse the solid brand color for text', () => {
    const source = [collectSource(resolve('app')), collectSource(resolve('components')), collectSource(resolve('lib'))].join('\n');
    expect(source).not.toMatch(/\btext-brand(?!-[A-Za-z0-9])/);
  });
});

// ── Contrast, measured ────────────────────────────────────────────────────────
//
// The two cases above pin the SHAPE of the brand fix — that a --brand-text token
// exists and that text-brand is never used. Neither computes a ratio, which is why
// they were green while four semantic text colours failed WCAG AA in light mode:
//
//   --accent   2.67    --success  2.91    --warning  2.70    --danger  4.09
//
// across 506 `text-*` sites, 295 of them text-danger. The first three failed even
// the 3:1 floor for large text. Dark mode was 7.13 to 11.74 throughout — which is
// how it went unnoticed, since the app's own default theme is the dark one.
//
// A guard that asserts a token exists cannot see that. These read the tokens out of
// app/globals.css and measure, so the property is checked rather than the solution.

const CHANNEL = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2.x relative luminance. */
const luminance = ([r, g, b]: number[]) =>
  0.2126 * CHANNEL(r) + 0.7152 * CHANNEL(g) + 0.0722 * CHANNEL(b);

const contrast = (a: number[], b: number[]) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

/**
 * The tokens of one theme block, as `{ name: [r, g, b] }`.
 *
 * Read from the stylesheet rather than duplicated here: a copy would let the two
 * drift, and the drift would be invisible because the copy is what gets asserted.
 */
function tokensOf(css: string, selector: string): Record<string, number[]> {
  const start = css.indexOf(selector);
  expect(start, `${selector} not found in app/globals.css`).toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf('\n}', start));
  const out: Record<string, number[]> = {};
  for (const match of block.matchAll(/--([a-z0-9-]+):\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*;/g)) {
    out[match[1]] = [Number(match[2]), Number(match[3]), Number(match[4])];
  }
  return out;
}

/** Colours the app renders TEXT in, and which therefore need 4.5:1. */
const TEXT_ROLES = ['fg', 'muted', 'brand-text', 'accent', 'success', 'warning', 'danger', 'info'];

/** Every ground text can land on. `--surface` and `--elevated` are both pure white
 *  in the light theme, so the page background is not always the worst case. */
const GROUNDS = ['bg', 'surface', 'elevated'];

// Reads app/globals.css, and that also covers the Expo app. design/tokens.json holds
// the same four light-mode values and had the same defect — its header calls itself
// "the ONE place the visual language is defined" and mobile/src/theme/tokens.ts imports
// it directly — so the fix had to land in both. tests/design-tokens.test.ts already
// fails on any drift between them, which is what makes checking one enough.
describe('semantic text colours meet WCAG AA', () => {
  const css = readFileSync(resolve('app/globals.css'), 'utf8');

  // `.dark {`, not `:root {`: the dark tokens live under `:root, .dark {` and the
  // FIRST `:root {` in this stylesheet is a different block holding the safe-area
  // insets and no colours at all. Selecting it found zero tokens — which surfaced
  // only because a missing --fg is an error here rather than an empty loop.
  for (const [theme, selector] of [['light', '.light {'], ['dark', '.dark {']] as const) {
    it(`${theme}: every text role clears 4.5:1 on every ground`, () => {
      const tokens = tokensOf(css, selector);
      const failures: string[] = [];
      for (const role of TEXT_ROLES) {
        const colour = tokens[role];
        expect(colour, `--${role} missing from ${selector}`).toBeDefined();
        for (const ground of GROUNDS) {
          const behind = tokens[ground];
          if (!behind) continue;
          const ratio = contrast(colour, behind);
          if (ratio < 4.5) failures.push(`--${role} on --${ground}: ${ratio.toFixed(2)}`);
        }
      }
      expect(failures,
        'darken the token in app/globals.css until it reaches 4.5:1 — hold the hue and '
        + 'saturation and reduce lightness only, so the fix is the smallest one that passes',
      ).toEqual([]);
    });
  }

  // Positive control. With every token fixed, "no failures" is otherwise equally
  // consistent with a parse that returned nothing and a loop that ran zero times.
  it('the parse actually finds the tokens', () => {
    const light = tokensOf(css, '.light {');
    expect(Object.keys(light).length).toBeGreaterThan(10);
    for (const role of [...TEXT_ROLES, ...GROUNDS]) {
      expect(light[role], `--${role}`).toHaveLength(3);
    }
  });

  // Negative control on the measurement itself: known ratios, so a broken
  // luminance formula fails here rather than silently passing everything.
  it('measures a known ratio correctly', () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 1);
    expect(contrast([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
    // The value this pass was written for: the shipped --warning on the shipped --bg.
    expect(contrast([197, 142, 24], [245, 247, 252])).toBeCloseTo(2.70, 1);
  });
});

// Text ON a solid danger fill. The Button `danger` variant, every unread-count
// badge and the tel:911 link put white on --danger; in the dark theme that is
// 2.80:1 (bubaly.com's /auth/signout/complete, found by axe on 2026-09-27).
// --danger-fg is the foreground for that fill, and the guard below keeps a new
// site from going back to text-white.
describe('text on a solid danger fill meets WCAG AA', () => {
  const css = readFileSync(resolve('app/globals.css'), 'utf8');
  for (const [theme, selector] of [['light', '.light {'], ['dark', '.dark {']] as const) {
    it(`${theme}: --danger-fg on --danger clears 4.5:1`, () => {
      const tokens = tokensOf(css, selector);
      expect(tokens['danger-fg'], `--danger-fg missing from ${selector}`).toBeDefined();
      expect(contrast(tokens['danger-fg'], tokens.danger)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('no solid danger fill carries text-white', () => {
    const offenders: string[] = [];
    for (const dir of ['app', 'components']) {
      for (const line of collectSource(dir).split('\n')) {
        if (/\bbg-danger\b(?!\/)/.test(line) && /\btext-white\b(?!\/)/.test(line)) offenders.push(line.trim().slice(0, 140));
      }
    }
    expect(offenders, 'use text-danger-fg on bg-danger').toEqual([]);
  });
});

// The same for a solid success fill: the survey's Activate, the missions queue's
// Approve and the reminders' done ticks put white on --success, 2.08:1 in the
// dark theme (axe, /admin/marketing/surveys/[id], 2026-09-27). --success-fg is
// the foreground for that fill.
describe('text on a solid success fill meets WCAG AA', () => {
  const css = readFileSync(resolve('app/globals.css'), 'utf8');
  for (const [theme, selector] of [['light', '.light {'], ['dark', '.dark {']] as const) {
    it(`${theme}: --success-fg on --success clears 4.5:1`, () => {
      const tokens = tokensOf(css, selector);
      expect(tokens['success-fg'], `--success-fg missing from ${selector}`).toBeDefined();
      expect(contrast(tokens['success-fg'], tokens.success)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('no solid success fill carries text-white', () => {
    const offenders: string[] = [];
    for (const dir of ['app', 'components']) {
      for (const line of collectSource(dir).split('\n')) {
        if (/\bbg-success\b(?!\/)/.test(line) && /\btext-white\b(?!\/)/.test(line)) offenders.push(line.trim().slice(0, 140));
      }
    }
    expect(offenders, 'use text-success-fg on bg-success').toEqual([]);
  });
});

// A status role's text on its own tint: `bg-success/15 text-success` is a chip.
// The token clearing 4.5:1 on --bg says nothing about the chip, whose ground is
// the token itself at that opacity (success read 4.20 on its 15% tint in axe,
// social accounts and sync). The strongest tint the source pairs with the
// role's text is the ground to beat; it is read from the source, so a new,
// stronger pairing is held to the same bar.
describe('a status role’s text is readable on its own tint', () => {
  const css = readFileSync(resolve('app/globals.css'), 'utf8');
  const source = [collectSource(resolve('app')), collectSource(resolve('components'))].join('\n');
  // accent too: an accent Badge is `bg-accent/15 text-accent` (3.71:1 before).
  const STATUS = ['success', 'warning', 'danger', 'info', 'accent'];

  /** The strongest `bg-<role>/NN`, in any state (`hover:bg-<role>/25` too), in a class string that also has `text-<role>`. */
  function strongestTint(role: string): number {
    let max = 0;
    for (const m of source.matchAll(/(["'`])([^"'`\n]*)\1/g)) {
      const classes = m[2];
      if (!new RegExp(`(^|\\s)text-${role}(\\s|$)`).test(classes)) continue;
      for (const t of classes.matchAll(new RegExp(`(?:^|\\s)(?:[a-z-]+:)*bg-${role}/(\\d+)(?=\\s|$)`, 'g'))) max = Math.max(max, Number(t[1]));
    }
    return max;
  }

  it('finds the chips (non-vacuity)', () => {
    for (const role of ['success', 'warning', 'danger', 'accent']) expect(strongestTint(role), role).toBeGreaterThan(0);
    // hover:bg-success/25 behind text-success: economy, wallet, concierge, approvals.
    expect(strongestTint('success')).toBe(25);
  });

  for (const [theme, selector] of [['light', '.light {'], ['dark', '.dark {']] as const) {
    it(`${theme}: each status role clears 4.5:1 on its strongest tint, over every ground`, () => {
      const tokens = tokensOf(css, selector);
      const failures: string[] = [];
      for (const role of STATUS) {
        const alpha = strongestTint(role) / 100;
        if (!alpha) continue;
        for (const ground of GROUNDS) {
          const behind = tokens[ground];
          if (!behind) continue;
          const tint = tokens[role].map((v, i) => v * alpha + behind[i] * (1 - alpha));
          const ratio = contrast(tokens[role], tint);
          if (ratio < 4.5) failures.push(`--${role} on its ${Math.round(alpha * 100)}% tint over --${ground}: ${ratio.toFixed(2)}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

// The scan above reads one class string at a time, so it cannot see a chip
// whose ground is ANOTHER element's tint. The reminders list has one: a
// snoozed reminder's row is bg-warning/5 and an overdue one's bg-danger/5, and
// the row carries Badges (bg-<role>/15 text-<role>) for its priority and its
// state. The two tints compound (warning on a danger/5 row read 4.23 over
// --bg). This reads the row's tints and the Badge's from the source and
// composes them as the browser does; tests/e2e/a-status-chip-on-a-tinted-row
// measures the same thing from computed styles.
//
// Still unscanned, so a clean run here does not mean every chip is readable:
// nesting across files (a tinted card in one component, a chip in another),
// text colour inherited from an ancestor, and class strings split over lines.
describe('a status chip on a status-tinted reminder row is readable', () => {
  const css = readFileSync(resolve('app/globals.css'), 'utf8');
  const reminders = readFileSync(resolve('components/modules/reminders-module.tsx'), 'utf8');
  const badge = readFileSync(resolve('components/ui/badge.tsx'), 'utf8');
  const row = bodyOf(reminders, "'group relative flex items-start gap-4 rounded-2xl border p-4 transition'", ')}>');
  const tones = between(badge, 'const TONES', 'export function Badge');

  /** The row's tint for a state, as the row's cn() writes it. */
  const rowTint = (role: string) => {
    const m = row.match(new RegExp(`\\bbg-${role}/(\\d+)\\b`));
    expect(m, `the reminder row's bg-${role}/NN`).not.toBeNull();
    return Number(m![1]) / 100;
  };
  /** The Badge tone's tint, which sits behind its own text. */
  const badgeTint = (role: string) => {
    const m = tones.match(new RegExp(`${role}: 'bg-${role}/(\\d+) text-${role}\\b`));
    expect(m, `Badge's ${role} tone`).not.toBeNull();
    return Number(m![1]) / 100;
  };
  /** The status tones a row's Badges can take: its state's, and its priority's. */
  function chipRoles(): string[] {
    const roles = new Set<string>();
    for (const m of bodyOf(reminders, 'const PRIORITIES = [', '] as const;').matchAll(/badge: '(\w+)'/g)) roles.add(m[1]);
    expect(reminders).toContain('<Badge tone={priority.badge');
    const states = [...reminders.matchAll(/\{(?:snoozed|overdue && !completed) && <Badge tone="(\w+)">/g)];
    expect(states.map((m) => m[1]), 'the snoozed and overdue Badges').toEqual(['warning', 'danger']);
    for (const m of states) roles.add(m[1]);
    return [...roles].filter((r) => ['success', 'warning', 'danger', 'info'].includes(r));
  }

  it('finds both tinted row states and the chips on them (non-vacuity)', () => {
    expect(rowTint('warning')).toBeGreaterThan(0);
    expect(rowTint('danger')).toBeGreaterThan(0);
    expect(chipRoles().sort()).toEqual(['danger', 'warning']);
  });

  for (const [theme, selector] of [['light', '.light {'], ['dark', '.dark {']] as const) {
    it(`${theme}: every chip clears 4.5:1 on every tinted row, over every ground`, () => {
      const tokens = tokensOf(css, selector);
      const over = (top: number[], alpha: number, under: number[]) => top.map((v, i) => v * alpha + under[i] * (1 - alpha));
      const failures: string[] = [];
      for (const rowRole of ['warning', 'danger']) {
        for (const chip of chipRoles()) {
          for (const ground of GROUNDS) {
            const behind = over(tokens[chip], badgeTint(chip), over(tokens[rowRole], rowTint(rowRole), tokens[ground]));
            const ratio = contrast(tokens[chip], behind);
            if (ratio < 4.5) failures.push(`${chip} chip on a ${rowRole} row over --${ground}: ${ratio.toFixed(2)}`);
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

// Muted text on the brand selection tint. A selected row or an icon tile puts
// `text-muted` on `bg-brand/10` (the active conversation in messages; the
// empty-state tiles), where it read 4.32:1 over --bg. The tint is read from
// the source: the strongest base-state bg-brand/NN in a class string that also
// has text-muted (a state that changes the text colour with it, like a
// peer-checked chip turning text-brand-text, is not a muted pairing), and the
// messages row, whose tint and muted preview are on different elements.
describe('muted text is readable on the brand selection tint', () => {
  const css = readFileSync(resolve('app/globals.css'), 'utf8');
  const source = [collectSource(resolve('app')), collectSource(resolve('components'))].join('\n');
  const messages = readFileSync(resolve('components/modules/messages-module.tsx'), 'utf8');

  function selectionTint(): number {
    let max = 0;
    for (const m of source.matchAll(/(["'`])([^"'`\n]*)\1/g)) {
      const classes = m[2];
      if (!/(^|\s)text-muted(\s|$)/.test(classes)) continue;
      for (const t of classes.matchAll(/(?:^|\s)bg-brand\/(\d+)(?=\s|$)/g)) max = Math.max(max, Number(t[1]));
    }
    const row = messages.match(/isActive \? 'bg-brand\/(\d+)'/);
    expect(row, "messages' active row tint").not.toBeNull();
    expect(messages).toContain("unread ? 'font-medium text-fg' : 'text-muted'");
    return Math.max(max, Number(row![1]));
  }

  it('finds the selection tint (non-vacuity)', () => {
    expect(selectionTint()).toBe(10);
  });

  for (const [theme, selector] of [['light', '.light {'], ['dark', '.dark {']] as const) {
    it(`${theme}: --muted clears 4.5:1 on --brand at that tint, over every ground`, () => {
      const tokens = tokensOf(css, selector);
      const alpha = selectionTint() / 100;
      const failures: string[] = [];
      for (const ground of GROUNDS) {
        const tint = tokens.brand.map((v, i) => v * alpha + tokens[ground][i] * (1 - alpha));
        const ratio = contrast(tokens.muted, tint);
        if (ratio < 4.5) failures.push(`--muted on --brand/${selectionTint()} over --${ground}: ${ratio.toFixed(2)}`);
      }
      expect(failures).toEqual([]);
    });
  }
});
