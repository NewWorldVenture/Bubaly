#!/usr/bin/env node
// Page audit — the route list, and the check that the register holds it all.
//
// THE REGISTER is the "Every page" table in finalaudit.md, section "Page Audit —
// every page on www.bubaly.com" (session_01KP9rt5's lanes A–F). An earlier
// version of this script kept a second register in docs/audit/pages/*.md; two
// registers for one site is two answers to "what state is this page in", so
// that one was retired and its findings moved into the table (C1-S9-107).
//
// What this script still does:
//   * lists every page route from app/**/page.tsx (`routes()`, `build()`), for
//     scripts/page-audit-crawl.mjs and scripts/page-audit-static.mjs;
//   * checks the table: every page route has exactly one row there.
//
//   node scripts/page-audit-register.mjs     # exit 1 if a page has no row

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FINAL = join(ROOT, 'finalaudit.md');
export const TABLE_HEADING = '### Every page';

/**
 * Lanes, in match order: the first whose test accepts the route wins, so the
 * specific ones come before the catch-alls. `unit` is the A-unit in
 * docs/audit/COORDINATION.md §2 that owns the same paths, so a page claim and
 * a code claim never point two agents at one file.
 */
export const LANES = [
  { id: 'PUBLIC', unit: 'A-17', title: 'Public marketing, legal and share pages', test: (f) => f.startsWith('app/(marketing)/') || /^app\/(s|gift|pay|join|reviews|offline)\//.test(f) || f === 'app/page.tsx' },
  { id: 'AUTH', unit: 'A-03/A-04', title: 'Sign-in, sign-up, kid login, onboarding', test: (f) => f.startsWith('app/(auth)/') || f.startsWith('app/auth/') || f.startsWith('app/(app)/auth/') || f.startsWith('app/onboarding/') },
  { id: 'ADMIN', unit: 'A-17', title: 'Super-admin console', test: (f) => f.startsWith('app/(app)/admin/') },
  { id: 'MARKETPLACE', unit: 'A-14', title: 'Marketplace', test: (f) => f.startsWith('app/(app)/marketplace/') },
  { id: 'MONEY', unit: 'A-07/A-08/A-09', title: 'Wallet, economy, missions, kids and parent views, billing', test: (f) => /^app\/\(app\)\/(wallet|economy|missions|kids|parent)\//.test(f) || /^app\/\(app\)\/dashboard\/(billing|budget|finances|money[^/]*|subscriptions|bills|savings[^/]*|tax[^/]*|invest[^/]*|allowance[^/]*)(\/|$)/.test(f) },
  { id: 'TRAVEL', unit: 'A-13', title: 'Vacations, trips, concierge, trip intel', test: (f) => /^app\/\(app\)\/dashboard\/(vacations|trips|concierge|trip-intel|weekend)(\/|$)/.test(f) },
  { id: 'SOCIAL', unit: 'A-17', title: 'Social publishing', test: (f) => f.startsWith('app/(app)/dashboard/social/') },
  { id: 'FAMILY', unit: 'A-12', title: 'Family, guardian, safety, members', test: (f) => /^app\/\(app\)\/(family|guardian)\//.test(f) || f.startsWith('app/(app)/dashboard/family/') },
  { id: 'HOME', unit: 'A-05', title: 'Home, display, capture and the app shell pages', test: (f) => /^app\/\(app\)\/(home|display|capture|services|referrals|feedback)\//.test(f) || /^app\/\(app\)\/dashboard\/page\.tsx$/.test(f) || f.startsWith('app/(app)/dashboard/home/') },
  { id: 'DASH-A-F', unit: 'A-05..A-11', title: 'Dashboard modules a–f', test: (f) => /^app\/\(app\)\/dashboard\/[a-f]/.test(f) },
  { id: 'DASH-G-M', unit: 'A-05..A-11', title: 'Dashboard modules g–m', test: (f) => /^app\/\(app\)\/dashboard\/[g-m]/.test(f) },
  { id: 'DASH-N-Z', unit: 'A-05..A-11', title: 'Dashboard modules n–z', test: (f) => /^app\/\(app\)\/dashboard\/[n-z0-9]/.test(f) },
  { id: 'OTHER', unit: '—', title: 'Anything no lane above claims (should stay empty)', test: () => true },
];

/** `app/(app)/dashboard/meals/[id]/page.tsx` → `/dashboard/meals/[id]`. */
export function routeOf(file) {
  const path = file.replace(/^app\//, '').replace(/(^|\/)page\.tsx$/, '');
  const route = path.split('/').filter((s) => s && !/^\(.*\)$/.test(s)).join('/');
  return `/${route}`;
}

export function pageFiles() {
  return execFileSync('git', ['ls-files', 'app/**/page.tsx', 'app/page.tsx'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean).sort();
}

export function laneOf(file) {
  return LANES.find((lane) => lane.test(file));
}

/** Every page route, with the lane the crawl tools group it under. */
export function routes() {
  return pageFiles().map((file) => ({ route: routeOf(file), file, lane: laneOf(file).id }));
}

/** The crawl tools' view: pages grouped by lane. */
export function build() {
  const all = routes();
  return { lanes: LANES.map((lane) => ({ lane, rows: all.filter((r) => r.lane === lane.id) })).filter((l) => l.rows.length) };
}

/** The routes listed in finalaudit.md's "Every page" table, in order, repeats kept. */
export function registerRows(text = readFileSync(FINAL, 'utf8')) {
  const at = text.indexOf(TABLE_HEADING);
  if (at < 0) return null;
  const rows = [];
  let inTable = false;
  for (const line of text.slice(at).split('\n').slice(1)) {
    if (line.startsWith('|')) { inTable = true; const m = /^\| `([^`]+)` \|/.exec(line); if (m) rows.push(m[1]); continue; }
    if (inTable) break;
  }
  return rows;
}

function main() {
  const rows = registerRows();
  if (!rows) { console.error(`finalaudit.md has no "${TABLE_HEADING}" table.`); process.exit(1); }
  const missing = routes().map((r) => r.route).filter((r) => !rows.includes(r));
  const twice = rows.filter((r, i) => rows.indexOf(r) !== i);
  if (missing.length || twice.length) {
    if (missing.length) console.error(`Pages with no row in the register:\n  ${missing.join('\n  ')}`);
    if (twice.length) console.error(`Rows listed twice:\n  ${twice.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Page register complete: ${routes().length} pages, ${rows.length} rows.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
