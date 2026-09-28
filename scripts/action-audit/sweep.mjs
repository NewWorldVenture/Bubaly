#!/usr/bin/env node
// Server-action audit — call every server action in a production build as each
// caller (signed out, a child, a parent, a super admin), with no arguments, the
// way a hostile client can: a POST to a page that loads the action, carrying
// its `Next-Action` id. One JSON line per call.
//
// The build's own manifest (.next/server/server-reference-manifest.json) names
// every action, its source file, its export and the pages that load it, so
// nothing is discovered by guessing. The callers come from
// scripts/api-audit/sessions.mjs.
//
// It does not judge; scripts/action-audit/summarize.mjs does. With no
// arguments most actions fail validation before they reach their own
// authorization, so a refusal here is not proof of a guard. What this can
// find is an action that returns data, or reports success, to a caller who
// should get neither.
//
// Local servers ONLY: signed in, an action that takes no arguments runs. The
// accounts sessions.mjs makes are disposable, and actions that would end the
// caller's own session or account are skipped for signed-in callers, so the
// rest of the sweep keeps its callers.
//
//   node scripts/action-audit/sweep.mjs api-sessions.json .next action-sweep.jsonl

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [sessionsFile = 'api-sessions.json', buildDir = '.next', outFile = 'action-sweep.jsonl'] = process.argv.slice(2);
const { base, callers } = JSON.parse(readFileSync(sessionsFile, 'utf8'));
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(base)) {
  console.error(`Refusing: ${base} is not a local server.`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(buildDir, 'server', 'server-reference-manifest.json'), 'utf8'));

const NOBODY = '00000000-0000-4000-8000-00000000abcd';
/** `app/(app)/admin/[id]/page` → `/admin/<nobody>`; route groups vanish. */
export function pagePath(worker) {
  const segments = worker.replace(/^app\//, '').replace(/\/(page|route)$/, '').split('/')
    .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'))
    .map((s) => (/^\[\[?\.\.\./.test(s) ? 'nothing' : /^\[.*\]$/.test(s) ? NOBODY : s));
  return '/' + segments.filter(Boolean).join('/');
}

/** The page to post to: a static one if any loads the action, else the shortest. */
export function targetFor(workers) {
  const pages = Object.keys(workers).filter((w) => w.endsWith('/page'));
  if (!pages.length) return null;
  const ranked = pages.map((w) => ({ w, dynamic: /\[/.test(w), len: w.length }))
    .sort((a, b) => Number(a.dynamic) - Number(b.dynamic) || a.len - b.len);
  return pagePath(ranked[0].w);
}

// Signed in, these would end the caller's session or account, and every later
// call for that caller would measure a signed-out user instead.
const ENDS_THE_CALLER = /sign.?out|log.?out|delete.*account|account.*delete|leave.*family|remove.*self/i;

/** Row `0:` names the row that holds the result (`"a":"$@N"`). */
export function readResult(text) {
  const rows = new Map();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]+):(.*)$/.exec(line);
    if (m) rows.set(m[1], m[2]);
  }
  const head = rows.get('0') ?? '';
  const ref = /"a":"\$@([0-9a-f]+)"/.exec(head)?.[1];
  if (!ref) return { kind: 'no-result' };
  const raw = rows.get(ref) ?? '';
  if (raw.startsWith('E')) return { kind: 'threw', raw: raw.slice(0, 200) };
  return { kind: 'returned', raw: raw.slice(0, 400) };
}

async function call(target, id, caller) {
  const headers = {
    origin: base, 'user-agent': 'bubaly-action-audit',
    'next-action': id, 'content-type': 'text/plain;charset=UTF-8', accept: 'text/x-component',
  };
  if (caller.cookie) headers.cookie = caller.cookie;
  const started = Date.now();
  try {
    const res = await fetch(base + target, { method: 'POST', headers, body: '[]', redirect: 'manual', signal: AbortSignal.timeout(45_000) });
    const text = await res.text();
    return {
      status: res.status, ms: Date.now() - started,
      location: res.headers.get('location') ?? '',
      actionRedirect: res.headers.get('x-action-redirect') ?? '',
      result: res.status < 300 || res.status >= 500 ? readResult(text) : { kind: 'no-result' },
    };
  } catch (error) {
    return { status: 0, ms: Date.now() - started, error: String(error?.message ?? error) };
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const actions = Object.entries(manifest.node ?? {})
    .map(([id, a]) => ({ id, file: a.filename, name: a.exportedName, target: targetFor(a.workers ?? {}) }))
    .sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name));
  const lines = [];
  const order = ['anon', 'child', 'parent', 'admin'];
  for (const a of actions) {
    for (const who of order) {
      if (!a.target) { lines.push(JSON.stringify({ ...a, caller: who, skipped: 'no page loads it' })); continue; }
      if (who !== 'anon' && ENDS_THE_CALLER.test(a.name)) { lines.push(JSON.stringify({ ...a, caller: who, skipped: 'would end the caller' })); continue; }
      lines.push(JSON.stringify({ ...a, caller: who, ...(await call(a.target, a.id, callers[who])) }));
    }
    process.stderr.write('.');
  }
  writeFileSync(outFile, lines.join('\n') + '\n');
  console.error(`\n${lines.length} calls over ${actions.length} actions → ${outFile}`);
}
