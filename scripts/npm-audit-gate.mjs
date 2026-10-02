#!/usr/bin/env node
/**
 * `npm audit` with a named, dated exception list.
 *
 * `npm audit --audit-level=high` has no way to say "this one advisory, until
 * this date". When an advisory covers every version of a transitive package
 * (GHSA-86w9-cpqp-85rv, node-forge `*`, under Expo's CLI), there is nothing to
 * upgrade to, and the only options were a red job on every PR or dropping the
 * level — which would also let the next, unrelated high advisory through.
 *
 * This reads `npm audit --json` on stdin and fails on any advisory at or above
 * the level unless it is listed in the exceptions file AND that exception has
 * not expired. An expired exception fails the job by name, so it cannot quietly
 * become permanent. Output that is not an audit report (a network error, an
 * npm crash) fails too: an audit that did not run is not a pass.
 *
 *   npm audit --omit=dev --json > audit.json || true
 *   node ../scripts/npm-audit-gate.mjs --level high --exceptions audit-exceptions.json < audit.json
 */
import { readFileSync } from 'node:fs';

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/** The GHSA id an advisory's URL names, or the URL itself. */
export function advisoryId(via) {
  const m = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(via.url ?? '');
  return m ? m[0].toUpperCase() : String(via.url ?? via.source);
}

/**
 * Pure decision, so it can be tested without npm.
 * Returns { ok, blocking: [...], excused: [...], expired: [...] }.
 */
export function evaluate(report, { level, exceptions, today }) {
  if (!report || typeof report !== 'object' || typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null) {
    return { ok: false, error: 'not an npm audit report', blocking: [], excused: [], expired: [] };
  }
  const floor = RANK[level];
  if (floor === undefined) throw new Error(`unknown level ${level}`);
  const byId = new Map(exceptions.map((e) => [e.id.toUpperCase(), e]));
  const blocking = [];
  const excused = [];
  const expired = [];
  const seen = new Set();
  for (const [pkg, vuln] of Object.entries(report.vulnerabilities)) {
    // Only advisory OBJECTS are advisories; a string in `via` is a package that
    // inherits one, and that advisory is judged where it is declared.
    for (const via of vuln.via ?? []) {
      if (typeof via !== 'object' || via === null) continue;
      if ((RANK[via.severity] ?? 0) < floor) continue;
      const id = advisoryId(via);
      if (seen.has(`${pkg}|${id}`)) continue;
      seen.add(`${pkg}|${id}`);
      const exception = byId.get(id);
      const entry = { pkg, id, severity: via.severity, title: via.title };
      if (!exception || (exception.package && exception.package !== pkg)) blocking.push(entry);
      else if (!(today < exception.expires)) expired.push({ ...entry, expires: exception.expires });
      else excused.push({ ...entry, expires: exception.expires });
    }
  }
  return { ok: blocking.length === 0 && expired.length === 0, blocking, excused, expired };
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const level = arg('level', 'high');
  const exceptionsPath = arg('exceptions');
  const exceptions = exceptionsPath ? JSON.parse(readFileSync(exceptionsPath, 'utf8')) : [];
  let report;
  try {
    report = JSON.parse(readFileSync(0, 'utf8'));
  } catch (err) {
    console.error(`npm-audit-gate: could not read the audit report: ${err.message}`);
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const result = evaluate(report, { level, exceptions, today });
  if (result.error) {
    console.error(`npm-audit-gate: ${result.error}`);
    process.exit(1);
  }
  for (const e of result.excused) console.log(`excused until ${e.expires}: ${e.pkg} ${e.id} (${e.severity}) ${e.title ?? ''}`);
  for (const e of result.expired) console.error(`EXCEPTION EXPIRED ${e.expires}: ${e.pkg} ${e.id} (${e.severity}) — fix it or renew the exception with a reason`);
  for (const e of result.blocking) console.error(`BLOCKING: ${e.pkg} ${e.id} (${e.severity}) ${e.title ?? ''}`);
  if (!result.ok) process.exit(1);
  console.log(`npm-audit-gate: no unexcused advisory at or above ${level}`);
}
