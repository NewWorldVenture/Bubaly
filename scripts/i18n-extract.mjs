// scripts/i18n-extract.mjs — lift hardcoded copy into the catalogue and rewrite
// the source to render it through t(), using the TypeScript AST.
//
// WHY THE AST, NOT A REGEX
// -----------------------
// The first version of this script matched `>text<` with a regular expression.
// That is fine for REPORTING (a human reads the list and judges), and it is what
// scripts/i18n-scan.mjs still does. It is catastrophic for REWRITING, because
// JavaScript is full of `>` and `<` that are not JSX delimiters. On its first
// real file it turned
//
//     active.filter((i) => i.due_date && i.due_date < todayStr)
//
// into
//
//     active.filter((i) => {t('todos.iDueDateIDueDate')} < todayStr)
//
// by matching from the `>` of the arrow to the `<` of the comparison, and it
// destroyed a ternary the same way. Both changes typecheck-adjacent enough to be
// missed on a quick skim and would have corrupted logic across hundreds of files.
//
// The parser knows what a JsxText node actually is. This version only ever
// rewrites nodes the TypeScript parser has classified as JSX text or as a string
// literal in a known JSX attribute, and applies edits back-to-front so earlier
// offsets stay valid.
//
// It still translates NOTHING: it adds English to en-US.json and the other
// catalogues inherit it until a translator fills them in.

import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { createRequire } from 'node:module';

const ts = createRequire(import.meta.url)('typescript');

const CATALOGUE = 'lib/i18n/messages/en-US.json';
const HOOK_IMPORT = "import { useTranslations } from '@/components/i18n/locale-provider';";

/** JSX attributes whose string value is copy a person reads. */
const COPY_PROPS = new Set(['placeholder', 'aria-label', 'title', 'alt', 'label']);

/** A stable, readable key derived from the text, so the same string in two files
 *  shares one key and one translation. */
export function keyFor(namespace, text) {
  const camel = text
    .replace(/['’]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
  return `${namespace}.${camel || 'text'}`;
}

/** Is this JSX text actual copy? The parser guarantees it is text rather than
 *  code, so this only has to reject whitespace, punctuation and bare symbols. */
function isCopy(text) {
  const s = text.trim();
  if (s.length < 3 || s.length > 120) return false;
  if (!/[a-zA-Z]/.test(s)) return false;
  if (/^[A-Z0-9_]+$/.test(s)) return false;          // SCREAMING enums
  if (/^[a-z0-9-]+$/.test(s)) return false;          // slugs
  if (/^https?:\/\//i.test(s) || s.startsWith('/')) return false;
  // A quote or backtick would need escaping inside t('…'); skip rather than
  // risk changing the string's meaning.
  if (/["'`]/.test(s)) return false;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return /[a-z]/.test(s);
  return /^[A-Z][a-z]{3,}$/.test(s);
}

/** The nearest enclosing function-like node, so the hook lands in the right
 *  component rather than at the top of the file. */
function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Every identifier the file already BINDS — parameters, variables, imports,
 * function names.
 *
 * 44 of the 115 module files bind `t` themselves (`items.map((t) => …)` is
 * common), and blindly inserting `const t = useTranslations()` shadowed those
 * and produced "This expression is not callable" wherever the original `t` was
 * used. The binding name has to be chosen per file, before any replacement text
 * is generated.
 */
function boundNames(sf) {
  const names = new Set();
  const visit = (node) => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isBindingElement(node) ||
        ts.isImportSpecifier(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return names;
}

/** The first binding name this file has free. */
function pickBinding(sf) {
  const taken = boundNames(sf);
  return ['t', 'tr', 'i18nT', 'translateMessage'].find((n) => !taken.has(n)) ?? 'i18nTranslate';
}

/** Collect every rewritable site in a file. */
export function collect(file, namespace) {
  const source = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const binding = pickBinding(sf);
  const edits = [];

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const raw = node.getText();
      const text = raw.replace(/\s+/g, ' ').trim();
      if (isCopy(text)) {
        // Preserve the original leading/trailing whitespace so JSX spacing
        // between adjacent elements is unchanged.
        const lead = raw.match(/^\s*/)?.[0] ?? '';
        const tail = raw.match(/\s*$/)?.[0] ?? '';
        edits.push({
          start: node.getStart(sf),
          end: node.getEnd(),
          text,
          key: keyFor(namespace, text),
          replacement: (key) => `${lead}{${binding}('${key}')}${tail}`,
          fn: enclosingFunction(node),
        });
      }
    } else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const name = node.name.getText(sf);
      const text = node.initializer.text;
      if (COPY_PROPS.has(name) && isCopy(text)) {
        edits.push({
          start: node.initializer.getStart(sf),
          end: node.initializer.getEnd(),
          text,
          key: keyFor(namespace, text),
          replacement: (key) => `{${binding}('${key}')}`,
          fn: enclosingFunction(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  return { source, sf, edits, binding };
}

export function rewriteFile(file, namespace) {
  const { source, edits, binding } = collect(file, namespace);
  if (!edits.length) return null;
  if (!source.startsWith("'use client'")) {
    return { skipped: 'server component — needs await getTranslations()', count: edits.length };
  }

  let out = source;
  const keys = {};

  // Back to front, so each edit's offsets are still valid when it is applied.
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.replacement(edit.key) + out.slice(edit.end);
    keys[edit.key] = edit.text;
  }

  // Hooks are inserted by re-parsing the REWRITTEN source rather than by
  // reusing offsets from the original: the text edits above moved everything,
  // and a stale offset is how a tool like this corrupts a file.
  out = insertHooks(out, file, binding);

  // Test for the IMPORT, not the identifier: insertHooks has just written
  // `const t = useTranslations()` into the body, so an identifier check always
  // matches and the import silently never gets added.
  if (!out.includes("from '@/components/i18n/locale-provider'")) {
    const end = afterLastImport(out, file);
    out = `${out.slice(0, end)}\n${HOOK_IMPORT}${out.slice(end)}`;
  }

  return { out, keys, count: edits.length, binding };
}

/**
 * The name a function-like node is declared under, if any. An arrow function
 * assigned to a const carries its name on the variable, not the arrow.
 */
function declaredName(node, sf) {
  if (ts.isFunctionDeclaration(node)) return node.name?.getText(sf);
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    node.parent &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.getText(sf);
  }
  return undefined;
}

/**
 * Is this node a React component — something a hook may legally live in?
 *
 * The first version asked only "does this function body call t()", which put
 * `useTranslations()` inside `.map()` callbacks and render-prop arrows and
 * tripped react-hooks/rules-of-hooks in 30+ files. A capitalised declared name
 * is the rule React itself uses, so it is the rule here: an anonymous callback
 * is never a component, and a `t()` inside one resolves to the enclosing
 * component's binding anyway.
 */
function isComponent(node, sf) {
  const name = declaredName(node, sf);
  return !!name && /^[A-Z]/.test(name);
}

/** Insert `const t = useTranslations();` into each COMPONENT that calls t() and
 *  does not already declare it. Operates on the rewritten source via a fresh
 *  parse, so offsets are real rather than estimated. */
function insertHooks(source, file, binding) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const inserts = [];

  const visit = (node) => {
    const isFn =
      ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
    if (isFn && node.body && ts.isBlock(node.body) && isComponent(node, sf)) {
      const body = node.body.getText(sf);
      const calls = new RegExp(`\\b${binding}\\(['"]`).test(body);
      const declares = new RegExp(`const\\s+${binding}\\s*=\\s*useTranslations\\(\\)`).test(body);
      if (calls && !declares) {
        inserts.push({ pos: node.body.getStart(sf) + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  let out = source;
  for (const { pos } of inserts.sort((a, b) => b.pos - a.pos)) {
    out = `${out.slice(0, pos)}\n  const ${binding} = useTranslations();${out.slice(pos)}`;
  }
  return out;
}

/** Byte offset just past the last import statement, from the AST rather than a
 *  text search. `lastIndexOf('\nimport ')` plus the next newline lands INSIDE a
 *  multi-line import and produced a syntax error in every file that had one. */
function afterLastImport(source, file) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let end = 0;
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) end = statement.getEnd();
  }
  return end;
}

// ---- CLI ------------------------------------------------------------------
const isMain = process.argv[1] && process.argv[1].endsWith('i18n-extract.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const nsAt = args.indexOf('--ns');
  const explicitNs = nsAt === -1 ? undefined : args[nsAt + 1];
  const files = args.filter((a, i) => !a.startsWith('--') && i !== nsAt + 1);

  // Without --ns, the namespace comes from the file: components/modules/
  // billing-module.tsx → `billing`. Keeps keys grouped by the surface they came
  // from, which is what makes the catalogue reviewable by a translator.
  const namespaceFor = (file) =>
    explicitNs ??
    (file.split('/').pop() ?? 'ui')
      .replace(/\.tsx$/, '')
      .replace(/-(module|panel|hub|page|form|card|view)$/, '')
      .replace(/[^A-Za-z0-9]+(.)/g, (_m, c) => c.toUpperCase());

  if (!files.length) {
    console.log('usage: node scripts/i18n-extract.mjs --ns <namespace> [--check] <files...>');
    process.exit(1);
  }

  const catalogue = JSON.parse(readFileSync(CATALOGUE, 'utf8'));
  let added = 0;
  let rewritten = 0;

  for (const file of files) {
    let result;
    try {
      result = rewriteFile(file, namespaceFor(file));
    } catch (err) {
      console.error(`fail  ${relative(process.cwd(), file)} — ${err.message}`);
      process.exitCode = 1;
      continue;
    }
    if (!result) continue;
    if (result.skipped) {
      console.log(`skip  ${relative(process.cwd(), file)} — ${result.skipped} (${result.count})`);
      continue;
    }

    for (const [key, text] of Object.entries(result.keys)) {
      if (catalogue[key] && catalogue[key] !== text) {
        console.log(`  !! collision ${key}: "${catalogue[key]}" vs "${text}" — left alone`);
        continue;
      }
      if (!catalogue[key]) added++;
      catalogue[key] = text;
    }

    if (!check) writeFileSync(file, result.out);
    rewritten++;
    console.log(`${check ? 'plan ' : 'wrote'} ${relative(process.cwd(), file)} — ${result.count} string(s)`);
  }

  if (!check) {
    const sorted = Object.fromEntries(Object.entries(catalogue).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(CATALOGUE, `${JSON.stringify(sorted, null, 2)}\n`);
  }
  console.log(`\n${rewritten} file(s), ${added} new key(s)${check ? ' (dry run)' : ''}`);
}
