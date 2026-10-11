import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from './helpers/hover-reveals';

// A11Y-001, WCAG 1.4.10 (reflow). At 320 CSS px wide, 21 of the 246 member
// routes of a seeded household scrolled sideways (a scratch sweep measured
// document.scrollWidth against the viewport and named the elements past it).
//
// Most were one shape: a grid with columns only from a breakpoint up
// (`grid gap-4 lg:grid-cols-2`). Below the breakpoint its single implicit
// column is sized `auto`, which grows to its widest child's min-content (a
// truncated title, a row that does not wrap), so the whole card ran past the
// screen. `grid-cols-1` is `minmax(0, 1fr)`: the column is the grid's width,
// and the children wrap or truncate inside it.
// The rest were rows: a flex row that never wraps, or a flex-1 input whose
// min-width is its intrinsic size.

/** Each class string in a file that makes a grid with breakpoint columns and no base column count. */
function unboundedGrids(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(["'`])((?:(?!\1)[^\n])*)\1/g)) {
    const classes = m[2].split(/\s+/);
    if (!classes.includes('grid')) continue;
    if (!classes.some((c) => /^(sm|md|lg|xl|2xl):grid-cols-/.test(c))) continue;
    if (classes.some((c) => /^grid-cols-/.test(c))) continue;
    out.push(m[2]);
  }
  return out;
}

const files = [...sourceFiles('components'), ...sourceFiles('app')];

describe('a page reflows at 320 px', () => {
  it('the grids the sweep found have a base column that cannot outgrow them', () => {
    const fixed: [string, string][] = [
      ['app/(app)/dashboard/assistants/page.tsx', 'grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]'],
      ['components/modules/contact-center-module.tsx', 'grid grid-cols-1 gap-4 lg:grid-cols-2'],
      ['components/modules/family-module.tsx', 'grid grid-cols-1 gap-5 lg:grid-cols-2'],
      ['app/(app)/dashboard/family-coo/page.tsx', 'grid grid-cols-1 gap-5 md:grid-cols-2'],
      ['app/(app)/dashboard/family-health/page.tsx', 'grid grid-cols-1 gap-5 md:grid-cols-2'],
      ['components/modules/goals-module.tsx', 'grid grid-cols-1 gap-4 sm:grid-cols-2'],
      ['components/moments/moments-view.tsx', 'grid grid-cols-1 gap-4 lg:grid-cols-2'],
      ['components/modules/school-module.tsx', 'grid grid-cols-1 gap-5 lg:grid-cols-2'],
      ['components/modules/settings-module.tsx', 'grid grid-cols-1 gap-4 sm:grid-cols-2'],
    ];
    for (const [file, cls] of fixed) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).toContain(`"${cls}`);
      expect(unboundedGrids(src).filter((g) => g.startsWith(cls.replace('grid-cols-1 ', ''))), file).toEqual([]);
    }
  });

  it('the count of grids with no base column only goes down', () => {
    // 330 on main c95b118; the nine files above held 11 of them. Most fit
    // their content at 320 px, as the sweep showed; this keeps new ones from
    // being added without a base column.
    const count = files.reduce((n, f) => n + unboundedGrids(readFileSync(f, 'utf8')).length, 0);
    expect(count).toBeLessThanOrEqual(319);
    expect(count).toBeGreaterThan(100); // non-vacuity: the scanner finds them
  });

  it('the rows the sweep found wrap, and their inputs can shrink', () => {
    const src = (f: string) => readFileSync(f, 'utf8');
    expect(src('components/dashboard/ai-home-dashboard.tsx')).toContain('<div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">');
    expect(src('components/modules/health-visits-module.tsx')).toContain('<div className="flex flex-wrap items-center justify-between gap-3">');
    expect(src('components/modules/focus-module.tsx')).toContain('<div className="flex flex-wrap items-center justify-center gap-1.5">');
    expect(src('components/modules/shopping-module.tsx').match(/<div className="ml-auto flex flex-wrap items-center gap-2">/g)).toHaveLength(2);
    expect(src('components/modules/shopping-module.tsx')).toContain('className="min-w-0 flex-1 rounded-xl border border-dashed');
    expect(src('app/(app)/dashboard/social/feed/page.tsx')).toContain('className="min-w-0 flex-1 rounded-lg border');
    expect(src('app/(app)/dashboard/social/analytics/page.tsx')).toContain('className="flex flex-wrap items-center gap-3 text-sm"');
    expect(src('app/(app)/dashboard/social/settings/page.tsx')).toContain('className="flex flex-wrap items-center gap-2 rounded-lg border');
    expect(src('components/guardian/call-history.tsx')).toContain('<div className="flex flex-wrap gap-1.5">');
    expect(src('components/referrals/referral-panel.tsx')).toContain('className="h-11 min-w-0 flex-1 rounded-xl');
    expect(src('components/modules/immunizations-module.tsx')).toContain('<div className="flex flex-wrap items-center justify-between gap-3">');
    // A full URL is one word: it breaks anywhere rather than push the card past the screen.
    expect(src('app/(app)/dashboard/assistants/page.tsx').match(/<code className="break-all text-xs">https:\/\//g)).toHaveLength(2);
  });

  it('the scanner: breakpoint columns without a base count; a base count or no breakpoint is fine', () => {
    expect(unboundedGrids(`<div className="grid gap-4 lg:grid-cols-2">`)).toHaveLength(1);
    expect(unboundedGrids(`<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">`)).toHaveLength(0);
    expect(unboundedGrids(`<div className="grid gap-4">`)).toHaveLength(0);
    expect(unboundedGrids(`cn('grid gap-3 sm:grid-cols-3', x)`)).toHaveLength(1);
  });
});
