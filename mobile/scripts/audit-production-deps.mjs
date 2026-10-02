// The Expo app's production-dependency audit (MAIN-F-C10), as CI runs it.
//
// It runs `npm audit --omit=dev --json` and fails on any high or critical
// advisory, unless that advisory is listed in ALLOWED below. Each exception
// names the advisory, why it is accepted, and the date it lapses. After that
// date the audit fails again until someone re-checks the advisory and either
// removes the exception or renews it. Moderate advisories are reported by
// `npm audit` but do not fail the job, as before (see .github/workflows/ci.yml).
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const FAILING_SEVERITIES = ['high', 'critical'];

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

const advisoryId = (via) => String(via.url ?? '').match(/GHSA(?:-[0-9a-z]{4}){3}/)?.[0] ?? String(via.source ?? via.title ?? 'unknown');

/**
 * The high or critical advisories in an `npm audit --json` report that are not
 * allowed on `today` (YYYY-MM-DD). Entries that are only "depends on a vulnerable
 * package" are skipped: their advisory is listed under the package it is in.
 */
export function unexpectedAdvisories(report, today, allowed = ALLOWED) {
  const failing = [];
  for (const [pkg, entry] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const via of entry?.via ?? []) {
      if (typeof via !== 'object' || via === null) continue;
      if (!FAILING_SEVERITIES.includes(via.severity)) continue;
      const id = advisoryId(via);
      const rule = allowed[id];
      if (rule && today <= rule.until) continue;
      failing.push({ pkg, id, severity: via.severity, title: via.title, expired: rule ? rule.until : null });
    }
  }
  return failing;
}

function main() {
  const run = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    console.error('npm audit gave no readable report; failing closed.');
    if (run.stderr) console.error(run.stderr.trim());
    process.exit(1);
  }
  if (report.error) {
    console.error(`npm audit failed; failing closed: ${report.error.summary ?? JSON.stringify(report.error)}`);
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const counts = report.metadata?.vulnerabilities ?? {};
  console.log(`npm audit --omit=dev: ${JSON.stringify(counts)}`);
  for (const [id, rule] of Object.entries(ALLOWED)) {
    if (today <= rule.until) console.log(`allowed until ${rule.until}: ${id}. ${rule.reason}`);
  }
  const failing = unexpectedAdvisories(report, today);
  if (failing.length === 0) {
    console.log('No high or critical advisory outside the dated exceptions.');
    return;
  }
  for (const f of failing) {
    console.error(`${f.severity} ${f.id} in ${f.pkg}: ${f.title}${f.expired ? ` (exception lapsed ${f.expired})` : ''}`);
  }
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
