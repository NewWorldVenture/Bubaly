import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Mobile production-readiness (M-005 tablet follow-up): the M-005 fix reveals
// hover-only row controls on touch by using
//   opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100
// That is correct for PHONES (below `sm` the base `opacity-100` shows the control),
// but it re-hides on TABLETS: an iPad in portrait/landscape is >= `sm` width yet has
// no hover, so `sm:opacity-0` hides the control and `sm:group-hover:*` never fires —
// the single largest touch form-factor loses edit/delete/favorite/drag.
//
// The width-independent fix is a coarse-pointer escape hatch: `coarse:opacity-100`
// (`app/globals.css` @media (pointer: coarse) → `opacity: 1 !important`). It forces
// the control visible on ANY touch device regardless of width, while desktop
// (fine pointer) keeps the clean hover-reveal untouched.
//
// This guard forbids a regression to the tablet-hiding form without that escape.

const DIRS = ['components/modules', 'app', 'components'];
const REPO = path.resolve(__dirname, '..');

function walk(dir: string): string[] {
  const abs = path.join(REPO, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (entry.name.endsWith('.tsx')) out.push(rel);
  }
  return out;
}

describe('touch controls stay reachable on tablets (M-005 coarse escape)', () => {
  const files = Array.from(new Set(DIRS.flatMap(walk)));

  it('globals.css defines the coarse:opacity-100 escape utility inside a coarse-pointer media query', () => {
    const css = fs.readFileSync(path.join(REPO, 'app/globals.css'), 'utf8');
    const block = css.slice(css.indexOf('@media (pointer: coarse)'));
    expect(block, 'coarse-pointer media block must exist').not.toBe('');
    expect(/\.coarse\\:opacity-100\s*\{\s*opacity:\s*1\s*!important/.test(block)).toBe(true);
  });

  it('every sm:opacity-0 sm:group-hover hover-reveal carries a coarse:opacity-100 tablet escape', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(REPO, f), 'utf8');
      const re = /sm:opacity-0 sm:group-hover:opacity-100/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        // Inspect the surrounding class string (same className attribute) for the escape.
        const window = src.slice(m.index, m.index + 120);
        if (!/coarse:opacity-100/.test(window)) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${f}:${line}`);
        }
      }
    }
    expect(
      offenders,
      `sm-gated hover-reveal hidden on tablets (add coarse:opacity-100): ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
