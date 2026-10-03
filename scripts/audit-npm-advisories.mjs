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

const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const ghsaId = /^GHSA(?:-[0-9a-z]{4}){3}$/;
const advisoryId = (url) => /^https:\/\/github\.com\/advisories\/(GHSA(?:-[0-9a-z]{4}){3})$/.exec(typeof url === 'string' ? url : '')?.[1] ?? null;

/** A readable report cannot turn a failed or interrupted npm command into success. */
export function runProblem(run) {
  if (run?.error) return `npm could not be run: ${run.error.message ?? run.error}`;
  if (run?.signal) return `npm audit was terminated by ${run.signal}`;
  if (run?.status !== 0 && run?.status !== 1) return `npm audit exited ${run?.status}`;
  return null;
}

/** Validate a complete version-2 report before allowing any advisory exception. */
export function reportProblem(report, { level = 'high' } = {}) {
  const floor = SEVERITIES.indexOf(level);
  if (floor < 0) return `unknown audit level ${JSON.stringify(level)}`;
  if (!isMap(report)) return 'the report is not an object';
  if (report.error) return `npm audit reported an error: ${report.error.summary ?? report.error.code ?? JSON.stringify(report.error)}`;
  if (report.auditReportVersion !== 2) return `auditReportVersion is ${JSON.stringify(report.auditReportVersion)}, not 2`;
  const entries = report.vulnerabilities;
  if (!isMap(entries)) return 'vulnerabilities is not a map of packages';
  const counts = report.metadata?.vulnerabilities;
  if (!isMap(counts)) return 'metadata.vulnerabilities is missing';
  const listed = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  const identities = new Map();
  for (const [pkg, entry] of Object.entries(entries)) {
    if (!isMap(entry) || !SEVERITIES.includes(entry.severity)) return `${pkg} has no known severity`;
    if (!Array.isArray(entry.via) || entry.via.length === 0) return `${pkg} has no via list`;
    listed[entry.severity] += 1;
    for (const via of entry.via) {
      if (typeof via === 'string') {
        if (!Object.hasOwn(entries, via)) return `${pkg} depends on ${via}, which the report does not list`;
      } else if (!isMap(via) || !SEVERITIES.includes(via.severity) || typeof via.name !== 'string' || !via.name.trim()) {
        return `${pkg} has a malformed advisory`;
      } else {
        const id = advisoryId(via.url);
        const prior = id ? identities.get(id) : undefined;
        if (prior && (prior.name !== via.name || prior.severity !== via.severity)) return `${id} has inconsistent package or severity details`;
        if (id) identities.set(id, via);
      }
    }
  }
  // Reachability starts with actual advisories, not a neighbor or a cycle.
  // Repeat until stable so arbitrarily ordered, multi-hop chains are checked.
  const relevant = Object.keys(entries).filter((pkg) => SEVERITIES.indexOf(entries[pkg].severity) >= floor);
  const anchored = new Set(relevant.filter((pkg) => entries[pkg].via.some((via) => isMap(via) && SEVERITIES.indexOf(via.severity) >= floor)));
  for (let grew = true; grew;) {
    grew = false;
    for (const pkg of relevant) {
      if (!anchored.has(pkg) && entries[pkg].via.some((via) => typeof via === 'string' && anchored.has(via))) {
        anchored.add(pkg);
        grew = true;
      }
    }
  }
  const unanchored = relevant.find((pkg) => !anchored.has(pkg));
  if (unanchored) return `${unanchored} is ${entries[unanchored].severity} but reaches no advisory at ${level} or above`;
  for (const severity of SEVERITIES) {
    if (counts[severity] !== listed[severity]) return `metadata counts ${JSON.stringify(counts[severity])} ${severity}, the report lists ${listed[severity]}`;
  }
  if (counts.total !== Object.keys(entries).length) return `metadata total is ${JSON.stringify(counts.total)}, the report lists ${Object.keys(entries).length}`;
  return null;
}

/** Every advisory in an `npm audit --json` report, once each. A package that
 *  is vulnerable only through a dependency lists that dependency's name in
 *  `via`, not an advisory, so it is not counted twice. */
export function collectAdvisories(report) {
  const byId = new Map();
  for (const vulnerability of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== 'object' || via === null) continue;
      const canonicalId = advisoryId(via.url);
      const id = canonicalId ?? `unidentified advisory (${via.url ?? via.source ?? 'no identity'})`;
      // An unidentified entry must not disappear behind an identified one.
      const key = canonicalId ?? Symbol();
      if (!byId.has(key)) byId.set(key, { id, package: via.name, severity: via.severity, title: via.title, range: via.range });
    }
  }
  return [...byId.values()];
}

export function evaluateAudit(report, { level, allowlist = {} }) {
  const floor = SEVERITIES.indexOf(level);
  if (floor < 0) throw new Error(`Unknown audit level "${level}"; expected one of ${SEVERITIES.join(', ')}.`);
  const problem = reportProblem(report, { level });
  if (problem) throw new Error(`npm audit did not return a complete report: ${problem}.`);

  const atLevel = collectAdvisories(report).filter((a) => SEVERITIES.indexOf(a.severity) >= floor);
  const isAllowed = (a) => ghsaId.test(a.id) && allowlist[a.id]?.package === a.package;
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
  const problem = runProblem(run);
  if (problem) {
    console.error(`${problem}; failing closed.`);
    process.exitCode = 1;
    return;
  }
  let report;
  try { report = JSON.parse(run.stdout); } catch {
    console.error(`npm audit printed no JSON report (exit ${run.status}).\n${run.stderr}`);
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = evaluateAudit(report, { level, allowlist });
  } catch (error) {
    console.error(`${error.message}; failing closed.`);
    process.exitCode = 1;
    return;
  }
  const { blocking, allowed, stale } = result;
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
