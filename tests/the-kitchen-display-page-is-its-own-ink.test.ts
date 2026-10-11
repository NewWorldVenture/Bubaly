import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A11Y-001: the kitchen display (/display) is a dark presentation in either
// theme. Its wash is a fixed -z-10 layer, not an ancestor of the text, so a
// checker that reads the page behind it (axe) measured the light theme's page
// colour instead: "Today's Schedule" white on #f6f7fc, 1.05:1, at 390 px. The
// page under the display is the display's own ink now, which is also what a
// light theme showed on overscroll.

describe('the kitchen display’s page is its own ink', () => {
  it('globals.css paints the body #0b1020 while the display is mounted', () => {
    const css = readFileSync('app/globals.css', 'utf8');
    expect(css).toMatch(/body:has\(\.kitchen-display\) \{\s*background-color: #0b1020;\s*\}/);
  });

  it('the display’s root carries the marker, beside its dark palette', () => {
    const grid = readFileSync('components/display/display-grid.tsx', 'utf8');
    expect(grid).toContain("'kitchen-display keep-dark-palette flex min-h-dvh flex-col");
    // The same ink the wash starts from, so the page and the display agree.
    expect(grid).toContain('fixed inset-0 -z-10 bg-[#0b1020]');
  });
});
