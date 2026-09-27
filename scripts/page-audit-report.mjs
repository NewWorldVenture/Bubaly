#!/usr/bin/env node
// Turns scripts/page-audit.mjs output into the markdown rows finalaudit.md's
// "Page audit — every page" section keeps, so every bot writes the same shape.
//
//   node scripts/page-audit-report.mjs --label "prod desktop" a.jsonl [b.jsonl …]
//
// One row per route. Rows that share a dynamic pattern (every /blog/<slug>)
// collapse into one row with counts, and name each page that did not pass.
// A later file wins over an earlier one for the same path, so a re-check run
// passed last replaces the first attempt.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const li = args.indexOf('--label');
const label = li === -1 ? '' : args[li + 1];
const files = args.filter((a, i) => a.endsWith('.jsonl') && args[i - 1] !== '--label');

const byPath = new Map();
for (const f of files) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    byPath.set(r.path, r);
  }
}

// Collapse families of generated pages into their pattern.
const PATTERNS = [
  [/^\/blog\/[^/]+$/, '/blog/[slug]'],
  [/^\/blog\/category\/[^/]+$/, '/blog/category/[category]'],
  [/^\/features\/[^/]+$/, '/features/[slug]'],
  [/^\/resources\/[^/]+$/, '/resources/[slug]'],
  [/^\/services\/[^/]+$/, '/services/[slug]'],
  [/^\/reviews\/[^/]+$/, '/reviews/[slug]'],
  [/^\/p\/[^/]+$/, '/p/[slug]'],
  [/^\/s\/[^/]+$/, '/s/[slug]'],
];
const patternOf = (p) => {
  const path = p.split('?')[0];
  for (const [re, name] of PATTERNS) if (re.test(path)) return name;
  return path;
};

function problems(r) {
  const out = [];
  if (r.error) out.push(r.error);
  if (r.status != null && r.status >= 400) out.push(`HTTP ${r.status}`);
  for (const e of r.pageErrors ?? []) out.push(`uncaught: ${e}`);
  for (const b of r.badRequests ?? []) out.push(`request ${b}`);
  if (!(r.badRequests ?? []).length) for (const c of r.consoleErrors ?? []) out.push(`console: ${c}`);
  for (const s of r.smells ?? []) out.push(`renders ${s}`);
  if ((r.overflow ?? 0) > 1) out.push(`overflows ${r.overflow}px${r.mobile ? ' at 390' : ''}`);
  return out;
}

const groups = new Map();
for (const r of byPath.values()) {
  const key = patternOf(r.path);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
for (const [route, rows] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const failing = rows.filter((r) => r.verdict !== 'PASS');
  const lands = [...new Set(rows.map((r) => (r.finalPath ?? '').split('?')[0]).filter((p) => p && p !== route))];
  const status = failing.length ? '❌ CHECK' : '✅ PASS';
  const count = rows.length > 1 ? `${rows.length - failing.length}/${rows.length} pages clean` : '';
  const notes = failing.slice(0, 3)
    .map((r) => `${rows.length > 1 ? `${r.path}: ` : ''}${problems(r).slice(0, 2).join('; ')}`)
    .join(' · ');
  const redirect = lands.length === 1 && rows.length === 1 ? `→ ${lands[0]}` : '';
  console.log(`| ${esc(route)} | ${esc(label)} | ${status} | ${esc([count, redirect, notes].filter(Boolean).join(' '))} |`);
}
