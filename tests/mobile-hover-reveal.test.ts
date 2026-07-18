import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Mobile production-readiness (Phase 6 — M-005): row-action controls hidden behind
// `opacity-0 group-hover:opacity-100` (or `hidden group-hover:*`) NEVER appear on a
// touch device (no hover), so edit/delete/archive/favorite actions are unreachable
// on phones/tablets. The fix shows them on touch and keeps hover-reveal only at sm+
// (mouse), plus a focus-visible escape hatch:
//   opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100
// This guard forbids a regression to a bare, touch-invisible hover-reveal.

const DIRS = ['components/modules', 'app'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('no touch-invisible hover-reveal controls (M-005)', () => {
  const files = DIRS.flatMap(walk);

  it('scans a meaningful set of component files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no bare `opacity-0 group-hover:opacity-100` (must be sm:-gated so touch shows it)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      // A bare occurrence not preceded by the touch-visible `opacity-100 sm:` form.
      const re = /opacity-0 group-hover:opacity-100/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const before = src.slice(Math.max(0, m.index - 20), m.index);
        if (!/sm:$/.test(before)) offenders.push(`${f}@${m.index}`);
      }
    }
    expect(offenders, `touch-invisible hover-reveal controls: ${offenders.join(', ')}`).toEqual([]);
  });

  it('has no `hidden group-hover:` control without an sm: touch escape', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      if (/(?<!sm:)hidden group-hover:(flex|block|inline)/.test(src)) offenders.push(f);
    }
    expect(offenders, `hidden-until-hover controls: ${offenders.join(', ')}`).toEqual([]);
  });
});
