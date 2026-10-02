import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `npm audit --audit-level=…` with a reviewed allowlist. npm has no way to
// accept one advisory, so a single high advisory with no patched release
// (node-forge GHSA-86w9-cpqp-85rv, 2026-10-02) turned the mobile job red on
// every PR. This runs the same audit, reads its JSON, and fails on every
// advisory at or above the level EXCEPT one listed by its GHSA id for its
// own package. A new advisory, even on the same package, still fails.
//
// Allowlisted advisories are printed on every run, and an entry the audit no
// longer reports is flagged for removal, so the list cannot quietly outlive
// the reason for it.

export const SEVERITIES = Object.freeze(['info', 'low', 'moderate', 'high', 'critical']);

const advisoryId = (url) => /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(url ?? '')?.[0] ?? url;

/** Every advisory in an `npm audit --json` report, once each. A package that
 *  is vulnerable only through a dependency lists that dependency's name in
 *  `via`, not an advisory, so it is not counted twice. */
export function collectAdvisories(report) {
  const byId = new Map();
  for (const vulnerability of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== 'object' || via === null) continue;
      const id = advisoryId(via.url ?? String(via.source));
      if (!byId.has(id)) byId.set(id, { id, package: via.name, severity: via.severity, title: via.title, range: via.range });
    }
  }
  return [...byId.values()];
}

export function evaluateAudit(report, { level, allowlist = {} }) {
  const floor = SEVERITIES.indexOf(level);
  if (floor < 0) throw new Error(`Unknown audit level "${level}"; expected one of ${SEVERITIES.join(', ')}.`);
  if (!report || typeof report !== 'object' || report.error || !report.vulnerabilities) {
    throw new Error(`npm audit did not return a report${report?.error ? `: ${report.error.summary ?? report.error.code}` : ''}.`);
  }

  const atLevel = collectAdvisories(report).filter((a) => SEVERITIES.indexOf(a.severity) >= floor);
  const isAllowed = (a) => allowlist[a.id]?.package === a.package;
  const reported = new Set(collectAdvisories(report).map((a) => a.id));
  return {
    blocking: atLevel.filter((a) => !isAllowed(a)),
    allowed: atLevel.filter(isAllowed),
    stale: Object.keys(allowlist).filter((id) => !reported.has(id)),
  };
}

function runCli(args) {
  const levelArg = args.find((a) => a.startsWith('--audit-level='));
  const listArg = args.find((a) => a.startsWith('--allowlist='));
  if (!levelArg || !listArg) {
    console.error('usage: audit-npm-advisories.mjs --audit-level=<level> --allowlist=<file> [npm audit flags…]');
    process.exitCode = 2;
    return;
  }
  const level = levelArg.split('=')[1];
  const allowlist = JSON.parse(readFileSync(resolve(listArg.split('=')[1]), 'utf8')).advisories ?? {};
  const npmArgs = args.filter((a) => a !== levelArg && a !== listArg);

  // npm audit exits non-zero whenever it finds anything; the JSON is the answer.
  const run = spawnSync('npm', ['audit', ...npmArgs, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let report;
  try { report = JSON.parse(run.stdout); } catch {
    console.error(`npm audit printed no JSON report (exit ${run.status}).\n${run.stderr}`);
    process.exitCode = 1;
    return;
  }

  const { blocking, allowed, stale } = evaluateAudit(report, { level, allowlist });
  const line = (a) => `  ${a.severity} ${a.package} ${a.range ?? ''} ${a.id}: ${a.title}`;
  for (const a of allowed) console.warn(`ALLOWLISTED (${allowlist[a.id].reason})\n${line(a)}`);
  for (const id of stale) console.warn(`Allowlist entry ${id} is no longer reported by npm audit: remove it.`);
  if (blocking.length > 0) {
    console.error(`\nDependency audit failed: ${blocking.length} advisory(ies) at "${level}" or above.`);
    for (const a of blocking) console.error(line(a));
    process.exitCode = 1;
    return;
  }
  console.log(`Dependency audit passed at "${level}" (${allowed.length} allowlisted).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2));
}
