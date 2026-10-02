// The Expo app's production-dependency audit (MAIN-F-C10), as CI runs it.
//
// It runs `npm audit --omit=dev --json` and fails on any high or critical
// advisory, unless that advisory is listed in ALLOWED below. Each exception
// names the advisory, why it is accepted, and the date it lapses. After that
// date the audit fails again until someone re-checks the advisory and either
// removes the exception or renews it. Moderate advisories are reported by
// `npm audit` but do not fail the job, as before (see .github/workflows/ci.yml).
//
// It fails closed on anything it cannot vouch for: npm that did not run, was
// killed or exited other than 0 (no findings) or 1 (findings); output that is
// not a complete version-2 report; and an advisory whose identity is not a
// GitHub advisory URL, which no exception can match.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const FAILING_SEVERITIES = ['high', 'critical'];
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];

export const ALLOWED = {
  'GHSA-86w9-cpqp-85rv': {
    until: '2026-11-02',
    reason:
      'node-forge RSA PKCS#1 v1.5 signature verification accepts extra nested DigestAlgorithm elements. '
      + 'It covers node-forge <=1.4.0, and 1.4.0 is the latest release, so there is nothing to upgrade to. '
      + 'It reaches this project only through @expo/cli -> @expo/code-signing-certificates, '
      + 'the Expo command-line tool, which Metro does not bundle into the app. Published 2026-10-02.',
  },
};

const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The advisory's GHSA id, taken only from its GitHub advisory URL; null when there is none. */
export const advisoryId = (via) => String(via?.url ?? '').match(/^https:\/\/github\.com\/advisories\/(GHSA(?:-[0-9a-z]{4}){3})$/)?.[1] ?? null;

/** Why npm's process result cannot be trusted, or null. Exit 1 is npm audit's normal "found something". */
export function runProblem(run) {
  if (run?.error) return `npm could not be run: ${run.error.message ?? run.error}`;
  if (run?.signal) return `npm audit was terminated by ${run.signal}`;
  if (run?.status !== 0 && run?.status !== 1) return `npm audit exited ${run?.status}`;
  return null;
}

/**
 * Why a parsed report is not a complete, self-consistent `npm audit --json`
 * version-2 report, or null. Every "depends on" name must be listed, every
 * high or critical package must trace to a high or critical advisory, and the
 * metadata counts must equal the listed packages.
 */
export function reportProblem(report) {
  if (!isMap(report)) return 'the report is not an object';
  if (report.error) return `npm audit reported an error: ${report.error.summary ?? JSON.stringify(report.error)}`;
  if (report.auditReportVersion !== 2) return `auditReportVersion is ${JSON.stringify(report.auditReportVersion)}, not 2`;
  const entries = report.vulnerabilities;
  if (!isMap(entries)) return 'vulnerabilities is not a map of packages';
  const counts = report.metadata?.vulnerabilities;
  if (!isMap(counts)) return 'metadata.vulnerabilities is missing';
  const listed = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const [pkg, entry] of Object.entries(entries)) {
    if (!isMap(entry) || !SEVERITIES.includes(entry.severity)) return `${pkg} has no known severity`;
    if (!Array.isArray(entry.via) || entry.via.length === 0) return `${pkg} has no via list`;
    listed[entry.severity] += 1;
    let justified = !FAILING_SEVERITIES.includes(entry.severity);
    for (const via of entry.via) {
      if (typeof via === 'string') {
        if (!Object.hasOwn(entries, via)) return `${pkg} depends on ${via}, which the report does not list`;
        if (FAILING_SEVERITIES.includes(entries[via]?.severity)) justified = true;
      } else if (isMap(via) && SEVERITIES.includes(via.severity)) {
        if (FAILING_SEVERITIES.includes(via.severity)) justified = true;
      } else {
        return `${pkg} has a malformed advisory`;
      }
    }
    if (!justified) return `${pkg} is ${entry.severity} but no listed advisory or dependency is`;
  }
  for (const s of SEVERITIES) {
    if (counts[s] !== listed[s]) return `metadata counts ${JSON.stringify(counts[s])} ${s}, the report lists ${listed[s]}`;
  }
  if (counts.total !== Object.keys(entries).length) return `metadata total is ${JSON.stringify(counts.total)}, the report lists ${Object.keys(entries).length}`;
  return null;
}

/**
 * The high or critical advisories in a report that are not allowed on `today`
 * (YYYY-MM-DD). Only a GitHub advisory URL can match an exception. Entries that
 * are only "depends on a vulnerable package" are skipped here: reportProblem
 * checks that each traces to an advisory listed under the package it is in.
 */
export function unexpectedAdvisories(report, today, allowed = ALLOWED) {
  const failing = [];
  for (const [pkg, entry] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const via of entry?.via ?? []) {
      if (typeof via !== 'object' || via === null) continue;
      if (!FAILING_SEVERITIES.includes(via.severity)) continue;
      const id = advisoryId(via);
      const rule = id ? allowed[id] : undefined;
      if (rule && today <= rule.until) continue;
      failing.push({ pkg, id: id ?? `unidentified advisory (${via.title ?? 'no title'})`, severity: via.severity, title: via.title, expired: rule ? rule.until : null });
    }
  }
  return failing;
}

/** The whole decision for one npm run: { ok, lines }. */
export function auditGate(run, today, allowed = ALLOWED) {
  const problem = runProblem(run);
  if (problem) return { ok: false, lines: [`${problem}; failing closed.`, ...(run?.stderr ? [String(run.stderr).trim()] : [])] };
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    return { ok: false, lines: ['npm audit gave no readable report; failing closed.'] };
  }
  const invalid = reportProblem(report);
  if (invalid) return { ok: false, lines: [`npm audit's report is incomplete (${invalid}); failing closed.`] };
  const lines = [`npm audit --omit=dev: ${JSON.stringify(report.metadata.vulnerabilities)}`];
  for (const [id, rule] of Object.entries(allowed)) {
    if (today <= rule.until) lines.push(`allowed until ${rule.until}: ${id}. ${rule.reason}`);
  }
  const failing = unexpectedAdvisories(report, today, allowed);
  if (failing.length === 0) return { ok: true, lines: [...lines, 'No high or critical advisory outside the dated exceptions.'] };
  for (const f of failing) {
    lines.push(`${f.severity} ${f.id} in ${f.pkg}: ${f.title}${f.expired ? ` (exception lapsed ${f.expired})` : ''}`);
  }
  return { ok: false, lines };
}

function main() {
  const run = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const { ok, lines } = auditGate(run, new Date().toISOString().slice(0, 10));
  for (const line of lines) (ok ? console.log : console.error)(line);
  if (!ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
