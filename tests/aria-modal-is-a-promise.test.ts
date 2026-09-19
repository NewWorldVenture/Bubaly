import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `aria-modal="true"` tells assistive technology that everything outside this
// element is inert. Declaring it without making it true is WORSE than a plain
// `<div>`: a screen-reader user is told to ignore a background their keyboard
// can still reach, and nothing tells them otherwise.
//
// `components/ui/modal.tsx` implements the whole WAI-ARIA dialog contract and
// `tests/modal-a11y-contract.test.ts` pins it in detail. Eleven other components
// declared `aria-modal` and implemented NONE of it — not one trapped Tab.
//
// The guard covering the shared Modal could not see them, and the reason is
// structural rather than careless. Modal coupled the BEHAVIOUR (trap, Escape,
// scroll lock, focus restore) to its own CHROME (backdrop, title bar, close
// button, bottom-sheet layout). A camera viewfinder, a command palette, a
// slide-over nav drawer and three full-screen gates could not take the chrome,
// so they took neither — and a guard on the blessed helper says nothing about
// the path taken to avoid it.
//
// The behaviour now lives in `lib/a11y/use-dialog-behavior.ts`, so an overlay
// can keep its own layout and still keep the promise. This is the rule that
// keeps the twelfth from being written:
//
//     if you declare aria-modal, you use the hook (or you ARE the shared Modal).
const ROOTS = ['app', 'components'];
const CODE = new Set(['.tsx']);
/** The one file allowed to declare `aria-modal` and call the hook itself. */
const THE_SHARED_MODAL = join('components', 'ui', 'modal.tsx');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (CODE.has(extname(p))) out.push(p);
  }
  return out;
}

/** Comments explaining this rule are not themselves declarations of it. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

export function declaresAriaModal(source: string): boolean {
  return /aria-modal/.test(stripComments(source));
}

describe('aria-modal is a promise, and something has to keep it', () => {
  const files = ROOTS.flatMap((r) => sourceFiles(r));

  it('scans a meaningful number of components', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('every component declaring aria-modal uses the shared dialog behaviour', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === THE_SHARED_MODAL) continue;
      const source = readFileSync(file, 'utf8');
      if (!declaresAriaModal(source)) continue;
      if (/useDialogBehavior/.test(source)) continue;
      offenders.push(`${file} — declares aria-modal without useDialogBehavior; the attribute promises the page behind is inert`);
    }
    expect(offenders).toEqual([]);
  });

  it('finds the components it is supposed to be checking', () => {
    // Non-vacuity: a scan that matched nothing would pass the case above
    // forever. Eleven were found when this was written.
    const declaring = files.filter((f) => f !== THE_SHARED_MODAL)
      .filter((f) => declaresAriaModal(readFileSync(f, 'utf8')));
    expect(declaring.length).toBeGreaterThan(8);
  });

  it('does not count a comment about aria-modal as a declaration of it', () => {
    // This is not hypothetical. The first version of this scan reported
    // consent-manager.tsx, whose hand-rolled dialog had ALREADY been replaced
    // with the shared Modal — it matched the paragraph explaining the fix.
    // Two earlier scans in this audit made the same mistake.
    expect(declaresAriaModal('// the markup declared aria-modal="true" and did none of it')).toBe(false);
    expect(declaresAriaModal('/* aria-modal is a promise */')).toBe(false);
    expect(declaresAriaModal('<div role="dialog" aria-modal="true">')).toBe(true);
  });
});
