#!/usr/bin/env node
// API audit — judge a sweep. Every call lands in exactly one bucket, and each
// route method gets one verdict line, so nothing in the sweep goes unread.
//
//   FAIL   a 5xx, a dropped connection or timeout, a stack trace or internal
//          error text in the body, an /api/admin route that answers 2xx to a
//          child or a non-admin parent, or a cron route that answers anything
//          but 401/403 without the cron secret.
//   BLOCKED a 503 whose body says the feature is not set up on this server
//          (no AI, payment, push, GIF or telephony credentials): an honest
//          answer, and the rest of the route needs those credentials to test.
//   REVIEW a 2xx to a signed-out caller (public by design, or a leak?), or a
//          2xx to a body that is not JSON (did it accept garbage?).
//   OK     everything else: a 4xx with a reason, a redirect to sign-in.
//
//   node scripts/api-audit/summarize.mjs api-sweep.jsonl

import { readFileSync } from 'node:fs';

const rows = readFileSync(process.argv[2] ?? 'api-sweep.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const NOT_SET_UP = /not (?:set up|configured)|isn[’']t (?:set up|configured)|not_configured/i;
const LEAK = /\bat [\w.<>]+ \(|node_modules\/|\bPostgrestError\b|violates (row-level|foreign key|check|not-null)|duplicate key value|relation "[^"]+" does not exist|syntax error at or near|TypeError:|ReferenceError:/;

export function judge(r) {
  const two = r.status >= 200 && r.status < 300;
  if (r.status === 0) return ['FAIL', `no response (${r.error})`];
  if (r.status === 503 && NOT_SET_UP.test(r.head ?? '')) return ['BLOCKED', 'not set up on this server'];
  if (r.status >= 500) return ['FAIL', `${r.status}`];
  if (LEAK.test(r.head ?? '')) return ['FAIL', `internal detail in body`];
  if (r.route.startsWith('/api/admin') && two && (r.caller === 'child' || r.caller === 'parent')) return ['FAIL', `admin route ${r.status} to ${r.caller}`];
  if (r.route.startsWith('/api/cron') && ![401, 403].includes(r.status)) return ['FAIL', `cron route ${r.status} without the cron secret`];
  if (two && r.caller === 'anon') return ['REVIEW', `${r.status} signed out`];
  if (two && r.probe === 'not-json') return ['REVIEW', `${r.status} to a non-JSON body`];
  return ['OK', `${r.status}`];
}

const byRoute = new Map();
for (const r of rows) {
  const key = `${r.method} ${r.route}`;
  const [verdict, why] = judge(r);
  const entry = byRoute.get(key) ?? { verdicts: [], statuses: [] };
  entry.verdicts.push({ verdict, why, caller: r.caller, probe: r.probe });
  entry.statuses.push(`${r.caller[0]}${r.probe === 'not-json' ? '!' : ''}:${r.status}`);
  byRoute.set(key, entry);
}
const totals = { FAIL: 0, BLOCKED: 0, REVIEW: 0, OK: 0 };
for (const [key, { verdicts, statuses }] of byRoute) {
  const worst = ['FAIL', 'BLOCKED', 'REVIEW'].find((level) => verdicts.some((v) => v.verdict === level)) ?? 'OK';
  totals[worst]++;
  const reasons = [...new Set(verdicts.filter((v) => v.verdict === worst && worst !== 'OK').map((v) => `${v.caller}/${v.probe}: ${v.why}`))];
  console.log(`${worst.padEnd(6)} ${key}  [${statuses.join(' ')}]${reasons.length ? '  ' + reasons.join('; ') : ''}`);
}
console.log(`\n${byRoute.size} route methods: ${totals.FAIL} FAIL, ${totals.BLOCKED} BLOCKED, ${totals.REVIEW} REVIEW, ${totals.OK} OK`);
