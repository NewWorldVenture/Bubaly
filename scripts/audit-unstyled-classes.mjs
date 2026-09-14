// scripts/audit-unstyled-classes.mjs — which class names in this app style nothing.
//
// An unknown class is not an error anywhere: CSS ignores it, Tailwind ignores it,
// the build passes, and the element simply renders without the background, border
// or spacing the author asked for. That is how `btn-primary` reached an admin Save
// button that is defined in no stylesheet, `no-scrollbar` reached thirteen tab
// strips with no rule behind it, and `bg-brand/12` reached the public pricing page
// — 12 is not on the opacity scale, so the modifier resolves to nothing while the
// neighbouring `bg-brand/10` works.
//
// The method: collect the class tokens this repository actually writes, compile
// the real stylesheet with the real config using those tokens as its content, and
// report the tokens that produced no rule. Tailwind emits exactly the utilities it
// recognises, so "produced no rule" means "no utility, and no rule in
// app/globals.css either".
//
// The hard part is not the compile, it is deciding which string literals are class
// lists. `className={kind === 'high' ? a : b}` contains the literal 'high', which
// was never a class; a regex over className reports about eighty of those. So:
//
//   1. Take every string literal in the file (TypeScript AST, not a regex).
//   2. Compile every class-SHAPED token in all of them, to learn what Tailwind
//      recognises.
//   3. Treat a literal as a class list only when at least one of its tokens is
//      recognised AND at least half of them are. Prose rarely clears that bar;
//      a class list nearly always does, because an unstyled class is the exception.
//   4. Report the unrecognised tokens inside those literals.
//
// Deliberately NOT reported: `group` and `peer` (Tailwind's marker classes, which
// correctly emit nothing and exist for `group-hover:` / `peer-checked:`), and named
// groups like `group/snooze`.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import ts from 'typescript';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

const STYLESHEET = 'app/globals.css';

/** Marker classes that are supposed to emit nothing. */
const MARKERS = new Set(['group', 'peer']);
const isMarker = (token) => MARKERS.has(token) || /^(group|peer)\//.test(token);

/** Could this be a class at all? Rejects prose punctuation and identifiers. */
const CLASS_SHAPED = /^-?[a-z][a-z0-9]*(?:[-/.][a-z0-9.%[\]()#,_-]+)*$/;

function classShaped(token) {
  if (!token || token.length > 80) return false;
  if (/[A-Z${}'"`;=<>!?]/.test(token)) return false;
  return CLASS_SHAPED.test(token);
}

/** Strip variant prefixes, leaving arbitrary values like [ai-context:home] alone. */
export function bareClass(token) {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < token.length; i += 1) {
    const c = token[i];
    if (c === '[' || c === '(') depth += 1;
    else if (c === ']' || c === ')') depth -= 1;
    else if (c === ':' && depth === 0) cut = i;
  }
  return (cut === -1 ? token : token.slice(cut + 1)).replace(/^!/, '');
}

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/** The helpers that JOIN class lists. Their arguments are classes. */
const CLASS_JOINERS = new Set(['cn', 'clsx', 'cx', 'classNames', 'twMerge', 'twJoin']);

/**
 * Whether a literal inside a className expression is being used AS a class list.
 *
 * Three things inside a className are not classes, and each one produced false
 * positives before it was excluded:
 *
 *   - the operand of a comparison — `className={kind === 'high' ? busy : calm}`;
 *   - the index of a lookup — `className={TONE['high']}`;
 *   - an argument to a function that COMPUTES a class rather than joining one:
 *     `placeBgFor(p?.icon ?? 'other')`, `kindMeta('bug').tone`, and
 *     `cfg.color.split(' ')[1].replace('text', 'bg')` — where 'text' and 'bg'
 *     are the search and replacement, not utilities.
 *
 * `cn()` and its siblings are the exception: joining is exactly what they do, so
 * their arguments are class lists. Everything else inside a className — a ternary
 * branch, an array element, a template chunk, a key or value in clsx's object
 * form — is a class list.
 */
function usedAsClassList(literal, root) {
  for (let node = literal; node && node !== root; node = node.parent) {
    const parent = node.parent;
    if (!parent) break;
    if (ts.isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) return false;
    if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return false;
    if (ts.isCaseClause(parent)) return false;
    if (ts.isCallExpression(parent) && parent.arguments.includes(node)) {
      const callee = parent.expression;
      const name = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text
          : '';
      if (!CLASS_JOINERS.has(name)) return false;
    }
  }
  return true;
}

/**
 * Every string literal in one source file, with its line number and whether it
 * sits in a `className`.
 *
 * The className flag is what makes a literal whose tokens are ALL unstyled
 * visible. `className="h-4.5 w-4.5"` and `className="btn-secondary"` have no
 * recognised token at all, so the "at least one known class" heuristic — the only
 * thing that can judge a class map declared at module scope — skips them
 * silently. A guard that cannot see the worst case is not a guard; position
 * settles those, and the heuristic only has to cover the maps.
 */
function stringLiterals(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const at = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const inClassName = new Set();
  const markClassName = (root) => {
    const walk = (node) => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node))
        && usedAsClassList(node, root)) {
        inClassName.add(node);
      }
      ts.forEachChild(node, walk);
    };
    walk(root);
  };
  const findAttributes = (node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'className' && node.initializer) {
      markClassName(node.initializer);
    }
    ts.forEachChild(node, findAttributes);
  };
  findAttributes(source);

  const walk = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found.push({ text: node.text, line: at(node), className: inClassName.has(node) });
    } else if (ts.isTemplateExpression(node)) {
      // Each literal chunk around an ${…} is its own fragment: the interpolation
      // itself is not ours to judge.
      found.push({ text: node.head.text, line: at(node), className: inClassName.has(node.head) });
      for (const span of node.templateSpans) {
        found.push({ text: span.literal.text, line: at(span.literal), className: inClassName.has(span.literal) });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

const tokensOf = (text) => text.split(/\s+/).filter(Boolean).map(bareClass).filter(classShaped);

/**
 * A class name inside a compiled selector.
 *
 * Tailwind escapes an arbitrary value's punctuation, and a COMMA becomes the CSS
 * hex escape `\2c ` — with a trailing space, which is part of the escape and not
 * a selector separator. Reading the name with `[\w-]` therefore truncated at the
 * comma, and every `grid-cols-[minmax(0,1fr)_300px]` in the app looked like a
 * class that styles nothing. Twenty-odd false positives came from that one space.
 */
const CLASS_IN_SELECTOR = /\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[A-Za-z0-9_-])+)/g;

/** Undo CSS escaping: hex escapes first, then the simple backslash form. */
function unescapeSelector(name) {
  return name
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\(.)/g, '$1');
}

/** Compile the stylesheet against `tokens` and return the class names it emits. */
async function emittedFor(tokens, configOverride) {
  const config = configOverride ?? (await import(`${process.cwd()}/tailwind.config.ts`)).default;
  const raw = [...tokens].map((token) => `<i class="${token}">`).join('\n');
  const result = await postcss([
    tailwindcss({ ...config, content: [{ raw, extension: 'html' }] }),
  ]).process(readFileSync(STYLESHEET, 'utf8'), { from: STYLESHEET });
  const emitted = new Set();
  result.root.walkRules((rule) => {
    for (const match of rule.selector.matchAll(CLASS_IN_SELECTOR)) emitted.add(unescapeSelector(match[1]));
  });
  return emitted;
}

export function sourceFiles() {
  return execSync("git ls-files 'app/**/*.tsx' 'app/**/*.ts' 'components/**/*.tsx' 'components/**/*.ts' 'lib/**/*.tsx'", { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/**
 * Every class token this app writes that compiles to no rule.
 * Returns [{ token, file, line }], sorted, plus the totals behind it.
 */
export async function auditUnstyledClasses(files = sourceFiles()) {
  const literals = files.flatMap((file) => stringLiterals(file).map((l) => ({ ...l, file })));

  // Step 2: what does Tailwind recognise, out of everything class-shaped we write?
  const everyToken = new Set(literals.flatMap((l) => tokensOf(l.text)));
  const recognised = await emittedFor(everyToken);

  // Step 3 + 4: only literals that read as class lists, and only their strangers.
  const offenders = new Map();
  let classLists = 0;
  for (const literal of literals) {
    const tokens = literal.text.split(/\s+/).filter(Boolean);
    const shaped = tokens.map(bareClass).filter(classShaped);
    if (shaped.length === 0) continue;
    // Two conditions, and both are needed.
    //
    // (a) At least one token is a class Tailwind or the stylesheet knows. Prose
    //     almost never clears this, because prose words are not utilities.
    // (b) At least half the tokens LOOK like utilities — recognised, or carrying
    //     the `-` / `/` / `[` a utility nearly always has. Requiring a high
    //     RECOGNISED fraction instead hid real offenders: the literal
    //     "animate-in fade-in slide-in-from-bottom-2 duration-300" has one
    //     recognised token in four (the plugin those three come from is not
    //     installed), and that is exactly the case worth reporting.
    // A literal inside a `className` IS a class list — no guessing needed, and no
    // blind spot when every one of its tokens is unstyled.
    if (!literal.className) {
      // Outside a className, all there is to go on is what the tokens look like:
      // class maps sit at module scope (`{ thriving: 'bg-emerald-500/10 …' }`) and
      // are reached through an index.
      //
      // (a) At least one token is a class Tailwind or the stylesheet knows. Prose
      //     almost never clears this, and discriminant strings ('high', 'pending',
      //     'model_call') never do — which is the whole reason this condition is
      //     here and why `className` position has to carry the rest.
      // (b) At least half the tokens LOOK like utilities — recognised, or carrying
      //     the `-` / `/` / `[` a utility nearly always has.
      const known = shaped.filter((t) => recognised.has(t) || isMarker(t));
      if (known.length === 0) continue;
      const utilityLike = shaped.filter((t) => recognised.has(t) || isMarker(t) || /[-/[]/.test(t));
      if (utilityLike.length / tokens.length < 0.5) continue;
    }
    classLists += 1;
    for (const token of shaped) {
      if (recognised.has(token) || isMarker(token) || offenders.has(token)) continue;
      offenders.set(token, { token, file: literal.file, line: literal.line });
    }
  }
  return {
    offenders: [...offenders.values()].sort((a, b) => a.token.localeCompare(b.token)),
    tokensSeen: everyToken.size,
    recognised: recognised.size,
    classLists,
    files: files.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const audit = await auditUnstyledClasses();
  console.log(`${audit.files} files · ${audit.classLists} class lists · ${audit.tokensSeen} tokens seen · ${audit.recognised} recognised`);
  console.log(`${audit.offenders.length} class name(s) style nothing:`);
  for (const o of audit.offenders) console.log(`  ${o.token}  —  ${o.file}:${o.line}`);
  process.exit(audit.offenders.length ? 1 : 0);
}
