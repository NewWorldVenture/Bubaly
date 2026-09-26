#!/usr/bin/env node
// scripts/audit-hand-written-currency.mjs — money whose SYMBOL is a literal.
//
// WHY THIS EXISTS, and why the locale ratchet is blind to it.
//
// tests/hardcoded-locales-only-go-down.test.ts counts `'en-US'` in a formatter
// position. It cannot see this:
//
//   `$${(cents / 100).toFixed(2)}`
//
// There is no locale in that line to find — and that is not a milder version of
// the same defect, it is a worse one. `toFixed` has NO locale at all: it always
// emits a "." decimal mark and never groups, so a German reader gets "2768.00"
// where their own convention is "2.768,00", with the symbol stuck on the American
// side. Swapping in a locale would not fix it either; the symbol is a literal, so
// the best a locale swap achieves is "$2.768,00" — the American symbol position
// with German separators, which nobody writes.
//
// `new Intl.NumberFormat(locale, { style: 'currency', currency })` is the fix: it
// puts the symbol where the locale puts it and groups the way the locale groups.
//
// WHAT IT LOOKS FOR. A currency character written as a LITERAL beside a number
// that is formatted separately — `$${x}` (the dollar doubled, so the first is
// text), `'$' + x`, or a symbol after the braces as in `${x} $`. A plain `${x}`
// is just a template placeholder and is NOT a hit.
//
// It then requires the neighbourhood to be about MONEY (a formatted number, or a
// name like cents/amount/price/budget), so a percentage or a raw count does not
// count. Exemptions are structural: the operator console under app/(app)/admin/
// and components/admin/ is en-US by the audit's own rule, and lib/ai/** plus
// app/api/ai/** build text the MODEL reads.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/** `$${x}` · `'$' + x` · `x + '$'` — the symbol is text, not a placeholder. */
const BEFORE = /`\$\$\{|['"]\$['"]\s*\+|\$\s*\+\s*['"`]/g;
/** `${x} $` — the symbol trails the number. */
const AFTER = /\}\s*(?:&nbsp;|\s)?[$€£¥]\s*[`'"]/g;
/** It has to be money, not a percentage or a raw count. */
const IS_MONEY = /toLocaleString|NumberFormat|toFixed\(2\)|cents|Cents|amount|price|Price|budget|usd|Usd|USD/;

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The operator console, and text the model reads. Both en-US by the audit's rule. */
const isExempt = (file) =>
  /^app\/\(app\)\/admin\/|^components\/admin\//.test(file) ||
  /^lib\/ai\/|^app\/api\/ai\//.test(file);

const files = () => execSync(
  "git ls-files 'app/**/*.ts' 'app/**/*.tsx' 'components/**/*.ts' 'components/**/*.tsx' 'lib/**/*.ts' 'lib/**/*.tsx'",
  { encoding: 'utf8' },
).split('\n').filter(Boolean);

export function findHandWrittenCurrency() {
  const found = [];
  for (const file of files()) {
    if (isExempt(file)) continue;
    const source = strip(readFileSync(file, 'utf8'));
    const seen = new Set();
    for (const re of [BEFORE, AFTER]) {
      for (const m of source.matchAll(re)) {
        const window = source.slice(Math.max(0, m.index - 160), m.index + 220);
        if (!IS_MONEY.test(window)) continue;
        const line = source.slice(0, m.index).split('\n').length;
        // One site per LINE: `${lo} – ${hi} $` is one label to fix.
        if (seen.has(line)) continue;
        seen.add(line);
        found.push({ file, line });
      }
    }
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = findHandWrittenCurrency();
  const byFile = new Map();
  for (const f of found) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f.line]);
  for (const [file, lines] of [...byFile].sort()) console.log(`${file}:${lines.join(',')}`);
  console.log(`\n${found.length} site(s) across ${byFile.size} file(s).`);
}
