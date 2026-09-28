#!/usr/bin/env node
// Server-action audit — read scripts/action-audit/sweep.mjs's lines and sort
// every call into what it tells us.
//
//   BLOCKED   refused before the action ran: the middleware's login redirect,
//             or the action redirecting to /login or /plan.
//   REFUSED   the action ran and said no: it threw, or returned a result that
//             carries an error or `ok: false`.
//   RETURNED  the action returned something that is not a refusal. With no
//             arguments that is expected for a read or a no-argument command
//             the caller may run; it is a finding when the caller may not.
//             Every RETURNED call is listed for a person to read.
//   FAIL      the server answered 5xx without an action result, the
//             connection dropped, or an admin action returned to a non-admin.
//
//   node scripts/action-audit/summarize.mjs action-sweep.jsonl

import { readFileSync } from 'node:fs';

const [file = 'action-sweep.jsonl'] = process.argv.slice(2);
const calls = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const ADMIN_FILE = /app\/\(app\)\/admin\/|app\/admin\/|lib\/marketing\//;
const REFUSAL = /"ok":false|"error":|"reason":|"refused"|not authori[sz]ed|forbidden/i;

export function verdict(c) {
  if (c.skipped) return 'SKIPPED';
  if (c.status === 0) return 'FAIL';
  if (c.status === 307 || c.status === 303 || c.status === 302) {
    return /\/login|\/plan|\/kid-login|\/onboarding/.test(c.location + c.actionRedirect) ? 'BLOCKED' : 'RETURNED';
  }
  if (c.actionRedirect && /\/login|\/plan|\/kid-login|\/onboarding/.test(c.actionRedirect)) return 'BLOCKED';
  const r = c.result ?? { kind: 'no-result' };
  if (r.kind === 'threw') return 'REFUSED';
  if (r.kind === 'no-result') return c.status >= 500 ? 'FAIL' : 'REFUSED';
  if (REFUSAL.test(r.raw)) return 'REFUSED';
  if (ADMIN_FILE.test(c.file) && (c.caller === 'child' || c.caller === 'parent')) return 'FAIL';
  return 'RETURNED';
}

const tally = {};
const byVerdict = {};
for (const c of calls) {
  const v = verdict(c);
  tally[`${c.caller} ${v}`] = (tally[`${c.caller} ${v}`] ?? 0) + 1;
  (byVerdict[v] ??= []).push(c);
}
console.log(`${calls.length} calls over ${new Set(calls.map((c) => c.id)).size} actions`);
console.log(Object.entries(tally).sort().map(([k, n]) => `  ${k}: ${n}`).join('\n'));
for (const v of ['FAIL', 'RETURNED']) {
  console.log(`\n${v} (${(byVerdict[v] ?? []).length})`);
  for (const c of byVerdict[v] ?? []) {
    console.log(`  ${c.caller.padEnd(6)} ${c.status} ${c.file} ${c.name} → ${(c.result?.raw ?? c.location ?? c.error ?? '').slice(0, 160)}`);
  }
}
