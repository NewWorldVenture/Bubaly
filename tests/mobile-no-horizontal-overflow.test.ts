import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Mobile production-readiness (Phase 4 — no unintended horizontal page scroll):
// wide data tables are the classic cause. The dashboard modules already wrap every
// <table> in an `overflow-x-auto` container, so a wide table scrolls INSIDE its
// bounded box instead of pushing the whole page sideways. This guard ratchets that
// invariant so a future change can't drop a raw, page-widening table in.

const MODULES_DIR = 'components/modules';

function tablesAreWrapped(src: string): number[] {
  const lines = src.split('\n');
  const offenders: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/<table\b/.test(lines[i])) continue;
    // An overflow-x-auto (or -scroll) container must appear on the table line or
    // within the few lines just above it (the wrapping <div>).
    const window = lines.slice(Math.max(0, i - 4), i + 1).join(' ');
    if (!/overflow-x-(auto|scroll)/.test(window)) offenders.push(i + 1);
  }
  return offenders;
}

describe('dashboard tables scroll inside a bounded container (no horizontal page overflow)', () => {
  const files = fs
    .readdirSync(MODULES_DIR)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => path.join(MODULES_DIR, f))
    .filter((p) => fs.readFileSync(p, 'utf8').includes('<table'));

  it('covers the modules that render tables', () => {
    // Sanity: we are actually scanning real table-bearing modules.
    expect(files.length).toBeGreaterThan(3);
  });

  it('every module <table> sits inside an overflow-x-auto wrapper', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const line of tablesAreWrapped(fs.readFileSync(file, 'utf8'))) {
        offenders.push(`${file}:${line}`);
      }
    }
    expect(offenders, `unwrapped <table> (would overflow the page on mobile): ${offenders.join(', ')}`).toEqual([]);
  });
});
