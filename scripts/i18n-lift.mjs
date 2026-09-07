// scripts/i18n-lift.mjs — move hardcoded English out of one file and into the
// catalogue, mechanically.
//
// WHY THIS EXISTS. `i18n-scan.mjs` found 1,050 hardcoded strings across 333
// files: copy that never reaches `lib/i18n/messages`, so no translator can see
// it and no coverage number counts it. That is why a French visitor saw a
// translated nav above an English page body. Retyping a thousand strings by
// hand into keys is how a migration introduces typos into six languages at
// once, so this does the mechanical half and leaves the judgement to a person.
//
// WHAT IT DOES
//   node scripts/i18n-lift.mjs <file> [--apply]
//
// Runs the scanner over one file, proposes a catalogue key per string, and
// prints the replacement it would make. With --apply it rewrites the file and
// adds the English to en-US.json. Without it, nothing is written — read the
// plan first.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   * It does not put `t` in scope. Whether a file needs `await
//     getTranslations()` (server) or `useTranslations()` (client) is a real
//     decision about the component, and guessing it wrong turns a page into a
//     runtime error. Wire that by hand, then run this.
//   * It does not translate. `i18n-apply.mjs` does that, from a reviewed patch.
//   * It refuses a string it cannot place unambiguously — one that appears both
//     inside quotes and as JSX text in the same file — rather than picking.
//
// KNOWN LIMIT, and `tsc` is the guard for it: the tool knows about module-level
// data arrays but not about OTHER functions in the file. A string inside
// `generateMetadata()` gets rewritten to `t(key)` even though the component's
// `t` is not in that scope. That fails to compile immediately and loudly, which
// is the acceptable failure mode — but it means you run `tsc` after every lift,
// and give `generateMetadata` its own `await getTranslations()` when it has copy
// in it.
//   * Inside a MODULE-LEVEL data array it writes the bare key, never `t(key)`:
//     `t` does not exist at module scope, so emitting a call there would not
//     compile. Those arrays end up holding keys, and the component that renders
//     them has to resolve each one — the tool lists them so that wiring is a
//     task rather than a surprise.
import { readFileSync, writeFileSync } from 'node:fs';
import { scanPaths } from './i18n-scan.mjs';

const file = process.argv[2];
const apply = process.argv.includes('--apply');
if (!file) {
  console.error('usage: node scripts/i18n-lift.mjs <file> [--apply]');
  process.exit(1);
}

/**
 * `components/marketing/site-footer.tsx` → `siteFooter`
 * `app/(marketing)/security/page.tsx`    → `security`
 *
 * A route file is always called `page`, `layout` or `route`, so its own name
 * says nothing. The directory does — and a namespace of `page` shared by fifty
 * routes would collide every key in the catalogue.
 */
const ANONYMOUS = new Set(['page', 'layout', 'route', 'template', 'index', 'default']);
function namespaceFor(path) {
  const parts = path.replace(/\.tsx?$/, '').split('/');
  let name = parts.pop();
  while (ANONYMOUS.has(name) && parts.length) {
    const parent = parts.pop();
    // Route groups — `(marketing)` — and dynamic segments name nothing either.
    if (!/^[([]/.test(parent)) name = parent;
  }
  return name.replace(/[-_](.)/g, (_, c) => c.toUpperCase()).replace(/^(.)/, (_, c) => c.toLowerCase());
}

/** "Privacy by Design" → "privacyByDesign"; long strings keep their first words. */
function slugFor(text) {
  const words = text
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  if (!words.length) return 'text';
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
}

const src = readFileSync(file, 'utf8');

/**
 * Character ranges covered by a top-level `const NAME = [ … ];` or
 * `= { … };`. A string inside one of these is evaluated when the module loads,
 * long before any request has a locale, so it can only hold a key.
 */
function moduleScopeRanges(text) {
  const ranges = [];
  const re = /^(?:export\s+)?const\s+[A-Za-z0-9_]+(?::[^=]+)?\s*=\s*[[{]/gm;
  let m;
  while ((m = re.exec(text))) {
    const open = text[m.index + m[0].length - 1];
    const close = open === '[' ? ']' : '}';
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i += 1) {
      if (text[i] === open) depth += 1;
      else if (text[i] === close) depth -= 1;
    }
    ranges.push([m.index, i]);
  }
  return ranges;
}
const MODULE_SCOPE = moduleScopeRanges(src);
const atModuleScope = (idx) => MODULE_SCOPE.some(([a, b]) => idx >= a && idx < b);
const [result] = scanPaths([file]);
if (!result) {
  console.log('nothing to lift');
  process.exit(0);
}

/**
 * The name this file already calls its translator, if it has one.
 *
 * Not every file uses `t`. `trip-travel.tsx` was translated earlier under `tr`
 * — and it also binds `t` as the transport row in a `.map()`. Emitting `t(...)`
 * there produced a second translator that the map parameter then shadowed, and
 * the error surfaced as "This expression is not callable" some fifty lines
 * away from the cause. Reusing whatever the file already calls it avoids both
 * the duplicate and the shadow.
 */
function translatorName(text) {
  const m = /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+getTranslations\(\)|useTranslations\(\))/.exec(text);
  return m ? m[1] : 't';
}
const T = translatorName(src);

const ns = namespaceFor(file);
const seen = new Map();
const plan = [];

for (const { text } of result.findings) {
  if (seen.has(text)) continue;
  // Prefer the quoted form: a string literal in a data array is the common case
  // and the replacement is `t('key')` with no braces.
  const single = `'${text.replace(/'/g, "\\'")}'`;
  const singlePlain = `'${text}'`;
  const double = `"${text}"`;
  let form = null;
  for (const q of [singlePlain, single, double]) {
    const at = src.indexOf(q);
    if (at === -1) continue;
    // A JSX ATTRIBUTE needs braces — `title={t(key)}` — while the same quoted
    // string inside an object or array literal must not have them. Telling them
    // apart is the difference between a working page and a syntax error, so it
    // is decided by what precedes the quote, not guessed: `name=` immediately
    // before it means an attribute.
    form = { from: q, kind: /[A-Za-z0-9_$]+=$/.test(src.slice(Math.max(0, at - 40), at)) ? 'attr' : 'expr' };
    break;
  }
  // `>text<` is only JSX TEXT if it reads like prose. The same shape occurs
  // inside a TypeScript generic — `async <T,>(label: string, q: PromiseLike<…`
  // — where rewriting it produces a syntax error rather than a translation.
  // Punctuation that belongs to code and not to a sentence rules it out.
  const looksLikeCode = /[{}|;=<>]|=>|:\s*[A-Za-z]/.test(text);
  // `>text<` is a JSX text node only if that `>` really closes a tag. In
  // `(fn: () => Promise<{ ok: boolean }>)` the `>` belongs to an ARROW, and the
  // scanner reports `Promise` as prose — so the naive check rewrote a type
  // annotation into JSX. A closing tag's `>` is never preceded by `=`.
  const literal = `>${text}<`;
  const litAt = src.indexOf(literal);
  if (!form && !looksLikeCode && litAt > 0 && src[litAt - 1] !== '=' && src[litAt - 1] !== '-') {
    form = { from: literal, kind: 'jsxText' };
  }

  // JSX prose is usually WRAPPED, so the sentence the scanner reports on one
  // line sits across several in the source with arbitrary indentation. Matching
  // it needs every run of whitespace to be flexible; matching it literally is
  // why this tool used to leave the longest, most visible copy on the page
  // behind and lift only the short labels around it.
  // The wrapped-prose path is deliberately narrow: it may only fire for text
  // that unmistakably reads as a SENTENCE. A looser rule matched a lint
  // directive (`eslint-disable-next-line @next/next/no-img-element`) and a set
  // of object keys, and rewrote both into JSX — because the scanner reports
  // those as prose and a whitespace-flexible pattern is happy to span them.
  const readsAsSentence = /^[A-Z]/.test(text)
    && text.split(/\s+/).length >= 3
    && !/[_@\\/]|--|\bnext\b/.test(text);
  if (!form && !looksLikeCode && readsAsSentence) {
    // The whitespace around the sentence is CAPTURED rather than swallowed. In
    // JSX a run of whitespace that contains a newline is stripped by the
    // compiler, but a plain space is a rendered word gap — and `The magic is in
    // the <GradientText>AI</GradientText>` loses its only space if the match
    // eats it, so the heading renders "The magic is in theAI".
    const loose = new RegExp(
      `>([^\\S\\n]*\\s*)${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(\\s*)<`,
    );
    if (loose.test(src)) form = { from: loose, kind: 'jsxText' };
  }
  if (!form) continue; // nothing that can be placed safely — leave it.

  let key = `${ns}.${slugFor(text)}`;
  let n = 2;
  while ([...seen.values()].includes(key)) key = `${ns}.${slugFor(text)}${n++}`;
  seen.set(text, key);
  const at = form.from instanceof RegExp ? src.search(form.from) : src.indexOf(form.from);
  plan.push({ text, key, ...form, moduleScope: atModuleScope(at) });
}

let out = src;
for (const p of plan) {
  if (p.from instanceof RegExp) {
    // Re-emit a `{' '}` for whatever significant whitespace the match consumed:
    // significant means "a space with no newline in it", which is exactly the
    // whitespace JSX would have rendered.
    const gap = (ws) => (ws && !ws.includes('\n') ? "{' '}" : '');
    out = out.replace(p.from, (_m, lead, trail) => `>${gap(lead)}{${T}('${p.key}')}${gap(trail)}<`);
    continue;
  }
  const to = p.moduleScope
    ? `'${p.key}'`
    : p.kind === 'attr'
      ? `{${T}('${p.key}')}`
      : p.kind === 'jsxText'
        ? `>{${T}('${p.key}')}<`
        : `${T}('${p.key}')`;
  out = out.split(p.from).join(to);
}

console.log(`${file}: ${plan.length} of ${result.findings.length} finding(s) liftable`);
for (const p of plan) {
  console.log(`  ${p.moduleScope ? 'KEY ' : '    '}${p.key.padEnd(52)} ${JSON.stringify(p.text).slice(0, 80)}`);
}
const needsWiring = plan.filter((p) => p.moduleScope);
if (needsWiring.length) {
  console.log(
    `\n${needsWiring.length} of these are in a module-level data array and now hold a KEY.` +
      `\nWhatever renders them must call t() on it — otherwise the page shows the key.`,
  );
}

if (!apply) {
  console.log('\n(dry run — pass --apply to write)');
  process.exit(0);
}

writeFileSync(file, out);
const CAT = 'lib/i18n/messages/en-US.json';
const cat = JSON.parse(readFileSync(CAT, 'utf8'));
for (const p of plan) cat[p.key] = p.text;
const sorted = Object.fromEntries(Object.keys(cat).sort().map((k) => [k, cat[k]]));
writeFileSync(CAT, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`\napplied — ${plan.length} key(s) added to en-US.json`);
