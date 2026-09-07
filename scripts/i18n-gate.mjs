// scripts/i18n-gate.mjs — CI gate for surfaces declared translated.
//
// Runs every entry in GATED_SURFACES and fails if any of them has regained a
// hardcoded string. Translating a surface is easy to undo by accident: someone
// adds a button, types the label inline, and every non-English visitor silently
// gets English on a page that was clean yesterday. Nothing else in the build
// would notice, so this does.
//
// Adding a surface here is a promise. Only add one that scans clean.

import { GATED_SURFACES, scanPaths } from './i18n-scan.mjs';

let failed = 0;

for (const [surface, paths] of Object.entries(GATED_SURFACES)) {
  const results = scanPaths(paths);
  const total = results.reduce((n, r) => n + r.findings.length, 0);

  if (!total) {
    console.log(`  ✓ ${surface}`);
    continue;
  }

  failed += total;
  console.error(`  ✗ ${surface} — ${total} hardcoded string(s)`);
  for (const { file, findings } of results) {
    console.error(`      ${file}`);
    for (const f of findings) console.error(`        ${f.line}: ${f.text}`);
  }
}

if (failed) {
  console.error(
    `\ni18n gate failed: ${failed} string(s) on a surface that is supposed to be translated.` +
      `\nLift each into lib/i18n/messages/en-US.json, translate it in the base catalogues,` +
      `\nand render it through t(). See lib/i18n/messages/README.md.`,
  );
  process.exit(1);
}

console.log('\ni18n gate: all declared surfaces are clean.');
