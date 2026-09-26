import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { completion, countLedger, headerBlock, statusBlock, LEDGER } from '../scripts/finalaudit-counts.mjs';

// The Audit Status block is a claim about the ledger, so it has to be the
// ledger's own count. By hand it drifted (191 In Progress and 60 Fixed + Passed
// in the header, 185 and 65 in the rows, and an "Overall Completion" of 0.04%
// that no formula produced). `node scripts/finalaudit-counts.mjs --write`
// rewrites it; this test fails whenever a row changes and the header does not.

describe('the finalaudit.md header is the count of its own rows', () => {
  const text = readFileSync(LEDGER, 'utf8');
  const { counts, unclassified } = countLedger(text);

  it('every ledger row uses a status from the Status Legend', () => {
    expect(unclassified).toEqual([]);
  });

  it('counts a real ledger (guards the guard)', () => {
    expect(counts.total).toBeGreaterThan(14_000);
    expect(counts.fixedPassed).toBeGreaterThan(50);
  });

  it('the header matches the rows; run `node scripts/finalaudit-counts.mjs --write` to fix', () => {
    expect(headerBlock(text)).toBe(statusBlock(counts));
  });

  it('the release gate cannot say YES while anything is open', () => {
    const open = counts.notStarted + counts.inProgress + counts.failed;
    if (open > 0) expect(text).toMatch(/## Release Gate\nPRODUCTION READY: NO/);
  });
});

describe('the counter itself', () => {
  const ledger = (...rows: string[]) =>
    ['# Final Production Audit', '| ID | Area | Title | Status |', '|---|---|---|---|', ...rows, '# Appendix', '| F-F04 | x | y | **FIXED** |'].join('\n');

  it('classifies each legend status, FIXED + PASS before PASS', () => {
    const { counts, unclassified } = countLedger(ledger(
      '| A-1 | a | t | ⬜ NOT STARTED |',
      '| A-2 | a | t | 🔄 IN PROGRESS |',
      '| A-3 | a | t | ✅ PASS |',
      '| A-4 | a | t | 🛠 FIXED + PASS (pending production) |',
      '| A-5 | a | t | ⚠️ BLOCKED |',
      '| A-6 | a | t | ❌ FAIL |',
      '| A-4 | a | a second finding under a reused ID | 🛠 FIXED + PASS |',
    ));
    expect(unclassified).toEqual([]);
    expect(counts).toEqual({ total: 7, notStarted: 1, inProgress: 1, passed: 1, fixedPassed: 2, blocked: 1, failed: 1 });
  });

  it('refuses a status the legend does not have instead of guessing', () => {
    expect(countLedger(ledger('| B-1 | a | t | ⚠️ ACCEPTED |')).unclassified).toEqual(['B-1: ⚠️ ACCEPTED']);
  });

  it('ignores the appendix after the next top-level heading', () => {
    expect(countLedger(ledger('| C-1 | a | t | ✅ PASS |')).counts.total).toBe(1);
  });

  it('completion is the verified-passing share', () => {
    expect(completion({ total: 200, passed: 1, fixedPassed: 1 })).toBe('1.00%');
  });
});
