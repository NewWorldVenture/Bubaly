// scripts/audit-register-counts.mjs — counts Register B in finalaudit.md and
// checks the "Current reconciled audit counts" summary against it.
//
// The summary was a hand-kept tally. Every checkpoint after 2026-10-02 said
// "no recount was performed", and two of them disagreed with each other (one
// carried 11,701 NOT STARTED / 2,484 IN PROGRESS, another 11,700 / 2,485 after
// LIBRARY-2E628A2A31CE moved). The register itself is the evidence; the summary
// is a statement about it, so it is derived from the rows here and a drifted
// summary fails instead of being carried forward.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const AUDIT_FILE = resolve(ROOT, 'finalaudit.md');

export const STATUSES = Object.freeze({
  notStarted: '⬜ NOT STARTED',
  inProgress: '🔄 IN PROGRESS',
  passed: '✅ PASS',
  fixedPassed: '🛠 FIXED + PASS',
  blocked: '⚠️ BLOCKED',
});

const REGISTER_HEADING = /^# Register B\b.*\(([\d,]+) items\)\s*$/;
const ROW = /^\| \*{0,2}([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\*{0,2} \|/;

const toNumber = (text) => Number(text.replace(/,/g, ''));

/** Every Register B row: its ID, status cell and line number. */
export function readRegister(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => REGISTER_HEADING.test(line));
  if (start === -1) throw new Error('finalaudit.md has no "# Register B … (N items)" heading');
  const declared = toNumber(REGISTER_HEADING.exec(lines[start])[1]);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^# /.test(lines[index])) {
      end = index;
      break;
    }
  }
  const rows = [];
  for (let index = start + 1; index < end; index += 1) {
    const match = ROW.exec(lines[index]);
    if (!match) continue;
    const cells = lines[index].trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    rows.push({ id: match[1], status: cells[3] ?? '', line: index + 1 });
  }
  return { declared, rows };
}

/** The register's own tally: per status, total, duplicates, unknown statuses. */
export function countRegister(markdown) {
  const { declared, rows } = readRegister(markdown);
  const counts = Object.fromEntries(Object.keys(STATUSES).map((key) => [key, 0]));
  const byStatus = new Map(Object.entries(STATUSES).map(([key, label]) => [label, key]));
  const seen = new Map();
  const duplicates = [];
  const unknown = [];
  for (const row of rows) {
    if (seen.has(row.id)) duplicates.push(`${row.id} (lines ${seen.get(row.id)} and ${row.line})`);
    else seen.set(row.id, row.line);
    const key = byStatus.get(row.status);
    if (key) counts[key] += 1;
    else unknown.push(`${row.id} (line ${row.line}): ${row.status}`);
  }
  const closed = counts.passed + counts.fixedPassed;
  return { declared, total: rows.length, counts, closed, duplicates, unknown };
}

const SUMMARY_FIELDS = Object.freeze({
  total: 'Total Audit Items',
  notStarted: 'Not Started',
  inProgress: 'In Progress',
  passed: 'Passed',
  fixedPassed: 'Fixed + Passed',
  blocked: 'Blocked',
});

/** The numbers the "Current reconciled audit counts" section states. */
export function readSummary(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^## Current reconciled audit counts\s*$/.test(line));
  if (start === -1) throw new Error('finalaudit.md has no "## Current reconciled audit counts" section');
  const summary = {};
  for (let index = start + 1; index < lines.length && !/^#{1,2} /.test(lines[index]); index += 1) {
    for (const [key, label] of Object.entries(SUMMARY_FIELDS)) {
      const match = new RegExp(`^- ${label.replace(/[+]/g, '\\+')}: \\*\\*([\\d,]+)\\*\\*`).exec(lines[index]);
      if (match) summary[key] = toNumber(match[1]);
    }
    const coverage = /^- Verified closure coverage: \*\*([\d.]+)%\*\* \(([\d,]+) ?\/ ?([\d,]+)\)/.exec(lines[index]);
    if (coverage) {
      summary.coveragePercent = coverage[1];
      summary.coverageClosed = toNumber(coverage[2]);
      summary.coverageTotal = toNumber(coverage[3]);
    }
  }
  return summary;
}

/** Every way the summary disagrees with the register, as sentences. */
export function reconcile(markdown) {
  const register = countRegister(markdown);
  const summary = readSummary(markdown);
  const problems = [];
  if (register.declared !== register.total) {
    problems.push(`Register B's heading says ${register.declared} items; it holds ${register.total} rows`);
  }
  for (const duplicate of register.duplicates) problems.push(`duplicate register ID ${duplicate}`);
  for (const row of register.unknown) problems.push(`unrecognised status on ${row}`);
  const expected = { total: register.total, ...register.counts };
  for (const [key, label] of Object.entries(SUMMARY_FIELDS)) {
    if (summary[key] !== expected[key]) {
      problems.push(`summary "${label}" says ${summary[key] ?? 'nothing'}; the register counts ${expected[key]}`);
    }
  }
  const percent = ((register.closed / register.total) * 100).toFixed(2);
  if (
    summary.coverageClosed !== register.closed ||
    summary.coverageTotal !== register.total ||
    summary.coveragePercent !== percent
  ) {
    problems.push(
      `summary closure coverage says ${summary.coveragePercent}% (${summary.coverageClosed}/${summary.coverageTotal}); ` +
        `the register gives ${percent}% (${register.closed}/${register.total})`,
    );
  }
  return { register, summary, problems };
}

function runCli() {
  const { register, problems } = reconcile(readFileSync(AUDIT_FILE, 'utf8'));
  const { counts } = register;
  console.log(
    `Register B: ${register.total} rows = ${counts.notStarted} NOT STARTED + ${counts.inProgress} IN PROGRESS + ` +
      `${counts.passed} PASS + ${counts.fixedPassed} FIXED + PASS + ${counts.blocked} BLOCKED; ` +
      `closed ${register.closed} (${((register.closed / register.total) * 100).toFixed(2)}%).`,
  );
  if (problems.length > 0) {
    console.error('\nThe audit summary does not match its register:');
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
