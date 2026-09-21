import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `aria-modal="true"` tells assistive technology that everything outside this
// element is inert. Declaring it without making it true is worse than a plain
// `<div>`: a screen-reader user is told to ignore a background their keyboard
// can still reach, and has no way to discover otherwise.
//
// `lib/a11y/use-dialog-behavior.ts` exists because eleven overlays declared the
// attribute and implemented none of it. Its docstring records that; nothing
// enforced it. This does, as an EQUIVALENCE in both directions:
//
//   declares aria-modal  ->  must use the hook   (or the promise is empty)
//   uses the hook        ->  must declare it     (or AT is never told)
//
// A scan, not a list. `tests/mobile-overlay-dialog-a11y.test.ts` names four
// overlays by hand, which is why the photo lightbox — a full-screen viewer with
// no dialog role, no Escape, no focus trap — sat outside it (F-D01).

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx') && !full.includes('.test.')) out.push(full);
  }
  return out;
}

/** Comment bodies blanked — including JSX `{/* … *\/}` — so prose is not code. */
function blankComments(source: string): string {
  return source.replace(/\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

const DECLARES = /aria-modal=\{?["']?true/;
const IMPLEMENTS = /useDialogBehavior\s*\(/;

describe('aria-modal="true" means what it says', () => {
  const files = [...walk('components'), ...walk('app')];
  const sources = new Map(files.map((f) => [f, blankComments(readFileSync(f, 'utf8'))]));
  const declares = files.filter((f) => DECLARES.test(sources.get(f)!));
  const implementsIt = files.filter((f) => IMPLEMENTS.test(sources.get(f)!));

  it('finds the overlays (non-vacuity)', () => {
    // A scan that stopped matching would satisfy both cases below forever.
    expect(declares.length).toBeGreaterThan(8);
    expect(implementsIt.length).toBeGreaterThan(8);
  });

  it('nothing declares it without implementing it', () => {
    const empty = declares.filter((f) => !IMPLEMENTS.test(sources.get(f)!));
    expect(
      empty,
      'These promise a screen-reader user that the background is inert, and do not trap focus,\n'
      + 'close on Escape, lock scrolling or restore focus. Use useDialogBehavior:\n' + empty.join('\n'),
    ).toEqual([]);
  });

  it('nothing implements it without declaring it', () => {
    // The other direction matters too: a trapped, Escape-closable overlay that
    // never says `aria-modal` leaves a screen reader announcing the background
    // it can no longer reach.
    const silent = implementsIt.filter((f) => !DECLARES.test(sources.get(f)!));
    expect(
      silent,
      'These behave like a modal dialog and never say so:\n' + silent.join('\n'),
    ).toEqual([]);
  });

  it('reads code, not the comments about it (sanity)', () => {
    const prose = blankComments('// aria-modal="true" is missing here\nconst x = 1;');
    expect(DECLARES.test(prose)).toBe(false);
    expect(IMPLEMENTS.test(blankComments('{/* useDialogBehavior() should be used */}\nconst y = 2;'))).toBe(false);
    expect(DECLARES.test('<div aria-modal="true">')).toBe(true);
    expect(IMPLEMENTS.test('useDialogBehavior(ref, open, { onClose });')).toBe(true);
  });
});

describe('the photo lightbox does not strand a keyboard (F-D01)', () => {
  const src = blankComments(readFileSync('components/modules/photos-module.tsx', 'utf8'));

  it('is a labelled modal dialog with the shared behaviour', () => {
    expect(src).toMatch(/role="dialog"/);
    expect(src).toMatch(/aria-modal="true"/);
    expect(src).toMatch(/useDialogBehavior\(lightboxRef, lightboxIdx !== null/);
    // The REAL condition, not `true` — the panel only exists while open, so an
    // effect keyed on a literal would run once on mount and never again.
    expect(src).not.toMatch(/useDialogBehavior\(lightboxRef, true/);
  });

  it('can be opened from the keyboard at all', () => {
    // The first half of the finding: the grid and list tiles were `<div
    // onClick>`, so a keyboard could not reach the viewer to be trapped in it.
    const tiles = [...src.matchAll(/setLightboxIdx\(idx\)/g)];
    expect(tiles.length).toBeGreaterThanOrEqual(2);
    expect([...src.matchAll(/role="button" tabIndex=\{0\}/g)].length).toBeGreaterThanOrEqual(2);
    expect([...src.matchAll(/e\.key === 'Enter' \|\| e\.key === ' '/g)].length).toBeGreaterThanOrEqual(2);
  });

  it('offers a keyboard way between photos', () => {
    // Trapping focus and then offering no keyboard path to the next photo
    // swaps one dead end for another.
    expect(src).toMatch(/e\.key === 'ArrowLeft'/);
    expect(src).toMatch(/e\.key === 'ArrowRight'/);
  });
});
