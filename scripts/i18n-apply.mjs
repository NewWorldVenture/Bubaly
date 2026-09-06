// scripts/i18n-apply.mjs — merge a translation patch into the base catalogues.
//
// Reads a JSON file shaped as
//
//   { "<key>": { "de": "…", "es": "…", "fr": "…", "it": "…", "nl": "…", "pt": "…" }, … }
//
// and writes each language into its catalogue. Validates as it goes, because a
// translation file is the one place in this codebase where a typo produces no
// error anywhere — it just quietly ships the wrong words to a whole country:
//
//   * every key must exist in en-US (no orphans a reviewer would have to chase);
//   * every language listed must be one we ship;
//   * a value identical to the English is REPORTED, not silently accepted —
//     sometimes correct ("Blog", "FAQ"), usually a missed translation;
//   * placeholders ({name}, {count}) must survive, since a dropped one renders
//     a literal brace at a user.

import { readFileSync, writeFileSync } from 'node:fs';

const DIR = 'lib/i18n/messages';
const LANGS = { de: 'de-DE', es: 'es-ES', fr: 'fr-FR', it: 'it-IT', nl: 'nl-NL', pt: 'pt-PT' };

const patchPath = process.argv[2];
if (!patchPath) {
  console.error('usage: node scripts/i18n-apply.mjs <patch.json>');
  process.exit(1);
}

const rawPatch = JSON.parse(readFileSync(patchPath, 'utf8'));
const source = JSON.parse(readFileSync(`${DIR}/en-US.json`, 'utf8'));

// --by-text: the patch is keyed by the ENGLISH STRING rather than by catalogue
// key, and is fanned out to every key holding that string.
//
// This is the efficient shape and also the correct one. "Cancel" appears under
// 125 different keys; authoring it 125 times invites 125 chances to translate it
// differently, and a product where the same button reads "Cancelar" on one
// screen and "Anular" on the next looks broken in a way no test catches.
const byText = process.argv.includes('--by-text');

const patch = {};
if (byText) {
  const keysFor = new Map();
  for (const [key, english] of Object.entries(source)) {
    if (!keysFor.has(english)) keysFor.set(english, []);
    keysFor.get(english).push(key);
  }
  for (const [english, values] of Object.entries(rawPatch)) {
    const keys = keysFor.get(english);
    if (!keys) {
      console.error(`no catalogue key holds: ${JSON.stringify(english)}`);
      process.exit(1);
    }
    for (const key of keys) patch[key] = values;
  }
} else {
  Object.assign(patch, rawPatch);
}

const catalogues = Object.fromEntries(
  Object.entries(LANGS).map(([lang, file]) => [
    lang,
    JSON.parse(readFileSync(`${DIR}/${file}.json`, 'utf8')),
  ]),
);

const problems = [];
const identical = [];
let written = 0;

const placeholders = (s) => (s.match(/\{(\w+)\}/g) ?? []).sort().join(',');

for (const [key, values] of Object.entries(patch)) {
  if (!(key in source)) {
    problems.push(`unknown key (not in en-US): ${key}`);
    continue;
  }
  const english = source[key];

  for (const [lang, value] of Object.entries(values)) {
    if (!(lang in LANGS)) {
      problems.push(`unknown language "${lang}" on ${key}`);
      continue;
    }
    if (typeof value !== 'string' || !value.trim()) {
      problems.push(`empty translation: ${key} [${lang}]`);
      continue;
    }
    if (placeholders(value) !== placeholders(english)) {
      problems.push(`placeholder mismatch: ${key} [${lang}] — "${english}" vs "${value}"`);
      continue;
    }
    if (value === english) identical.push(`${key} [${lang}]`);

    catalogues[lang][key] = value;
    written++;
  }
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s) — nothing written:\n`);
  for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
  process.exit(1);
}

for (const [lang, file] of Object.entries(LANGS)) {
  const sorted = Object.fromEntries(
    Object.entries(catalogues[lang]).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(`${DIR}/${file}.json`, `${JSON.stringify(sorted, null, 2)}\n`);
}

console.log(`applied ${written} translation(s) across ${Object.keys(LANGS).length} languages`);
if (identical.length) {
  console.log(`\n${identical.length} value(s) identical to English (check these are deliberate):`);
  for (const i of identical.slice(0, 20)) console.log(`  ${i}`);
}

// Coverage report, so progress is measured rather than estimated.
const total = Object.keys(source).length;
console.log('\ncoverage:');
for (const [lang, file] of Object.entries(LANGS)) {
  const done = Object.keys(catalogues[lang]).filter((k) => k in source).length;
  const pct = ((done / total) * 100).toFixed(1);
  console.log(`  ${file}  ${String(done).padStart(5)} / ${total}  ${pct}%`);
}
