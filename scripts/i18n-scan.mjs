// scripts/i18n-scan.mjs — find user-facing English still hardcoded in the UI.
//
// Two jobs, one scanner:
//   1. During the migration, `--list <glob>` prints the real strings in a file
//      or surface so they can be lifted into the catalogue accurately, rather
//      than retyped from memory and subtly changed.
//   2. Afterwards, `--surface <name>` gates a surface in CI: once a surface is
//      declared translated it must stay translated, so a new hardcoded string
//      fails the build instead of silently shipping English to every locale.
//
// Deliberately conservative. It reports only strings that look like prose a
// person reads — two or more words, or one capitalised word of four-plus
// letters — and skips the many string-shaped things in a React codebase that
// are not copy: class names, keys, ids, URLs, icon names, enum values. A
// scanner that cries wolf gets muted, which is worse than one that misses a
// little.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

/** Surfaces that are expected to be fully translated. CI fails on new findings
 *  here. Add a surface only once it is actually clean — a false green is worse
 *  than an honest gap. */
export const GATED_SURFACES = {
  // The language control itself.
  'i18n-ui': ['components/i18n'],
  // The authenticated app chrome — top bar, account menu, sidebar, mobile nav.
  // Every signed-in page renders this, so a regression here is visible on all
  // of them at once.
  'app-shell': ['components/app/app-shell.tsx'],
  // The public marketing header, on every unauthenticated page.
  'marketing-header': ['components/marketing/site-header.tsx'],
  // The public marketing site: every page under (marketing) and every component
  // it renders. This is the whole signed-out experience — home, pricing,
  // features, the four legal documents, the FAQ, the blog chrome and the footer.
  'marketing-pages': ['app/(marketing)'],
  'marketing-components': ['components/marketing'],
};

// NOT gated: `everything` — ['app', 'components'].
//
// It used to be, on the strength of a zero from a scanner that could not see
// copy in a data structure, could not see a JSX prop outside a fixed allowlist,
// and skipped every directory named `mobile`. Widening it turned that zero into
// 2,343 real strings, so the promise the gate was making had never been true;
// it just had no way to notice. It goes back in the list when it scans clean and
// not before, because a surface that is gated while dirty teaches everyone to
// ignore the gate.

// Build output and VCS metadata nest anywhere, so these are skipped at any
// depth.
const IGNORE_ANYWHERE = new Set([
  'node_modules', '.next', '.git', 'out', 'dist', 'coverage',
  'test-results', 'playwright-report',
]);

// Sibling PROJECTS at the repo root: the Expo app and the native shells, which
// have their own copy and their own translation story.
//
// Matched by path from the root, NOT by name. Matching the bare name skipped
// every directory called `mobile` at any depth — including
// `app/(marketing)/mobile`, the public Mobile App page, whose eight hardcoded
// English strings were therefore invisible to the gate. The surface said clean
// while a visitor could read English on the page, which is the exact failure
// this scanner exists to prevent.
const IGNORE_AT_ROOT = new Set(['ios', 'android', 'mobile']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_ANYWHERE.has(entry)) continue;
    const full = join(dir, entry);
    if (IGNORE_AT_ROOT.has(entry) && relative(ROOT, full) === entry) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// Strings that are structurally not copy, however word-like they look.
const NOT_COPY = [
  /^https?:\/\//i,
  /^\//,                        // paths
  /^[a-z0-9-]+$/,               // slugs, ids, css tokens
  /^[A-Z0-9_]+$/,               // SCREAMING enums
  /^\d/,                        // starts with a digit
  /^[^a-zA-Z]*$/,               // no letters at all
  /^&[a-z]+;$/i,                // bare entities
  // Source code that happens to sit between a `>` and a `<`. Widening the text
  // pattern to span newlines pulled in fragments like `); return locked ? (`;
  // prose does not contain these, so excluding them costs no real findings.
  /[;{}]/,
  /=>/,
  /\b(?:return|const|let|var|function|import|export|typeof|null|undefined)\b/,
  // Bracket punctuation at either end means we sliced through an expression,
  // not a sentence: `) : isActive ? (` sits between a `>` and a `<` exactly the
  // way copy does. Prose in this product never starts or ends on a bracket.
  /^\s*[)\]}]/,
  /[([{]\s*$/,
  /\)\s*$/,
  // The leaks that survived all of the above, each one seen in this repo. They
  // are grouped by the signal rather than by the file, because the file changes
  // and the signal does not: prose in this product never contains a logical
  // operator, a strict comparison, a snake_case identifier, a line comment or a
  // method call, and never OPENS on `:`, `=` or `,` — those are all fragments of
  // an expression that happened to sit between a `>` and a `<`.
  /&&|\|\|/,                    // `todayStr && i.due_date`
  /===|!==/,                    // `( items.length === 0 ?`
  // snake_case. Every rule in this block was measured the only way that proves
  // anything: replayed against all 7,449 English strings already in the
  // catalogue, which are copy by construction. Between them they exclude
  // exactly TWO pieces of real copy — the hint
  // "plays, at, coached_by, needs, affects…", which lists relationship kinds by
  // their column names, and the admin label "UTM source(s), comma-sep", whose
  // "(s)," reads as a closing paren followed by an argument. Both are already
  // translated, so the cost is that the scanner would not notice them
  // regressing. That is the whole price; it is written down rather than implied.
  /[a-z][A-Za-z0-9]*_[a-z]/,    // `ai_handle_first`
  // A line comment ANYWHERE in the match, not just at its start: the `>` the
  // scanner sliced from is often several tokens earlier, so the fragment reads
  // `( // eslint-disable-next-line @next/next/no-img-element`.
  /\/\//,
  /\b[A-Za-z_$][\w$]*:\s*(?:string|number|boolean|unknown|any|void|never|Promise)/,
  /^\s*,\s*[A-Za-z_$][\w$]*:\s*$/,  // `, blocked:` — an object literal, sliced
  /\.[A-Za-z_$][\w$]*\(/,       // `sb.from('marketplace_offers')`
  // Bare TYPE names, by name. `Promise` reads as one capitalised word of
  // four-plus letters, which is exactly the shape of a real one-word label, so
  // nothing structural can tell them apart. The list is deliberately the two
  // that have actually leaked and not every global: `Record` and `Number` are
  // both real copy in this product ("Record payment", a form field called
  // "Number"), and excluding them cost more than they were worth.
  /^Promise(?:Like)?$/,
  // A TypeScript assertion, by the type it asserts. Bare `as X` is not usable —
  // "Download statement as CSV" and "Print / Save as PDF" are both real copy —
  // so this lists the types that only ever appear in code.
  /\bas\s+(?:Record|Array|Partial|Readonly|Promise|unknown|any|const)\b/,
  // A tone map keys its Tailwind classes by name, and `error:` is one of those
  // names: `error: 'text-rose-300 bg-rose-500/10 border-rose-500/30'` is a
  // class list, not a sentence. Two or more Tailwind-shaped tokens say so.
  /(?:^|\s)(?:text|bg|border|ring|from|to|via|hover|focus)[-:][\w[\]/.-]+(?:\s|$).*(?:^|\s)(?:text|bg|border|ring|from|to|via|hover|focus)[-:]/,
  // A class list in general, not only the tone maps: EVERY token is
  // utility-shaped (a hyphen, a slash, or a variant colon, and no capitals or
  // sentence punctuation). Written as "all tokens" rather than "contains a
  // utility" so a real sentence with a hyphenated word — "Offline-friendly",
  // "Real-time sync" — is untouched. Needed once copy is recognised by the
  // VALUE rather than by an allowlist of property names, because `tint`,
  // `iconBg`, `ring` and `cls` all hold class strings.
  /^(?:[a-z0-9]+[-:/][\w[\]()/.,%#-]*)(?:\s+[a-z0-9[]+[-:/][\w[\]()/.,%#-]*)+$/,
  /^\s*:\s.*\?\s*$/,           // `: error ?` — the middle of a ternary
  /\s\?\s*$/,                   // `on ?` — the head of one. English copy does
                                //   not put a space before its question mark;
                                //   French does, but only translations do, and
                                //   this scanner reads English source.
  /^\s*=\s/,                    // `= TIER_RANK[it.tier] ?`
  /\?\?/,                       // `(assignments ?? []).map`
  /`/,                          // a template literal is code, not a sentence
  /\[\]|\)\s*:/,               // `, fields: FieldDef[]): Record`
  /\b[a-z][\w$]{2,}\([\w$]{2,}/,  // `generate(tab as Exclude` — a call, not a phrase
  /\)\s*[,)\]]/,                // `isProviderConfigured(p)]), )`
];

// Props whose value is COPY. This list is the scanner's biggest blind spot when
// it is short: `<ErrorState message="Could not load support tickets." />` sat in
// two admin pages through the whole migration because `message` was not on it,
// and the count said zero while a person could read English on the screen. If a
// component takes a string a person reads, its prop name belongs here.
//
// Recognised the same way as data literals below: by the VALUE, with the
// properties that are never copy named in NOT_COPY_PROPS. An allowlist was
// tried first and each gap had to be found by reading English off a shipped
// page — `message`, then `eyebrow`, then `priceSub`.
const NOT_COPY_PROPS = new Set([
  'className', 'href', 'id', 'key', 'icon', 'type', 'slug', 'path', 'url', 'color',
  'tone', 'variant', 'table', 'column', 'event', 'role', 'status', 'kind', 'provider',
  'locale', 'tz', 'src', 'format', 'pattern', 'value', 'field', 'op', 'method', 'mode',
  'align', 'size', 'position', 'target', 'rel', 'as', 'bucket', 'scope', 'from', 'to',
  'env', 'model', 'sort', 'order', 'dir', 'ext', 'mime', 'tag', 'group', 'domain',
  'host', 'port', 'prefix', 'suffix', 'sep', 'delimiter',
  // SVG and image geometry. `d` holds a path — "M18.244 2.25h3.308l…" reads as
  // two words of prose to any rule that does not know the attribute — and
  // `sizes` holds a media-query list, "(min-width: 1024px) 800px, 100vw".
  'd', 'sizes', 'viewBox', 'points', 'transform', 'fill', 'stroke', 'preserveAspectRatio',
  // Class-string holders. The value rule above catches most, but these carry a
  // single utility often enough to be worth naming.
  'tint', 'bg', 'ring', 'iconBg', 'cls', 'chip', 'badgeClass', 'wrap', 'hover', 'active',
  // An AI system prompt is instructions to a model, not text a person reads.
  'prompt', 'system', 'instruction', 'instructions',
  // Plan/tier identifiers. They index badge and rank maps and are typed as
  // string-literal unions, so a key here does not compile; the visible label
  // is a separate lookup (see HI_TIER_LABEL in pricing-content.tsx).
  'tier', 'plan', 'level',
]);

const PROP_PATTERN = /\b([A-Za-z_$][\w$-]*)="([^"{}]{3,})"/g;

/**
 * Copy sitting in a DATA structure rather than in the markup:
 *
 *   const GROUPS = [{ title: 'Product', links: [{ label: 'Features' }] }];
 *
 * The scanner saw none of this. `{l.label}` renders it, so it is copy by every
 * measure that matters, but it is neither a JSX text node nor a JSX attribute —
 * and a nav, a footer, a settings list or a feature grid is almost always
 * written this way. The whole site footer shipped untranslated behind this gap,
 * on every marketing page, while the surface reported clean.
 *
 * Recognised by the VALUE, with a list of properties that are never copy. An
 * allowlist of property names was tried first and lost: `eyebrow`, `desc`,
 * `when`, `what` and `meta` each had to be discovered by finding untranslated
 * text on a shipped page, which is the failure this scanner exists to prevent.
 * A denylist is wrong in the other direction — it over-reports — and that is
 * the direction to be wrong in.
 */

const DATA_PATTERN = /(?:^|[\s,{[])([A-Za-z_$][\w$]*)\s*:\s*'([^'\\\n]{3,})'/gm;

/**
 * Copy in an ARRAY under a copy-carrying property:
 *
 *   { heading: 'Managing cookies', body: ['You can control cookies through…'] }
 *
 * The legal pages — cookies, privacy, terms, acceptable use — are written this
 * way, so their entire policy text was invisible: the scanner saw the headings
 * (a `prop: 'value'`) and none of the paragraphs under them. Nested arrays are
 * included, since a `body` mixes paragraphs with bullet lists.
 *
 * The span is bounded by the matching bracket rather than a lazy `[^\]]*`, so a
 * body containing an apostrophe or a nested list still reads to its real end.
 */
const ARRAY_PROP_PATTERN = /\b([A-Za-z_$][\w$]*)\s*:\s*\[/g;
const STRING_IN_ARRAY = /'((?:[^'\\\n]|\\.){3,})'/g;

function arrayFindings(source) {
  const out = [];
  for (const m of source.matchAll(ARRAY_PROP_PATTERN)) {
    if (NOT_COPY_PROPS.has(m[1])) continue;
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i += 1) {
      const c = source[i];
      if (c === '[') depth += 1;
      else if (c === ']') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    const span = source.slice(open, end);
    for (const s of span.matchAll(STRING_IN_ARRAY)) out.push([s[1], open + (s.index ?? 0)]);
  }
  return out;
}
// Copy passed as a CALL ARGUMENT, which the two patterns above cannot see: the
// string is in expression position, not in a tag or an attribute. This is the
// third and last blind spot the migration found, and the loudest of its kind —
// `toastError('Failed to save appointment')` is a sentence a person reads, and
// the scanner reported the file clean 335 times over.
//
// Only functions whose argument is UNCONDITIONALLY user-facing are listed. A
// generic `t(`, `push(` or `set(` would drag in identifiers, table names and
// sort keys, and a scanner that cries wolf gets its findings ignored.
/**
 * A server action's failure message. These reach the user unchanged — the
 * client does `toastError(res.error)` at 149 sites — so an English literal here
 * is English on the screen no matter what language the family chose.
 *
 * They translate on the SERVER, inside the action, where `getTranslations()` is
 * available: that keeps the wire format a finished sentence and leaves all 149
 * call sites alone. `describeActionError(err, '…')`'s second argument is the
 * fallback text shown when the database error has no friendlier form, so it is
 * the same kind of string and matched too.
 */
const ACTION_ERROR_PATTERN =
  /(?:\berror:\s*|describeActionError\([^,()]+,\s*)'([^'\\\n]{4,})'/g;

/**
 * A prose argument to a helper that puts it in front of a user.
 *
 * Every name here was read before it was listed — `actionFailure` returns the
 * string as `{ error }` and 149 call sites toast it, `databaseUnavailable`
 * makes it a 503 body, `twimlSay` has a phone read it aloud, `readWarnings`
 * collects it into a `role="status"` region. This is a LIST rather than a
 * shape, because "a string passed to a function" also describes a table name,
 * a sort key and a log tag.
 *
 * Any argument position, because these helpers disagree about where the copy
 * goes: `actionFailure(err, 'Could not …')` in four files and
 * `actionFailure('close the account', t('…'), err)` in eighteen.
 */
const HELPER_PATTERN = new RegExp(
  String.raw`\b(?:actionFailure|describeActionError|describeDbError|databaseUnavailable`
  + String.raw`|buildFailure|twimlSay|setError|onError)\(([^)]{0,200}?)`
  // The opening quote must NOT be an escaped one, and the body may contain
  // escapes. Without both, `twimlSay('I\'m sorry, we\'re not able to take…')`
  // matched the fragment BETWEEN the two escaped apostrophes, and the lift
  // replaced that span — leaving an unterminated string literal in two route
  // handlers. tsc caught it, but only after the tool reported success.
  // A CAPITAL first letter. These helpers take both a user-facing message and a
  // developer-facing log tag, and the tags are lowercase verb phrases —
  // `actionFailure('close the account', t('…'), err)`. Without this the lift
  // translated 105 log tags, which would have printed server logs in whichever
  // language the visitor happened to be reading.
  + String.raw`(?<!\\)'([A-Z](?:[^'\\\n]|\\.){5,180})'`,
  'g');

// Fixed names: a browser dialog says exactly what it is called.
const DIALOG_PATTERN = /\b(?:window\.confirm|confirm|alert|prompt)\(\s*'([^'\\\n]{3,})'/g;

/**
 * The toast API is destructured, so its local names vary by file:
 *
 *   const { success, error: toastError } = useToast();
 *
 * A fixed list would have to guess. `toastError` covers 331 sites and `success`
 * 256, but `success(` and `error(` are ordinary enough words that matching them
 * everywhere would report identifiers in files that have no toast at all. So
 * the names are READ from the destructuring in each file, and matched only
 * there — no guessing, and no false positives from a same-named helper next
 * door.
 */
function toastPattern(source) {
  const names = new Set();
  for (const m of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*useToast\(\)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.includes(':') ? part.split(':')[1] : part;
      const clean = name.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(clean)) names.add(clean);
    }
  }
  if (!names.size) return null;
  return new RegExp(`\\b(?:${[...names].join('|')})\\(\\s*'([^'\\\\\\n]{3,})'`, 'g');
}
// A JSX text node: between > and <, no braces (those are expressions, not copy).
//
// Newlines are ALLOWED inside the match on purpose. Copy that trails an inline
// element — `<Icon /> New family` followed by a newline and the closing tag — is
// extremely common in this codebase, and excluding \n here silently skipped
// every one of them, which made the scanner report clean files that were not.
// Whitespace is normalised below so multi-line prose reads as one string.
const TEXT_PATTERN = />([^<>{}]{3,})</g;

/**
 * Strings the repo has DECLARED identical in every language — brand names,
 * proper nouns, demo-data placeholders — read from the file that already
 * carries that decision. Without this the scanner reports "Bubaly" nine times
 * on the marketing pages and asks for it to be translated, which is exactly
 * what lib/i18n/messages/INVARIANT.txt exists to say it must not be.
 */
const INVARIANT = (() => {
  try {
    return new Set(
      readFileSync(join(ROOT, 'lib/i18n/messages/INVARIANT.txt'), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#')),
    );
  } catch {
    return new Set();
  }
})();

export function looksLikeCopy(raw) {
  const s = raw.trim();
  if (INVARIANT.has(s)) return false;
  if (s.length < 3) return false;
  if (NOT_COPY.some((re) => re.test(s))) return false;
  if (!/[a-zA-Z]/.test(s)) return false;
  // Two or more words, or one substantial capitalised word.
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return /[a-z]/.test(s);
  return /^[A-Z][a-z]{3,}$/.test(s);
}

/** Findings for one file. */
/**
 * Blank out comments, keeping every byte in place so line numbers still hold.
 *
 * A comment is not copy, and the scanner sliced through several as if it were:
 * `( // eslint-disable-next-line @next/next/no-img-element` and
 * `(no JS/hydration), shown only` are both fragments of a note to a reader of
 * the source. Excluding them shape by shape was a losing game — a comment can
 * say anything, including a whole English sentence — so they are removed before
 * anything is matched at all.
 *
 * `https://` is not a comment. The `:` before it is the whole difference.
 */
export function withoutComments(source) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, lead) => lead + blank(m.slice(lead.length)));
}

export function scanFile(file) {
  const source = withoutComments(readFileSync(file, 'utf8'));
  const findings = [];
  const seen = new Set();

  const push = (value, index) => {
    // Collapse the indentation JSX leaves around a text node so `\n   New
    // family\n` and ` New family ` are recognised as the same string, and undo
    // the source's own string escapes: `'another family\\'s data'` is the JS
    // spelling of an apostrophe, not a backslash a reader should see. Reporting
    // the escaped form put a literal `family\\'s` into 29 catalogue values, which
    // is what every locale would then have rendered.
    const text = value.replace(/\\(['"\\])/g, '$1').replace(/\s+/g, ' ').trim();
    if (!looksLikeCopy(text)) return;
    const key = `${text}@${index}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ text, line: source.slice(0, index).split('\n').length });
  };

  // A JSX text node can only exist in a .tsx file. Running the rule over .ts
  // read `<em>${topicLabel}</em> — wrote:</p>` inside an HTML email template as
  // page copy — and that email goes to the operator, not to the visitor.
  if (file.endsWith('.tsx')) for (const m of source.matchAll(TEXT_PATTERN)) push(m[1], m.index ?? 0);
  for (const m of source.matchAll(PROP_PATTERN)) {
    // `data-*` is machine state and `aria-hidden`/`aria-live` are enum values;
    // `aria-label` is the one ARIA attribute that carries a sentence.
    if (m[1].startsWith('data-')) continue;
    if (m[1].startsWith('aria-') && m[1] !== 'aria-label') continue;
    if (!NOT_COPY_PROPS.has(m[1])) push(m[2], m.index ?? 0);
  }
  for (const m of source.matchAll(DATA_PATTERN)) {
    if (!NOT_COPY_PROPS.has(m[1])) push(m[2], m.index ?? 0);
  }
  for (const [text, at] of arrayFindings(source)) push(text, at);
  for (const m of source.matchAll(DIALOG_PATTERN)) push(m[1], m.index ?? 0);
  for (const m of source.matchAll(ACTION_ERROR_PATTERN)) push(m[1], m.index ?? 0);
  for (const m of source.matchAll(HELPER_PATTERN)) push(m[2], m.index ?? 0);
  const toasts = toastPattern(source);
  if (toasts) for (const m of source.matchAll(toasts)) push(m[1], m.index ?? 0);

  return findings;
}

function filesUnder(paths) {
  const files = [];
  for (const p of paths) {
    const full = join(ROOT, p);
    try {
      const st = statSync(full);
      if (st.isDirectory()) walk(full, files);
      else if (/\.tsx?$/.test(full)) files.push(full);
    } catch {
      // A gated surface pointing at a path that no longer exists is a real
      // problem — say so rather than passing vacuously.
      console.error(`i18n-scan: path not found: ${p}`);
      process.exitCode = 1;
    }
  }
  return files;
}

export function scanPaths(paths) {
  const results = [];
  for (const file of filesUnder(paths)) {
    const findings = scanFile(file);
    if (findings.length) results.push({ file: relative(ROOT, file).split(sep).join('/'), findings });
  }
  return results;
}

// ---- CLI ------------------------------------------------------------------
const isMain = process.argv[1] && process.argv[1].endsWith('i18n-scan.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  const listAt = args.indexOf('--list');
  const surfaceAt = args.indexOf('--surface');

  if (listAt !== -1) {
    const paths = args.slice(listAt + 1).filter((a) => !a.startsWith('--'));
    const results = scanPaths(paths);
    let total = 0;
    for (const { file, findings } of results) {
      console.log(`\n${file}`);
      for (const f of findings) {
        console.log(`  ${String(f.line).padStart(4)}  ${f.text}`);
        total++;
      }
    }
    console.log(`\n${total} hardcoded string(s) across ${results.length} file(s)`);
  } else if (surfaceAt !== -1) {
    const name = args[surfaceAt + 1];
    const paths = GATED_SURFACES[name];
    if (!paths) {
      console.error(`Unknown surface "${name}". Known: ${Object.keys(GATED_SURFACES).join(', ')}`);
      process.exit(1);
    }
    const results = scanPaths(paths);
    const total = results.reduce((n, r) => n + r.findings.length, 0);
    if (total) {
      console.error(`\n${name}: ${total} hardcoded string(s) — this surface is gated as translated.\n`);
      for (const { file, findings } of results) {
        console.error(`  ${file}`);
        for (const f of findings) console.error(`    ${f.line}: ${f.text}`);
      }
      process.exit(1);
    }
    console.log(`${name}: clean`);
  } else {
    console.log('usage: node scripts/i18n-scan.mjs --list <paths...> | --surface <name>');
    process.exit(1);
  }
}
