#!/usr/bin/env node
// Runs axe (the WCAG 2 A/AA tags tests/e2e/accessibility.spec.ts uses) on every
// path in a list, signed in with a Playwright storage state, and records the
// violations and the number of <h1> on each page as one JSON line. It only
// reads; the "page audit" pass B14 in finalaudit.md is this script over every
// signed-in route as a parent, a /kid-login child and a super administrator.
//
//   node scripts/axe-audit.mjs --base http://127.0.0.1:3107 --paths paths.txt \
//     --out /tmp/axe.jsonl [--storage state.json] [--concurrency 4] [--width 1280]
//
// PAGE_AUDIT_CHROMIUM points at a Chromium binary when Playwright's own is not
// installed, as for scripts/page-audit.mjs.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((out, a, i, all) => (a.startsWith('--') ? [...out, [a.slice(2), all[i + 1]]] : out), []),
);
const base = (args.base ?? 'http://127.0.0.1:3107').replace(/\/$/, '');
if (!args.paths || !args.out) {
  console.error('usage: axe-audit.mjs --paths paths.txt --out out.jsonl [--base URL] [--storage state.json]');
  process.exit(2);
}
const paths = readFileSync(args.paths, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const browser = await chromium.launch({ executablePath: process.env.PAGE_AUDIT_CHROMIUM || undefined });
const context = await browser.newContext({
  storageState: args.storage || undefined,
  viewport: { width: Number(args.width ?? 1280), height: 900 },
});
writeFileSync(args.out, '');

let next = 0;
async function worker() {
  while (next < paths.length) {
    const path = paths[next++];
    const page = await context.newPage();
    const row = { path };
    try {
      const res = await page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      row.status = res?.status();
      // A plan gate or a role redirect can arrive after the first byte, as a
      // client navigation; read the page once it has settled.
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(500);
      row.finalPath = new URL(page.url()).pathname;
      row.h1 = await page.locator('h1').count();
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      row.violations = result.violations.map((v) => ({
        id: v.id, impact: v.impact, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
      }));
    } catch (error) {
      row.error = String(error).slice(0, 200);
    }
    appendFileSync(args.out, JSON.stringify(row) + '\n');
    await page.close();
  }
}
await Promise.all(Array.from({ length: Number(args.concurrency ?? 4) }, worker));
await browser.close();
