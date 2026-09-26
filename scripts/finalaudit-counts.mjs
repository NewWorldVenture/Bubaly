#!/usr/bin/env node
/**
 * The Audit Status block at the top of finalaudit.md, computed from the ledger
 * rows instead of kept by hand.
 *
 * The hand-kept numbers drifted: on 2026-09-26 the header said 191 In Progress
 * and 60 Fixed + Passed while the rows said 185 (+1 in a status the legend does
 * not have) and 65, and "Overall Completion: 0.04%" matched no formula at all.
 * A count nobody can recompute is not evidence, so this is the formula:
 *
 *  - an item is a ledger row: a table line whose first cell is an ID such as
 *    `SEC-001` or `MAIN-F-C07`, above the upstream appendix. Every row counts,
 *    including the three IDs that two different findings share (DATA-008,
 *    DATA-009, A11Y-001), because they are two findings each;
 *  - its status is the fourth cell, matched against the Status Legend;
 *  - Overall Completion is (✅ PASS + 🛠 FIXED + PASS) / total, the share that
 *    is verified passing. BLOCKED items are not complete.
 *
 *   node scripts/finalaudit-counts.mjs          # print the block
 *   node scripts/finalaudit-counts.mjs --write  # rewrite it in place
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const LEDGER = 'finalaudit.md';

/** Order matters: FIXED + PASS before PASS, NOT STARTED before anything. */
const STATUSES = [
  ['notStarted', /NOT STARTED/],
  ['inProgress', /IN PROGRESS/],
  ['fixedPassed', /FIXED \+ PASS/],
  ['blocked', /BLOCKED/],
  ['failed', /\bFAIL\b/],
  ['passed', /\bPASS\b/],
];

const ROW = /^\| ([A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+) \| [^|]*\| [^|]*\| ([^|]*)\|/;

/**
 * The ledger is everything before the second top-level heading. After it come
 * the historical-regression record and the upstream appendix, which repeat
 * pass-local IDs (F-F04 …) as narrative, not as items.
 */
function ledgerLines(text) {
  const lines = text.split('\n');
  const end = lines.findIndex((l, i) => i > 0 && /^# /.test(l));
  return end === -1 ? lines : lines.slice(0, end);
}

export function countLedger(text) {
  const counts = { total: 0, notStarted: 0, inProgress: 0, passed: 0, fixedPassed: 0, blocked: 0, failed: 0 };
  const unclassified = [];
  for (const line of ledgerLines(text)) {
    const m = ROW.exec(line);
    if (!m) continue;
    const status = m[2].trim().toUpperCase();
    const hit = STATUSES.find(([, re]) => re.test(status));
    if (!hit) {
      unclassified.push(`${m[1]}: ${m[2].trim()}`);
      continue;
    }
    counts.total += 1;
    counts[hit[0]] += 1;
  }
  return { counts, unclassified };
}

export function completion({ total, passed, fixedPassed }) {
  return `${(((passed + fixedPassed) / total) * 100).toFixed(2)}%`;
}

export function statusBlock(counts) {
  return [
    `- Total Audit Items: ${counts.total}`,
    `- Not Started: ${counts.notStarted}`,
    `- In Progress: ${counts.inProgress}`,
    `- Passed: ${counts.passed}`,
    `- Fixed + Passed: ${counts.fixedPassed}`,
    `- Blocked: ${counts.blocked}`,
    `- Failed: ${counts.failed}`,
    `- Overall Completion: ${completion(counts)}`,
  ].join('\n');
}

const HEADER = /- Total Audit Items: \d+\n- Not Started: \d+\n- In Progress: \d+\n- Passed: \d+\n- Fixed \+ Passed: \d+\n- Blocked: \d+\n- Failed: \d+\n- Overall Completion: [\d.]+%/;

export function headerBlock(text) {
  return HEADER.exec(text)?.[0] ?? null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = readFileSync(LEDGER, 'utf8');
  const { counts, unclassified } = countLedger(text);
  if (unclassified.length) {
    console.error(`rows whose status is not in the Status Legend:\n  ${unclassified.join('\n  ')}`);
    process.exit(1);
  }
  const block = statusBlock(counts);
  if (process.argv.includes('--write')) {
    if (!headerBlock(text)) {
      console.error('Audit Status block not found');
      process.exit(1);
    }
    writeFileSync(LEDGER, text.replace(HEADER, block));
  }
  console.log(block);
}
