#!/usr/bin/env node
// Page audit — the static half of "read the page" (finalaudit.md § Page Audit — every page on www.bubaly.com).
//
// For every page in the register, follows its imports (the `@/` alias and
// relative paths; packages are skipped) to the app/ and components/ files that
// render on it, and counts the hardcoded user-facing strings in them with the
// repo's own scanner (scripts/i18n-scan.mjs). A page that is clean in the
// crawl and here has had the two checks a machine can make; the rest of the
// row — forms, roles, a refused read shown as a failure — is still a reading.
//
//   node scripts/page-audit-static.mjs [--lane ADMIN] [--only /dashboard] [--json out.json]
//
// Prints one line per page: hardcoded-string count, then the files that hold
// them. Shared chrome (components/app, components/ui) is gated or scanned on
// its own and is reported once at the end rather than on all 354 pages.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './page-audit-register.mjs';
import { scanFile } from './i18n-scan.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const EXTS = ['.tsx', '.ts', '/index.tsx', '/index.ts'];
function resolveImport(from, spec) {
  let base;
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null;
  if (existsSync(base) && /\.(tsx?|mjs|js)$/.test(base)) return base;
  for (const ext of EXTS) if (existsSync(base + ext)) return base + ext;
  return null;
}

const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const closureCache = new Map();
function closure(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let src;
    try { src = readFileSync(file, 'utf8'); } catch { continue; }
    for (const m of src.matchAll(IMPORT)) {
      if (/^\s*import\s+type\b/.test(m[0])) continue;
      const target = resolveImport(file, m[1] ?? m[2]);
      if (target && !seen.has(target)) stack.push(target);
    }
  }
  return [...seen].map((f) => relative(ROOT, f));
}

// Scanned separately: the app chrome is its own gated surface, and the UI kit
// renders whatever its caller hands it.
const SHARED = /^components\/(app|ui|i18n)\//;
const findingsCache = new Map();
function findingsOf(file) {
  if (!findingsCache.has(file)) findingsCache.set(file, scanFile(join(ROOT, file)).length);
  return findingsCache.get(file);
}

const { lanes } = build();
const laneFilter = arg('lane');
const only = arg('only');
const report = [];
const shared = new Map();
for (const l of lanes) {
  if (laneFilter && l.lane.id !== laneFilter) continue;
  for (const row of l.rows) {
    if (only && !row.route.startsWith(only)) continue;
    const files = closure(join(ROOT, row.file)).filter((f) => /^(app|components)\/.*\.tsx?$/.test(f));
    const own = [];
    for (const f of files) {
      const n = findingsOf(f);
      if (!n) continue;
      if (SHARED.test(f)) shared.set(f, n);
      else own.push({ file: f, strings: n });
    }
    own.sort((a, b) => b.strings - a.strings);
    report.push({ lane: l.lane.id, route: row.route, file: row.file, files: files.length, strings: own.reduce((s, o) => s + o.strings, 0), holders: own });
  }
}

for (const r of report) {
  console.log(`${String(r.strings).padStart(4)}  ${r.route}${r.strings ? '  ← ' + r.holders.slice(0, 4).map((h) => `${h.file} (${h.strings})`).join(', ') + (r.holders.length > 4 ? ', …' : '') : ''}`);
}
const clean = report.filter((r) => !r.strings).length;
console.log(`\n${report.length} pages; ${clean} with no hardcoded copy in their own files; ${report.length - clean} with some.`);
if (shared.size) console.log(`Shared chrome/UI files with findings (counted once): ${[...shared].map(([f, n]) => `${f} (${n})`).join(', ')}`);
if (arg('json')) writeFileSync(arg('json'), JSON.stringify({ report, shared: Object.fromEntries(shared) }, null, 2));
