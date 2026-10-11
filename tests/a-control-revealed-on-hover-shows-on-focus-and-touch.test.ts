import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hoverReveals, revealProblem, sourceFiles } from './helpers/hover-reveals';

// A11Y-001: row actions (delete, edit, pin, the "…" menu) hidden until the
// row is hovered were invisible to the two kinds of user who cannot hover.
//   - Keyboard: Tab landed on a control at opacity 0 (WCAG 2.4.7), for
//     instance the grocery list's "Delete item" in a populated household.
//   - Touch: there is no hover, so the action never appeared.
// tests/mobile-hover-reveal.test.ts guarded the touch half, but only where the
// classes sat side by side (`opacity-0 group-hover:opacity-100`); any class in
// between (`opacity-0 transition group-hover:opacity-100`) slipped past it, and
// 26 controls had. A wrapper also needs `focus-within`, not `focus-visible`:
// a <div> holding the buttons is never focus-visible itself.
//
// This reads every JSX element's className, `cn(...)` arguments included,
// with the TypeScript parser, so the order and spacing of classes no longer
// matter. A decorative lucide icon inside a visible link may stay hover-only.

describe('a control revealed on hover also shows on focus and on touch', () => {
  const reveals = hoverReveals([...sourceFiles('app'), ...sourceFiles('components')]);

  it('finds the hover-revealed controls (non-vacuity)', () => {
    expect(reveals.length).toBeGreaterThan(30);
    expect(reveals.some((r) => r.at.startsWith(join('components', 'modules', 'shopping-module.tsx')) && r.focusable)).toBe(true);
    expect(reveals.some((r) => !r.focusable)).toBe(true);
  });

  it('every one shows on keyboard focus, on touch and at phone width', () => {
    const problems = reveals.map((r) => [r.at, r.tag, revealProblem(r)]).filter(([, , p]) => p);
    expect(problems).toEqual([]);
  });

  it('a control this makes visible on a phone is a 24px target there, not 20px', () => {
    // Shown on touch now, so WCAG 2.5.8 applies: axe at 390 px found the
    // notes grid card's pin and delete, and the grocery list's "Edit list",
    // at 20 by 20 (p-1 around a 12px icon). p-1.5 makes them 24.
    const notes = readFileSync('components/modules/notes-module.tsx', 'utf8');
    expect(notes).toMatch(/className="rounded p-1\.5 text-muted hover:text-brand-text">\s*\{note\.is_pinned \? <PinOff className="h-3 w-3" \/>/);
    expect(notes).toMatch(/className="rounded p-1\.5 text-muted hover:text-danger">\s*<Trash2 className="h-3 w-3" \/>/);
    expect(notes).not.toMatch(/className="rounded p-1 text-muted hover:text-(brand-text|danger)">\s*(\{note\.is_pinned \? <PinOff className="h-3 w-3"|<Trash2 className="h-3 w-3")/);
    expect(readFileSync('components/modules/shopping-module.tsx', 'utf8')).toMatch(/coarse:opacity-100 rounded p-1\.5 hover:bg-black\/10">\s*<Pencil className="h-3 w-3" \/>/);
  });

  it('the check catches each way of getting it wrong', () => {
    const base = { at: 'x', tag: 'button', focusable: true };
    const good = ['opacity-100', 'sm:opacity-0', 'sm:group-hover:opacity-100', 'focus-visible:opacity-100', 'coarse:opacity-100'];
    expect(revealProblem({ ...base, classes: good })).toBeNull();
    expect(revealProblem({ ...base, classes: ['opacity-0', 'transition', 'group-hover:opacity-100'] })).toMatch(/touch/);
    expect(revealProblem({ ...base, classes: good.filter((c) => c !== 'focus-visible:opacity-100') })).toMatch(/focused/);
    expect(revealProblem({ ...base, classes: good.filter((c) => c !== 'coarse:opacity-100') })).toMatch(/touch screen/);
    expect(revealProblem({ ...base, tag: 'div', focusable: false, classes: good })).toMatch(/inside it is focused/);
    expect(revealProblem({ ...base, tag: 'div', focusable: false, classes: [...good, 'focus-within:opacity-100'] })).toBeNull();
    // The todos row's actions: right opacity classes, but display:none on a phone.
    expect(revealProblem({ ...base, tag: 'div', focusable: false, classes: ['hidden', 'sm:flex', ...good, 'focus-within:opacity-100'] })).toMatch(/not displayed below 640px/);
  });
});
