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
import { scanPaths, withoutComments } from './i18n-scan.mjs';

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
/**
 * What to call the translator in THIS file.
 *
 * Reuse the name the file already has, so the lift does not add a second
 * handle. Otherwise `t` — unless `t` is already bound to something else:
 * `components/ui/toast.tsx` maps over its toasts as `t`, so `aria-label={t(…)}`
 * there became "Type 'Toast' has no call signatures", reported fifty lines from
 * the cause. A name that is taken is not a name.
 */
function translatorName(text) {
  const existing = /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+getTranslations\(\)|useTranslations\(\))/.exec(text);
  if (existing) return existing[1];

  const isTaken = (name) => new RegExp(
    // a parameter — `(t)`, `(t,`, `, t)` — or an arrow's bare parameter, or a
    // declaration. Any of the three means the identifier already means
    // something in some scope of this file.
    `\\(\\s*${name}\\s*[,)]|[(,]\\s*${name}\\s*[,)]|\\b${name}\\s*=>|\\b(?:const|let|var|function)\\s+${name}\\b`,
  ).test(text);
  return ['t', 'tr', 'tx', 'translate_'].find((name) => !isTaken(name)) ?? 'tx';
}
const T = translatorName(src);

// Positions are found in a COMMENT-BLANKED copy, never in the raw source. Two
// bugs came from not doing that, both from one file:
//
//   // would render "No open tasks — nicely done." (family thinks chores are done)
//   …
//   <MiniEmpty icon={CheckSquare} text="No open tasks — nicely done." />
//
// `indexOf` found the COMMENT first, so the form was read from the words before
// it ("would render ") and came out as an expression rather than an attribute —
// and then `split().join()` rewrote the comment too, producing `text=tr(…)`
// with no braces and a file that would not parse.
//
// The mask keeps every byte in place, so an offset into it is an offset into
// the real source. Edits are then applied BY POSITION, back to front, which
// also means two occurrences of the same sentence each get the form that suits
// where they actually sit.
const masked = withoutComments(src);

/** Every index at which `needle` occurs. */
function occurrences(hay, needle) {
  const out = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

const ns = namespaceFor(file);
const seen = new Map();
const edits = [];      // { start, end, to }
const placed = [];     // one row per key, for the report

for (const { text } of result.findings) {
  if (seen.has(text)) continue;

  let key = `${ns}.${slugFor(text)}`;
  let n = 2;
  while ([...seen.values()].includes(key)) key = `${ns}.${slugFor(text)}${n++}`;

  const mine = [];
  const note = (start, end, to, kind) => mine.push({ start, end, to, kind });

  // Prefer the quoted form: a string literal in a data array is the common case
  // and the replacement is `t('key')` with no braces.
  const quoted = [...new Set([`'${text}'`, `'${text.replace(/'/g, "\\'")}'`, `"${text}"`])];
  for (const q of quoted) {
    for (const at of occurrences(masked, q)) {
      // A JSX ATTRIBUTE needs braces — `title={t(key)}` — while the same quoted
      // string inside an object or array literal must not have them. Telling
      // them apart is the difference between a working page and a syntax error,
      // so it is decided by what precedes the quote, not guessed: `name=`
      // immediately before it means an attribute.
      const isAttr = /[A-Za-z0-9_$]+=$/.test(masked.slice(Math.max(0, at - 40), at));
      // A literal in TYPE position is not copy — it is part of the type. Two
      // shipped files were rewritten to `type HiTier = 'Free' | t('key') | …`
      // and `type DeviceName = 'iPhone' | t('key') | …`, neither of which
      // parses. A union member is recognised by the `|` beside it, and a
      // `type X =` declaration by its keyword; a matching object KEY (the same
      // string followed by `:`) must stay put too, or the map it indexes stops
      // resolving.
      const before = masked.slice(Math.max(0, at - 120), at);
      const after = masked.slice(at + q.length, at + q.length + 40);
      const inUnion = /\|\s*$/.test(before) || /^\s*\|/.test(after);
      const inTypeDecl = /\btype\s+[A-Za-z0-9_$]+(?:<[^>]*>)?\s*=[^;\n]*$/.test(before);
      const isObjectKey = /^\s*:/.test(after);
      if (inUnion || inTypeDecl || isObjectKey) continue;
      // A module-level data array holds the BARE KEY: `t` is not in scope there,
      // and whatever renders the row calls it.
      const to = atModuleScope(at) ? `'${key}'` : isAttr ? `{${T}('${key}')}` : `${T}('${key}')`;
      note(at, at + q.length, to, atModuleScope(at) ? 'KEY' : isAttr ? 'attr' : 'expr');
    }
  }

  // `>text<` is only JSX TEXT if it reads like prose. The same shape occurs
  // inside a TypeScript generic — `async <T,>(label: string, q: PromiseLike<…`
  // — where rewriting it produces a syntax error rather than a translation.
  // `:\s*[A-Za-z]` used to stand in for "a type annotation" and swallowed real
  // prose with a colon in it — "Make it your family's for real: pick a plan to
  // keep going" was skipped on that basis. A type annotation is a colon followed
  // by a PRIMITIVE, or by a capitalised name that is then subscripted or
  // generic; a sentence's colon is followed by an ordinary word.
  const TYPE_AFTER_COLON = /:\s*(?:string|number|boolean|unknown|any|void|never|Promise|React\b|[A-Z]\w*(?:\[\]|<|\s*\|))/;
  const looksLikeCode = /[{}|;=<>]|=>/.test(text) || TYPE_AFTER_COLON.test(text);

  // `>text<` is a JSX text node only if that `>` really closes a tag. In
  // `(fn: () => Promise<{ ok: boolean }>)` the `>` belongs to an ARROW, and the
  // scanner reports `Promise` as prose. A closing tag's `>` is never preceded
  // by `=` or `-`.
  if (!mine.length && !looksLikeCode) {
    const literal = `>${text}<`;
    for (const at of occurrences(masked, literal)) {
      if (at === 0 || masked[at - 1] === '=' || masked[at - 1] === '-') continue;
      note(at, at + literal.length, `>{${T}('${key}')}<`, 'jsxText');
    }
  }

  // JSX prose is usually WRAPPED, so the sentence the scanner reports on one
  // line sits across several in the source with arbitrary indentation. Matching
  // it needs every run of whitespace to be flexible; matching it literally is
  // why this tool used to leave the longest, most visible copy on the page
  // behind and lift only the short labels around it.
  //
  // The rule for what may go through here is "reads like words, not like code".
  // It was once far narrower — capitalised, three words or more — as a reaction
  // to a lint directive and a set of object keys it had mangled, and both of
  // those causes are gone: the scanner strips comments before it matches
  // anything, and excludes snake_case.
  const readsAsCopy = /^[A-Za-z]/.test(text) && !/[_@\\]|--/.test(text);
  if (!mine.length && !looksLikeCode && readsAsCopy) {
    // `(?<![=-])` is the arrow-versus-tag guard again: `({ on }) =>\n  on ? <Check`
    // has an `on ?` between a `>` and a `<` exactly the way a label beside an
    // icon does, and rewriting it produced a file that would not parse.
    const loose = new RegExp(
      `(?<![=-])>([^\\S\\n]*\\s*)${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(\\s*)<`,
      'g',
    );
    for (const m of masked.matchAll(loose)) {
      // Re-emit a `{' '}` for whatever significant whitespace the match ate:
      // significant means "a space with no newline in it", which is exactly the
      // whitespace JSX would have rendered. `The magic is in the
      // <GradientText>AI</GradientText>` loses its only space otherwise.
      const gap = (ws) => (ws && !ws.includes('\n') ? "{' '}" : '');
      note(m.index, m.index + m[0].length, `>${gap(m[1])}{${T}('${key}')}${gap(m[2])}<`, 'jsxText');
    }
  }

  if (!mine.length) continue; // nothing that can be placed safely — leave it.
  seen.set(text, key);
  edits.push(...mine);
  placed.push({ text, key, kind: mine[0].kind, moduleScope: mine.some((e) => e.kind === 'KEY') });
}

// Back to front, so every earlier offset stays valid.
let out = src;
for (const e of [...edits].sort((a, b) => b.start - a.start)) {
  out = out.slice(0, e.start) + e.to + out.slice(e.end);
}

const plan = placed;
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
