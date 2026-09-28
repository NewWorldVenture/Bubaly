#!/usr/bin/env node
// API audit — call every method of every route under app/api as each caller,
// with the inputs a careless or hostile client sends: nothing, an empty JSON
// object, a body that is not JSON. One JSON line per call.
//
// It does not judge; scripts/api-audit/summarize.mjs does. It only refuses to
// run against anything but a local base URL, because it POSTs to every route.
//
//   node scripts/api-audit/sweep.mjs api-sessions.json api-sweep.jsonl

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const [sessionsFile = 'api-sessions.json', outFile = 'api-sweep.jsonl'] = process.argv.slice(2);
const { base, callers } = JSON.parse(readFileSync(sessionsFile, 'utf8'));
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(base)) {
  console.error(`Refusing: ${base} is not a local server.`);
  process.exit(1);
}

/** Every app/api route file and the methods it exports. */
export function discoverRoutes(root = 'app/api') {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === 'route.ts') {
        const src = readFileSync(full, 'utf8');
        const methods = [...src.matchAll(/^export (?:async )?(?:function|const) (GET|POST|PUT|PATCH|DELETE)\b/gm)].map((m) => m[1]);
        const route = '/' + path.relative('app', path.dirname(full)).split(path.sep).join('/');
        for (const method of [...new Set(methods)]) found.push({ file: full, route, method });
      }
    }
  };
  walk(root);
  return found.sort((a, b) => (a.route + a.method).localeCompare(b.route + b.method));
}

// A dynamic segment gets a well-formed id that matches nothing, so a route that
// looks it up must answer "not found", not throw.
const NOBODY = '00000000-0000-4000-8000-00000000abcd';
const concrete = (route) => route.replace(/\[\[?\.\.\.[^\]]+\]\]?/g, 'nothing').replace(/\[[^\]]+\]/g, NOBODY);

const PROBES = {
  GET: [{ probe: 'bare' }],
  POST: [
    { probe: 'empty-json', body: '{}', type: 'application/json' },
    { probe: 'not-json', body: '{"unterminated', type: 'application/json' },
  ],
};
for (const m of ['PUT', 'PATCH', 'DELETE']) PROBES[m] = PROBES.POST;

async function call(target, method, caller, probe) {
  const headers = { origin: base, 'user-agent': 'bubaly-api-audit' };
  if (caller.cookie) headers.cookie = caller.cookie;
  if (probe.type) headers['content-type'] = probe.type;
  const started = Date.now();
  try {
    const res = await fetch(base + target, { method, headers, body: probe.body, redirect: 'manual', signal: AbortSignal.timeout(45_000) });
    const text = await res.text();
    return {
      status: res.status, ms: Date.now() - started,
      type: res.headers.get('content-type') ?? '', location: res.headers.get('location') ?? '',
      bytes: text.length, head: text.slice(0, 400),
    };
  } catch (error) {
    return { status: 0, ms: Date.now() - started, error: String(error?.message ?? error) };
  }
}

const routes = discoverRoutes();
const lines = [];
const order = ['anon', 'child', 'parent', 'admin'];
for (const r of routes) {
  const target = concrete(r.route);
  for (const who of order) {
    for (const probe of PROBES[r.method]) {
      const result = await call(target, r.method, callers[who], probe);
      lines.push(JSON.stringify({ ...r, target, caller: who, probe: probe.probe, ...result }));
    }
  }
  process.stderr.write('.');
}
writeFileSync(outFile, lines.join('\n') + '\n');
console.error(`\n${lines.length} calls over ${routes.length} route methods → ${outFile}`);
