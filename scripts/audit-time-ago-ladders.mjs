#!/usr/bin/env node
// scripts/audit-time-ago-ladders.mjs — find hand-rolled "time ago" ladders.
//
// WHY THIS EXISTS, and why the locale ratchet could not do it.
//
// tests/hardcoded-locales-only-go-down.test.ts counts `'en-US'` in a formatter
// position. It is blind to this:
//
//   if (mins < 60) return `${mins}m ago`;
//
// There is no locale in that line to find — the English is the literal. Eleven
// surfaces had grown their own ladder under five different names (`relativeTime`
// three times, `relTime`, `timeAgo`, `ago`, plus two inline in JSX) with three
// different wordings, and every one of them showed English to all eleven locales.
// The locale scan was green over all of it.
//
// Two of those ladders ended in `toLocaleDateString()` with NO argument, which
// follows the BROWSER's locale rather than the family's Bubaly choice — a third
// flavour of the same defect, and also invisible to a scan for `'en-US'`.
//
// WHAT IT LOOKS FOR. A ladder is a function that converts a millisecond gap into
// a label: it divides by 60000 (or 60_000) and returns a template string ending in
// a unit. That shape is specific enough not to fire on arithmetic and general
// enough to catch a new one written from scratch.
//
// Exemptions are STRUCTURAL, not a filename list. A site is exempt when it
// delegates to the shared helper, or when it is under app/(app)/admin — the
// platform's own operator pages, which the audit treats as en-US throughout.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MINUTE_DIVISOR = /\/\s*60_?000|\/\s*\(\s*60\s*\*\s*1000\s*\)/;
const AGO_TEMPLATE = /`\$\{[^}]*\}\s?(?:m|h|d|w|min|hr|hrs|sec|day|days|week|weeks)\b[^`]*`/;
/**
 * "2d 4h", "7h 30m" — TWO units in one label. Not the same defect, and not fixable
 * the same way: Intl.RelativeTimeFormat describes one unit in one direction, so it
 * cannot say "2d 4h" at all. These are DURATIONS (an auction's time left, a night's
 * sleep) rather than a point in the past, they read the same in most of the eleven
 * locales, and localising them needs Intl.DurationFormat or a catalogue key. Counted
 * separately so a real gap stays visible without being confused for a ladder that
 * shows a German family American words.
 */
const COMPOSITE_DURATION = /`\$\{[^}]*\}\s?[a-z]{1,3}\s+(?:\$\{|[A-Za-z]*\$\{)[^`]*`/;
const SUBMINUTE_LITERAL = /(['"`])(?:just now|now|Just now|Now)\1/;
const BARE_TO_LOCALE = /toLocale(?:Date|Time)String\(\s*(?:\)|undefined)/;

const files = execSync(
  "git ls-files 'app/**/*.ts' 'app/**/*.tsx' 'components/**/*.ts' 'components/**/*.tsx' 'lib/**/*.ts' 'lib/**/*.tsx'",
  { encoding: 'utf8' },
).split('\n').filter(Boolean);

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The operator console is en-US by the audit's own rule; see finalaudit.md §11. */
const isOperatorPage = (file) => /^app\/\(app\)\/admin\//.test(file);

export function findLadders() {
  const found = [];
  for (const file of files) {
    const source = strip(readFileSync(file, 'utf8'));
    // Walk every brace-balanced block that could be a function body, cheaply: a
    // ladder always sits within ~700 characters of its minute divisor.
    for (const m of source.matchAll(new RegExp(MINUTE_DIVISOR, 'g'))) {
      const window = source.slice(Math.max(0, m.index - 400), m.index + 700);
      const isLadder = AGO_TEMPLATE.test(window) || COMPOSITE_DURATION.test(window)
        || (SUBMINUTE_LITERAL.test(window) && /<\s*24|<\s*60/.test(window));
      if (!isLadder) continue;
      // NO "it mentions fmtTimeAgo" EXEMPTION. That was the first version and it was
      // too generous by exactly the margin that matters: a component which destructures
      // `const { fmtTimeAgo } = useFormat()` at the top has the name in scope for the
      // whole file, so a ladder written twenty lines below it was silently exempt.
      // Planting one back proved the point — the guard stayed green over it.
      //
      // Delegation needs no exemption anyway: a site that calls the shared helper has
      // no ago-template and no sub-minute literal, so `isLadder` above is already
      // false for it. The only exemption left is structural and narrow.
      if (isOperatorPage(file)) continue;
      // A private ladder that at least TAKES a locale is a different, smaller
      // problem: duplication rather than an English string shown to eleven
      // countries. Reported separately so the two are not conflated — the first
      // shows a German family American words, the second only costs a reader
      // wondering which of six "time ago"s a surface used.
      const localised = /\blocale\b|LocaleCode/.test(window);
      // The discriminator is the word, not the shape: a "time ago" label says so
      // ("ago", "just now"), a duration does not ("2d 4h", "7h 30m", "Ended").
      const saysAgo = /\bago\b/.test(window) || SUBMINUTE_LITERAL.test(window);
      const composite = COMPOSITE_DURATION.test(window) && !saysAgo;
      found.push({
        file,
        line: source.slice(0, m.index).split('\n').length,
        kind: composite ? 'composite-duration' : localised ? 'ladder-localised' : 'ladder',
      });
    }
    for (const m of source.matchAll(new RegExp(BARE_TO_LOCALE, 'g'))) {
      if (isOperatorPage(file)) continue;
      found.push({ file, line: source.slice(0, m.index).split('\n').length, kind: 'browser-locale' });
    }
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = findLadders();
  for (const f of found) console.log(`${f.file}:${f.line}  ${f.kind}`);
  const by = (k) => found.filter((f) => f.kind === k).length;
  console.log(`\n${found.length} site(s): ${by('ladder')} english-only ladder, `
    + `${by('ladder-localised')} localised-but-private ladder, `
    + `${by('composite-duration')} composite duration, ${by('browser-locale')} browser-locale.`);
}
