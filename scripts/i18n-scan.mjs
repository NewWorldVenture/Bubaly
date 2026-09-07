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
  // EVERYTHING. This surface only became addable once the count reached zero,
  // which it now has: every string a person reads in `app/` and `components/`
  // is a catalogue key. The three surfaces above are kept rather than folded
  // into this one because they name WHY those files were gated first, and
  // because a failure that says "app-shell" is more useful than one that says
  // "everything".
  everything: ['app', 'components'],
};

const IGNORE_DIRS = new Set([
  'node_modules', '.next', '.git', 'out', 'dist', 'coverage',
  'test-results', 'playwright-report', 'ios', 'android', 'mobile',
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry)) out.push(full);
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
const PROP_PATTERN =
  /\b(?:placeholder|aria-label|title|alt|label|emptyLabel|confirmLabel|cancelLabel|message|description|text|heading|subheading|subtitle|hint|helper|helperText|tooltip|caption|summary|note|badge|ctaLabel|actionLabel|submitLabel|okLabel|emptyText|errorText|legend)="([^"{}]{3,})"/g;
// Copy passed as a CALL ARGUMENT, which the two patterns above cannot see: the
// string is in expression position, not in a tag or an attribute. This is the
// third and last blind spot the migration found, and the loudest of its kind —
// `toastError('Failed to save appointment')` is a sentence a person reads, and
// the scanner reported the file clean 335 times over.
//
// Only functions whose argument is UNCONDITIONALLY user-facing are listed. A
// generic `t(`, `push(` or `set(` would drag in identifiers, table names and
// sort keys, and a scanner that cries wolf gets its findings ignored.
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

function looksLikeCopy(raw) {
  const s = raw.trim();
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
    // family\n` and ` New family ` are recognised as the same string.
    const text = value.replace(/\s+/g, ' ').trim();
    if (!looksLikeCopy(text)) return;
    const key = `${text}@${index}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ text, line: source.slice(0, index).split('\n').length });
  };

  for (const m of source.matchAll(TEXT_PATTERN)) push(m[1], m.index ?? 0);
  for (const m of source.matchAll(PROP_PATTERN)) push(m[1], m.index ?? 0);
  for (const m of source.matchAll(DIALOG_PATTERN)) push(m[1], m.index ?? 0);
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
      else if (/\.tsx$/.test(full)) files.push(full);
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
