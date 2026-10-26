import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { FIRED_TRIGGERS } from '@/lib/marketing/automation-triggers';
import { SCHEDULED_TRIGGERS } from '@/lib/marketing/automation-runner';

// admin-writers R2-AW-FIRED-TRIGGERS-GUARD. Whether a workflow can be switched
// on, and what its card says, is decided on FIRED_TRIGGERS
// (lib/marketing/automation-triggers.ts): the triggers something fires. The
// list is kept by hand. Round 2 found three app events missing from the list
// the decision was made on (onboarding_completed, onboarding_abandoned,
// demo_abandoned): a paused onboarding welcome could not be switched back on,
// and its card said nothing in it runs while it emailed every family. This
// reads every call of fireAutomationEvent in the repository's sources (readAs
// says which), under whatever name a file takes it by from another, and holds
// the trigger each one passes to the list, so a newly fired trigger cannot
// drift out of it again; and holds the list to the callers, so a trigger
// nothing fires (demo_started) cannot drift in.
//
// It fails closed. Rounds 4 to 6 each closed some forms of reaching the
// function and the next review found others, because each check named the
// forms it followed and let everything else through. Now every reference to
// the function, to the module that defines it and to a module that exports
// it under any name is either followed to a call whose trigger `check` reads,
// or reported: each check below that does not follow a use ends in `report`
// (in analyse), and none of them returns past it unsaid. Only what sits in a
// type is passed over, since a type runs nothing (inTypePosition); a class's
// `extends` and an instantiation expression (`f<T>`), which TypeScript counts
// as types, hold values and are read as any other expression.
//
// What it still cannot see, exactly. A path written as text that names a
// module carrying the function is reported wherever it is written, so each
// corner is a path computed at runtime:
// - tests/, which it does not read (readAs).
// - Outside the app (OUTSIDE_THE_APP), in a source no app source names: a
//   module loaded by a path computed at runtime, by any loader. Those scripts
//   load packages and configs that way on purpose.
// - In the app, a module loaded by a path computed at runtime through a loader
//   this guard does not know as one: a package that loads modules (jiti, say),
//   or a builtin loader reached through a value rather than by its name
//   (`globalThis[pick()]`, `Reflect.get(globalThis, 'ev' + 'al')`,
//   `(() => {}).constructor`). A loader named as written (loaderUse), an
//   import of a builtin that loads code (LOADER_MODULES), import() and
//   require() are reported for a computed path.

const ROOT = join(__dirname, '..');

/**
 * Sources outside the app, each with why. They are read for the function and
 * the modules that carry it like any other, but their imports are not held
 * to the app's: an unresolved or computed path there is tooling's own
 * business. A source in one that an app source names is the app
 * (programCalls): playwright.config.ts imports scripts/e2e-server-env.mjs.
 */
const OUTSIDE_THE_APP: ReadonlyMap<string, string> = new Map([
  ['scripts/', 'operator and CI scripts, which node runs on their own and which load packages and configs by computed paths'],
  ['mobile/scripts/', "the Expo app's patch and check scripts, which do the same"],
  ['docs/', 'audit records, and the probes behind their evidence'],
]);

/**
 * How this guard reads a path: as the app, as a source outside it, or not at
 * all. R6-AW-GUARD-UNREAD-SOURCES-AND-REQUIRE: it read only .ts and .tsx
 * under app/, lib/ and components/, so a module the app imports from
 * shared/, from a file at the top or from a .js, .mjs or .cjs source was
 * never read, and a name it exported the function under was missed. Every
 * source a module can be is now read, whatever root it sits in (a new root,
 * hooks/ say, is the app the day it appears), but what is installed or
 * generated (node_modules anywhere; a dot-directory at the top: .next,
 * .github, .claude), a type declaration (nothing in it runs) and tests/: the
 * test suite mocks the function and calls it on purpose, and none of it is
 * the app. A dot-folder further down is read: app/.well-known is a route.
 */
function readAs(path: string): 'app' | 'outside' | null {
  const parts = path.split('/');
  if (parts.includes('node_modules') || parts[0].startsWith('.') || (parts.length > 1 && parts[0] === 'tests')) return null;
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path) || /\.d\.[cm]?ts$/.test(path)) return null;
  return [...OUTSIDE_THE_APP.keys()].some((root) => path.startsWith(root)) ? 'outside' : 'app';
}

/** Every file under a folder, as a path from the root, but what is installed, and what is hidden at the top. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || (dir === ROOT && entry.startsWith('.'))) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(relative(ROOT, path).split(sep).join('/'));
  }
  return out;
}

/** The repository's sources, as this guard reads them. */
const sources: ReadonlyMap<string, string> = new Map(walk(ROOT).filter((file) => readAs(file) !== null).map((file) => [file, readFileSync(join(ROOT, file), 'utf8')]));

type Trigger = { literal: string } | { computed: string } | { unreadable: string } | { unfollowed: string } | { unresolved: string } | { loader: string };
type Call = { file: string; line: number; trigger: Trigger };

function parse(file: string, source: string): ts.SourceFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.jsx') ? ts.ScriptKind.JSX
    : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

function unwrap(expression: ts.Expression): ts.Expression {
  let e = expression;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}

/** The trigger a call's params pass: a literal, the expression it is computed from, or neither. */
function triggerOf(params: ts.Expression | undefined, ast: ts.SourceFile): Trigger {
  if (!params) return { unreadable: '(no params)' };
  const object = unwrap(params);
  if (!ts.isObjectLiteralExpression(object)) return { unreadable: params.getText(ast) };
  for (const property of object.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'trigger') return { computed: 'trigger' };
    if (!ts.isPropertyAssignment(property)) continue;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
    if (name !== 'trigger') continue;
    const value = unwrap(property.initializer);
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return { literal: value.text };
    return { computed: value.getText(ast) };
  }
  // A spread, or no trigger named at all: nothing here says which it is.
  return { unreadable: params.getText(ast) };
}

const FIRE = 'fireAutomationEvent';
/**
 * The module that defines it. R6-AW-GUARD-DEFINER-NAMESPACE: its own
 * `export async function` is a declaration, not a name it exports the
 * function under, so a namespace of it (`import * as ev`, a dynamic import)
 * was never tracked, and `ev[pick()](...)` or `register(ev)` passed with
 * nothing said. It is now tracked like any module that exports the function
 * under a name (programCalls seeds it), and it is always one this guard
 * knows, so a planted program that imports it without carrying its source
 * resolves it.
 */
const DEFINER = 'lib/marketing/automation-events.ts';

/** The outermost expression a reference sits in, through parentheses, casts and `!`. */
function outermost(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e.parent) || ts.isAsExpression(e.parent) || ts.isSatisfiesExpression(e.parent) || ts.isNonNullExpression(e.parent)) e = e.parent;
  return e;
}

/**
 * Whether a node sits in a type, which runs nothing. R7-AW-GUARD-TYPE-POSITION-VALUE:
 * ts.isTypeNode counts an ExpressionWithTypeArguments as a type, but what it
 * holds as its expression is a value in a class's `extends` (`class A extends
 * withFire(fireAutomationEvent) {}`) and in an instantiation expression
 * (`fireAutomationEvent<never>`), and every reference in either was dropped
 * before it was followed or reported. Only one in `implements` or in an
 * interface's `extends` (namesAType), or a type argument, is a type.
 */
function inTypePosition(node: ts.Node): boolean {
  for (let child: ts.Node = node, p: ts.Node | undefined = node.parent; p; child = p, p = p.parent) {
    if (ts.isExpressionWithTypeArguments(p) && p.expression === child && !namesAType(p)) continue;
    if (ts.isTypeNode(p)) return true;
  }
  return false;
}

/** Whether an ExpressionWithTypeArguments names a type: in `implements`, or in an interface's `extends`. */
function namesAType(node: ts.ExpressionWithTypeArguments): boolean {
  const clause = node.parent;
  return ts.isHeritageClause(clause) && (clause.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(clause.parent));
}

/** Whether an identifier is a name being declared here (an import, a binding, a declaration, a key), not a use. */
function declares(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
  if (ts.isBindingElement(parent)) return parent.name === node || parent.propertyName === node;
  return (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isImportEqualsDeclaration(parent)
    || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)) && parent.name === node;
}

/** Where something sits in a source, and its text, for a problem. */
type Site = { line: number; text: string };
/** The names each module exports the function under (an alias, a re-export, a default), each with where it does. */
type FireExports = ReadonlyMap<string, ReadonlyMap<string, Site>>;
/** One source read: its calls, the names it exports the function under, and the `<module>#<name>` it takes from another (`#*`, all of them). */
type Analysis = { calls: Call[]; exports: Map<string, Site>; imports: Set<string> };

/**
 * The path an import of the app's own names, from the root: `@/x` (tsconfig
 * `paths`) or a relative path. A package has none. A path from the file
 * system's root and a URL (`file:`, `data:`, `https:`; not a `node:` builtin)
 * are taken as the app's own too, by a path no source here answers, so an
 * import by one is reported rather than read as a package.
 */
function localPath(from: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return specifier.slice(2);
  if (specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')) return posix.join(posix.dirname(from), specifier);
  if (specifier.startsWith('/') || (/^[a-z][a-z\d+.-]*:/i.test(specifier) && !specifier.startsWith('node:'))) return specifier;
  return null;
}

/** Every extension a source this guard reads can have. */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
/** The sources a built extension an import names can be built from. */
const BUILT_FROM: ReadonlyMap<string, readonly string[]> = new Map([['.js', ['.ts', '.tsx']], ['.jsx', ['.tsx']], ['.mjs', ['.mts']], ['.cjs', ['.cts']]]);

/**
 * Every source an import names, among those read, tried as a bundler does:
 * as written, `x.js` (`.jsx`, `.mjs`, `.cjs`) as the source it is built from,
 * with any extension, as a folder's index; `x/` as the folder's index only.
 * More than one can answer (`x.ts` beside `x.js`, which the type-check and
 * the bundler would each take differently): the import is read as taking
 * from every one, not from whichever is tried first.
 */
function resolveModule(from: string, specifier: string, known: ReadonlySet<string>): string[] {
  const path = localPath(from, specifier);
  if (path === null) return [];
  const extension = posix.extname(path);
  const stem = path.slice(0, path.length - extension.length);
  const candidates = path.endsWith('/') ? EXTENSIONS.map((e) => `${path}index${e}`) : [
    path,
    ...(BUILT_FROM.get(extension) ?? []).map((e) => stem + e),
    ...EXTENSIONS.map((e) => path + e),
    ...EXTENSIONS.map((e) => `${path}/index${e}`),
  ];
  return [...new Set(candidates.filter((candidate) => known.has(candidate)))];
}

/** Data, a stylesheet or an asset: an import of one cannot carry the function. */
const NOT_A_MODULE = /\.(?:json|css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico|txt|md|html?|wasm|woff2?|ttf|otf|mp[34]|webm|wav|pdf|csv|ya?ml)$/i;

/** Whether a declaration or binding sits in an `export const` (`let`, `var`) statement. */
function inExportedStatement(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isVariableStatement(p)) return (ts.getModifiers(p) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isFunctionLike(p)) return false;
  }
  return false;
}

const isRequire = (callee: ts.Expression) => ts.isIdentifier(callee) && callee.text === 'require';

/** Whether a string is where a module is named to be imported: an import, an export from, import(), require(), import x = require(), `declare module`. */
function isSpecifier(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  return ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node)
    || ts.isExternalModuleReference(parent)
    || (ts.isModuleDeclaration(parent) && parent.name === node)
    || (ts.isCallExpression(parent) && parent.arguments[0] === node && (parent.expression.kind === ts.SyntaxKind.ImportKeyword || isRequire(parent.expression)));
}

/** Whether a string may name a source as a path: anything outside an import but a bare `.` or `..`, which is punctuation there. */
function mayNameASource(node: ts.StringLiteralLike): boolean {
  return isSpecifier(node) || (node.text !== '.' && node.text !== '..');
}

/** The read sources the strings in a source name as paths, wherever they are: how one source reaches another. */
function pathsNamed(file: string, ast: ts.SourceFile, known: ReadonlySet<string>): string[] {
  const paths: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) && mayNameASource(node)) paths.push(...resolveModule(file, node.text, known));
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return paths;
}

/**
 * Loaders that take a module by a path this guard does not read as written.
 * `require` is one when it is not called on a path; called on one, it is an
 * import, read with the others.
 */
const LOADERS = new Set(['require', 'createRequire', 'eval', 'Function', '__webpack_require__', '__non_webpack_require__']);
/** What `import.meta` holds that loads nothing. */
const IMPORT_META = new Set(['url', 'dirname', 'filename']);
/** Node's builtins that load or run code by a path or a string (`createRequire`, `vm`, a worker, a child): an import of one in the app is a loader. */
const LOADER_MODULES = new Set(['module', 'vm', 'worker_threads', 'child_process']);

/**
 * A loader named as a value, as written (`require` not called on a path,
 * `createRequire`, `eval`, `Function`, `x.require`, `{ require: r } = module`,
 * `import.meta.webpackContext`): the expression it is used in, or null.
 * R6-AW-GUARD-UNREAD-SOURCES-AND-REQUIRE.
 */
function loaderUse(node: ts.Node): ts.Node | null {
  if (ts.isIdentifier(node)) {
    if (!LOADERS.has(node.text) || declares(node) || inTypePosition(node)) return null;
    const parent = node.parent;
    // `x instanceof Function` reads the constructor and runs nothing.
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && parent.right === node) return null;
    return node.text === 'require' && ts.isCallExpression(parent) && parent.expression === node ? null : parent;
  }
  if (ts.isPropertyAccessExpression(node) && LOADERS.has(node.name.text)) return node.parent;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && LOADERS.has(node.argumentExpression.text)) return node.parent;
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const key = node.propertyName ?? node.name;
    return (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && LOADERS.has(key.text) ? node.parent.parent : null;
  }
  if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
    const access = node.parent;
    if (ts.isPropertyAccessExpression(access) && access.expression === node) return IMPORT_META.has(access.name.text) ? null : access.parent;
    return node.parent;
  }
  return null;
}

/** The methods of a promise: `.then`, `.catch` and `.finally` of a dynamic import. */
const PROMISE_METHODS = new Set(['then', 'catch', 'finally']);

/** Whether a function's body reads its `arguments`, which hold the module whatever its parameters are called. */
function mentionsArguments(node: ts.Node): boolean {
  return ts.forEachChild(node, (child) => ((ts.isIdentifier(child) && child.text === 'arguments') || mentionsArguments(child) ? true : undefined)) ?? false;
}

/**
 * Every call of fireAutomationEvent in one source, with the trigger it
 * passes, every other use of it, which this guard cannot follow, and the
 * names the source exports it under. `app`: whether the source is the app,
 * whose imports are held to resolve (`loads`) and whose loaders are named
 * (loaderUse).
 *
 * R3-AW-GUARD-ALIAS: a call was matched only when its callee was literally
 * named fireAutomationEvent, so `import { fireAutomationEvent as fire }` and
 * then `fire(admin, { trigger: 'demo_started' })` got past the guard. The
 * names the function goes by in a file are now resolved first: an import
 * under another name, a destructured `{ fireAutomationEvent: fire }` (from a
 * namespace import or a dynamic import) and `const fire = <any of these>`,
 * chained. A namespace import is read through its member, so
 * `events.fireAutomationEvent(...)` and `events['fireAutomationEvent'](...)`
 * are calls too. Anything else done with the function (passed as an
 * argument, put in an object, assigned, `.call`) is reported, because the
 * trigger such a use ends up firing is not in this source.
 *
 * R4-AW-GUARD-EXPORTED-ALIAS: names were resolved one file at a time, and
 * `export const fireIt = fireAutomationEvent` was followed as a local alias,
 * so a call of `fireIt` in another file got past. Every export of the
 * function under a name (`export const`, `export { a as b }` with or without
 * `from`, `export default`, `export *`) is now a name that module exports it
 * under (`exported`, worked out by programCalls), and a source that imports
 * that name, or reads that module as a namespace or a dynamic import, knows
 * the function by it.
 *
 * R5-AW-GUARD-NAMESPACE-PASSED-ON: such a namespace counted as taking every
 * name, and was followed only through its members in the file that read it.
 * Passed on (`export { a }`, `export default a`, `export const ns = a`, an
 * argument, an object, a computed member, a rest) it took the function where
 * the guard does not follow it, unreported, as `export * as ns from` is. A
 * namespace, or the module a dynamic import resolves to, is now followed
 * through a member, a destructure naming its keys, another local name for it
 * and a `.then` callback's parameter, and reported anywhere else.
 *
 * R6 (all three items, and the class they are instances of): the module
 * that defines the function is one such module (DEFINER); a promise of one
 * is followed through `.catch`, `.finally` and `.then()` as well as `.then`
 * with a callback (R6-AW-GUARD-CATCH-FINALLY); `require(...)` is read as a
 * dynamic import and `import x = require(...)` as a namespace import; in the
 * app, an import by a path no source read here answers is reported whatever
 * it takes, and so is a loader named as a value; and a path to such a module
 * written anywhere a module is not imported (`new URL(path, import.meta.url)`,
 * a string kept for a loader) is reported as a use of it
 * (R6-AW-GUARD-UNREAD-SOURCES-AND-REQUIRE).
 */
function analyse(file: string, ast: ts.SourceFile, exported: FireExports, known: ReadonlySet<string>, app: boolean): Analysis {
  const names = new Set<string>([FIRE]);
  /** The member names the function goes by on a module this source holds whole. */
  const members = new Set<string>([FIRE]);
  /** The local names of a module that carries the function, held whole: a namespace import, `import x = require()`, and the names those go by. */
  const namespaces = new Set<string>();
  /** The expressions that are such a module, or a promise of one: import(), require(), and `.catch`, `.finally` or `.then()` on one. */
  const modules = new Set<ts.CallExpression>();
  const imports = new Set<string>();
  const exports = new Map<string, Site>();
  const calls: Call[] = [];
  const lineOf = (node: ts.Node) => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
  const site = (node: ts.Node): Site => ({ line: lineOf(node), text: node.getText(ast) });
  /**
   * Where everything this guard does not follow ends. Each check below either
   * follows a use, to a call (whose trigger `check` reads) or to another name
   * it goes by, or reports it here: that is the fail-closed default, and no
   * check returns past it unsaid.
   */
  const report = (at: ts.Node, trigger: Trigger) => { calls.push({ file, line: lineOf(at), trigger }); };
  const cannotFollow = (at: ts.Node, use: ts.Node) => report(at, { unfollowed: use.getText(ast) });
  /** The modules a path names that carry the function, and every name they carry it under. */
  const theirs = (specifier: ts.Expression | undefined) => {
    const tracked = specifier && ts.isStringLiteralLike(specifier) ? resolveModule(file, specifier.text, known).filter((target) => exported.has(target)) : [];
    const their = new Set(tracked.flatMap((target) => [...(exported.get(target)?.keys() ?? [])]));
    return { tracked, their: tracked.length > 0 ? their : undefined };
  };
  const take = (tracked: readonly string[], name: string) => { for (const target of tracked) imports.add(`${target}#${name}`); };
  /** Such a module held whole: every name it carries the function under is a member here. */
  const hold = (tracked: readonly string[], their: ReadonlySet<string>) => {
    for (const name of their) members.add(name);
    take(tracked, '*');
  };
  /**
   * In the app, an import by a path that names no source read here: computed,
   * or local and answered by none. R6-AW-GUARD-UNREAD-SOURCES-AND-REQUIRE: it
   * was reported only when it took a name some read module exports the
   * function under, so an alias in a module the guard did not read slipped
   * past. Whatever it takes, it may be the function. And an import of a
   * builtin that loads code is a loader (LOADER_MODULES), under whatever
   * name it is taken.
   */
  const loads = (specifier: ts.Expression | undefined, at: ts.Node) => {
    if (!app) return;
    if (specifier && ts.isStringLiteralLike(specifier)) {
      if (LOADER_MODULES.has(specifier.text.replace(/^node:/, ''))) {
        report(at, { loader: at.getText(ast) });
        return;
      }
      if (localPath(file, specifier.text) === null || NOT_A_MODULE.test(specifier.text) || resolveModule(file, specifier.text, known).length > 0) return;
    }
    report(at, { unresolved: specifier ? specifier.getText(ast) : '(no path)' });
  };
  const isMember = (node: ts.Node): node is ts.Expression =>
    (ts.isPropertyAccessExpression(node) && members.has(node.name.text))
    || (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && members.has(node.argumentExpression.text));
  const isFire = (expression: ts.Expression): boolean => {
    const e = unwrap(expression);
    return (ts.isIdentifier(e) && names.has(e.text)) || isMember(e);
  };
  /** `{ fireAutomationEvent: fire }` destructured from a namespace or a dynamic import. */
  const bindsFire = (node: ts.BindingElement): node is ts.BindingElement & { name: ts.Identifier } => {
    const key = node.propertyName ?? node.name;
    return ts.isIdentifier(node.name) && ts.isObjectBindingPattern(node.parent)
      && (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && members.has(key.text);
  };

  // What this source takes from the others: the names their exports go by
  // here, the modules it holds whole, and what it passes on.
  const readModules = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const { tracked, their } = theirs(node.moduleSpecifier);
      const clause = node.importClause;
      if (clause?.name && their?.has('default')) { names.add(clause.name.text); take(tracked, 'default'); }
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings) && their) {
        hold(tracked, their);
        namespaces.add(bindings.name.text);
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          const imported = (specifier.propertyName ?? specifier.name).text;
          if (imported === FIRE || their?.has(imported)) names.add(specifier.name.text);
          if (their?.has(imported)) take(tracked, imported);
        }
      }
      // An import of types only loads nothing.
      const onlyTypes = !clause?.name && bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((s) => s.isTypeOnly);
      if (!onlyTypes) loads(node.moduleSpecifier, node);
    }
    // `import x = require(...)`: a namespace import.
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && !node.isTypeOnly) {
      const { tracked, their } = theirs(node.moduleReference.expression);
      if (their) {
        hold(tracked, their);
        namespaces.add(node.name.text);
        // `export import x = require(...)`: the module passed on whole.
        if (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) cannotFollow(node, node);
      }
      loads(node.moduleReference.expression, node);
    }
    // import(...) and require(...): the module, or a promise of it, as a value.
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequire(node.expression))) {
      const { tracked, their } = theirs(node.arguments[0]);
      if (their) {
        hold(tracked, their);
        modules.add(node);
      }
      loads(node.arguments[0], node);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      const { tracked, their } = theirs(node.moduleSpecifier);
      const clause = node.exportClause;
      const onlyTypes = clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((s) => s.isTypeOnly);
      if (!onlyTypes) loads(node.moduleSpecifier, node);
      if (!clause) {
        // `export * from`: every name it exports the function under but the default.
        for (const name of their ?? []) {
          if (name === 'default') continue;
          exports.set(name, site(node));
          take(tracked, name);
        }
      } else if (ts.isNamespaceExport(clause)) {
        // `export * as ns from`: a namespace inside a namespace, not followed.
        if (their) {
          cannotFollow(node, node);
          take(tracked, '*');
        }
      } else {
        for (const specifier of clause.elements) {
          const imported = (specifier.propertyName ?? specifier.name).text;
          if (imported === FIRE || their?.has(imported)) exports.set(specifier.name.text, site(specifier));
          if (their?.has(imported)) take(tracked, imported);
        }
      }
    }
    ts.forEachChild(node, readModules);
  };
  readModules(ast);

  // The names it goes by, to a fixed point (`const a = fire; const b = a;`).
  for (let size = -1; size !== names.size;) {
    size = names.size;
    const collect = (node: ts.Node) => {
      if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === FIRE) names.add(node.name.text);
      if (ts.isBindingElement(node) && bindsFire(node)) names.add(node.name.text);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isFire(node.initializer)) names.add(node.name.text);
      ts.forEachChild(node, collect);
    };
    collect(ast);
  }

  /** Whether a node is such a module here: an import() or require() of it, a promise chained on one, or a use of a name it goes by. */
  const isNamespace = (node: ts.Node): node is ts.Expression => {
    if (ts.isCallExpression(node)) return modules.has(node);
    if (!ts.isIdentifier(node) || !namespaces.has(node.text) || declares(node) || inTypePosition(node)) return false;
    const parent = node.parent;
    // A parameter or an attribute of that name, or another module's export of it, is not this namespace.
    return !((ts.isParameter(parent) || ts.isJsxAttribute(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent) || ts.isEnumMember(parent)) && parent.name === node)
      && !(ts.isExportSpecifier(parent) && parent.parent.parent.moduleSpecifier);
  };
  /** A destructure that takes only the keys it names, binding the function's own to a name. */
  const namesItsKeys = (pattern: ts.BindingName) => ts.isObjectBindingPattern(pattern) && pattern.elements.every((element) => {
    const key = element.propertyName ?? element.name;
    return !element.dotDotDotToken && (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && (ts.isIdentifier(element.name) || !members.has(key.text));
  });
  /**
   * What is done with such a module: read through a member or a destructure
   * that names its keys (null), given another local name (alias), chained to
   * a promise that resolves to it again (again), or taken where this guard
   * does not follow it (unfollowed), which is what anything not named here is.
   */
  const namespaceUse = (node: ts.Expression): { alias: string } | { again: ts.CallExpression } | { unfollowed: ts.Node } | null => {
    let outer = node;
    while (ts.isParenthesizedExpression(outer.parent) || ts.isAsExpression(outer.parent) || ts.isSatisfiesExpression(outer.parent)
      || ts.isNonNullExpression(outer.parent) || ts.isAwaitExpression(outer.parent)) outer = outer.parent;
    const parent = outer.parent;
    const access = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === outer ? parent : null;
    if (access) {
      const member = ts.isPropertyAccessExpression(access) ? access.name.text
        : ts.isStringLiteralLike(access.argumentExpression) ? access.argumentExpression.text : null;
      // `a[pick()]`: which member it reads is not in the source.
      if (member === null) return { unfollowed: access };
      // A member read: the names it carries the function under are calls or uses of it (isMember).
      if (!PROMISE_METHODS.has(member)) return null;
      // R6-AW-GUARD-CATCH-FINALLY: only `.then` with a callback was read as
      // the promise it is, and any other method as a member of the module.
      const call = access.parent;
      if (!ts.isCallExpression(call) || call.expression !== access) return { unfollowed: access };
      // `.catch(...)`, `.finally(...)` and `.then()` resolve to the module again.
      if (member !== 'then' || call.arguments.length === 0) return { again: call };
      // `.then((m) => ...)`: the module is the callback's first parameter.
      const callback = call.arguments[0];
      if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return { unfollowed: call };
      if (ts.isFunctionExpression(callback) && mentionsArguments(callback.body)) return { unfollowed: call };
      const param = callback.parameters[0];
      if (!param) return null;
      if (param.dotDotDotToken) return { unfollowed: call };
      if (ts.isIdentifier(param.name)) return { alias: param.name.text };
      return namesItsKeys(param.name) ? null : { unfollowed: call };
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === outer) {
      if (ts.isIdentifier(parent.name)) return inExportedStatement(parent) ? { unfollowed: parent } : { alias: parent.name.text };
      return namesItsKeys(parent.name) ? null : { unfollowed: parent };
    }
    // Thrown away (`import(...);`, `void import(...)`): nothing takes it.
    if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) return null;
    // An export or an object it sits in is read whole.
    if (ts.isExportSpecifier(parent)) return { unfollowed: parent.parent.parent };
    if (ts.isShorthandPropertyAssignment(parent) || ts.isSpreadAssignment(parent)) return { unfollowed: parent.parent };
    // Passed, returned, stored, exported, compared, or anything else: the fail-closed default.
    return { unfollowed: parent };
  };
  // The names and the promises such a module goes by, to a fixed point
  // (`const b = a;`, `.then((m) => ...)`, `import(...).catch(...)`).
  for (let size = -1; size !== namespaces.size + modules.size;) {
    size = namespaces.size + modules.size;
    const collect = (node: ts.Node) => {
      const use = isNamespace(node) ? namespaceUse(node) : null;
      if (use && 'alias' in use) namespaces.add(use.alias);
      if (use && 'again' in use) modules.add(use.again);
      ts.forEachChild(node, collect);
    };
    collect(ast);
  }

  const visit = (node: ts.Node) => {
    if (isNamespace(node)) {
      const use = namespaceUse(node);
      if (use && 'unfollowed' in use) cannotFollow(node, use.unfollowed);
    }
    // A path to such a module written anywhere a module is not imported
    // (`new URL(path, import.meta.url)`, a string kept for a loader): that
    // module, where this guard does not follow it.
    if (ts.isStringLiteralLike(node) && !isSpecifier(node) && mayNameASource(node)
      && resolveModule(file, node.text, known).some((target) => exported.has(target)) && !inTypePosition(node)) cannotFollow(node, node.parent);
    // In the app, a loader named as a value: what it loads is not in the source.
    const loader = app ? loaderUse(node) : null;
    if (loader) report(node, { loader: loader.getText(ast) });
    // `export const { fireAutomationEvent: fire } = events;`
    if (ts.isBindingElement(node) && bindsFire(node) && inExportedStatement(node)) exports.set(node.name.text, site(node));
    const reference = isMember(node) ? node
      : ts.isIdentifier(node) && names.has(node.text) && !declares(node) && !inTypePosition(node) ? node : null;
    if (reference) {
      const outer = outermost(reference);
      const parent = outer.parent;
      if (ts.isCallExpression(parent) && parent.expression === outer) {
        calls.push({ file, line: lineOf(parent), trigger: triggerOf(parent.arguments[1], ast) });
      } else if (ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isIdentifier(parent.name)) {
        // `const fire = fireAutomationEvent` is an alias, followed above; exported, a name this module exports it under.
        if (inExportedStatement(parent)) exports.set(parent.name.text, site(parent));
      } else if (ts.isExportSpecifier(parent)) {
        // `export { fire as fireIt }`; one `from` another module was read with the others above.
        if (!parent.parent.parent.moduleSpecifier) exports.set(parent.name.text, site(parent));
      } else if (ts.isExportAssignment(parent) && !parent.isExportEquals) {
        exports.set('default', site(parent));
      } else {
        // Nothing else is followed.
        cannotFollow(outer, parent);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { calls, exports, imports };
}

/**
 * Every call of fireAutomationEvent across a set of sources, and every use
 * this guard cannot follow, in file order and by line. A path resolves to a
 * source in the set or in `tree` (the repository's, by default: a planted
 * program is read as if it were added to the tree, whose own sources are
 * taken to carry nothing).
 *
 * The app is every source readAs puts in it, and every source one of those
 * names by a path, an import or any other (a script the app imports is the
 * app). The names each module exports the function under are worked out to
 * a fixed point, since one module can pass on another's (a barrel, a
 * re-export of a re-export), starting from the module that defines it. An
 * export that no source read here takes is reported: whatever calls it is
 * somewhere this guard does not read.
 */
function programCalls(program: ReadonlyMap<string, string>, tree: Iterable<string> = sources.keys()): Call[] {
  const known = new Set([...tree, ...program.keys(), DEFINER]);
  const asts = [...program].map(([file, source]) => [file, parse(file, source)] as const);
  const app = new Set(asts.filter(([file]) => readAs(file) === 'app').map(([file]) => file));
  const named = new Map(asts.map(([file, ast]) => [file, pathsNamed(file, ast, known)]));
  for (const file of app) for (const next of named.get(file) ?? []) if (program.has(next)) app.add(next);
  const seed: FireExports = new Map([[DEFINER, new Map([[FIRE, { line: 0, text: FIRE }]])]]);
  const count = (exports: FireExports) => [...exports.values()].reduce((n, their) => n + their.size, 0);
  let exported = seed;
  for (;;) {
    const analyses = asts.map(([file, ast]) => [file, analyse(file, ast, exported, known, app.has(file))] as const);
    const found = new Map(seed);
    for (const [file, { exports }] of analyses) if (exports.size > 0) found.set(file, new Map([...(found.get(file) ?? []), ...exports]));
    if (count(found) !== count(exported)) {
      exported = found;
      continue;
    }
    const taken = new Set(analyses.flatMap(([, a]) => [...a.imports]));
    return analyses.flatMap(([file, { calls, exports }]) => {
      const untaken = [...exports].filter(([name]) => !taken.has(`${file}#${name}`) && !taken.has(`${file}#*`))
        .map(([, at]): Call => ({ file, line: at.line, trigger: { unfollowed: at.text } }));
      return [...calls, ...untaken].sort((a, b) => a.line - b.line);
    });
  }
}

/** The calls in one source read on its own, so nothing takes what it exports. */
function fireCalls(file: string, source: string): Call[] {
  return programCalls(new Map([[file, source]]));
}

/** The string values of a `const <name> = { ... }` map in a source. */
function mapValues(file: string, source: string, name: string): string[] {
  const ast = parse(file, source);
  const values: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      const object = unwrap(node.initializer);
      if (ts.isObjectLiteralExpression(object)) {
        for (const property of object.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const value = unwrap(property.initializer);
          if (ts.isStringLiteral(value)) values.push(value.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return values;
}

/**
 * Calls whose trigger is computed, each with what it can be. An entry is a
 * claim about the source, so it reads the values from the source rather than
 * listing them: a new key in the map is checked like a new literal.
 */
const COMPUTED: Record<string, { expression: string; why: string; values: (source: string) => string[] }> = {
  'app/api/webhooks/resend/route.ts': {
    expression: 'trigger',
    why: 'passes EVENT_TRIGGER[event.type], the map from a Resend event type to the engagement trigger it fires',
    values: (source) => {
      expect(source, 'the resend webhook no longer takes its trigger from EVENT_TRIGGER').toContain('const trigger = EVENT_TRIGGER[event.type];');
      return mapValues('app/api/webhooks/resend/route.ts', source, 'EVENT_TRIGGER');
    },
  },
};

/** The triggers the calls pass, and every call whose trigger is not one a workflow can run on. */
function check(calls: Call[], sourceOf: (file: string) => string): { passed: Set<string>; problems: string[] } {
  const fired = new Set<string>(FIRED_TRIGGERS);
  const passed = new Set<string>();
  const problems: string[] = [];
  for (const call of calls) {
    const where = `${call.file}:${call.line}`;
    if ('unreadable' in call.trigger) {
      problems.push(`${where} passes a trigger this guard cannot read: ${call.trigger.unreadable}`);
      continue;
    }
    if ('unfollowed' in call.trigger) {
      problems.push(`${where} uses fireAutomationEvent where this guard cannot follow it: ${call.trigger.unfollowed}`);
      continue;
    }
    if ('unresolved' in call.trigger) {
      problems.push(`${where} may take fireAutomationEvent by ${call.trigger.unresolved}, which names no source this guard reads`);
      continue;
    }
    if ('loader' in call.trigger) {
      problems.push(`${where} loads a module where this guard cannot follow it: ${call.trigger.loader}`);
      continue;
    }
    let triggers: string[];
    if ('literal' in call.trigger) {
      triggers = [call.trigger.literal];
    } else {
      const entry = COMPUTED[call.file];
      if (!entry || entry.expression !== call.trigger.computed) {
        problems.push(`${where} passes a computed trigger (${call.trigger.computed}) that COMPUTED does not list`);
        continue;
      }
      triggers = entry.values(sourceOf(call.file));
      if (triggers.length === 0) problems.push(`${where}: COMPUTED found no trigger values (${entry.why})`);
    }
    for (const trigger of triggers) {
      passed.add(trigger);
      if (!fired.has(trigger)) problems.push(`${where} fires '${trigger}', which FIRED_TRIGGERS leaves out`);
    }
  }
  return { passed, problems };
}

const calls = programCalls(sources);
const sourceOf = (file: string) => sources.get(file) ?? '';

describe('every trigger the app fires is one a workflow can be switched on for', () => {
  it('finds the calls it is about, so it cannot pass on none', () => {
    const literal = (file: string, trigger: string) => calls.filter((c) => c.file === file && 'literal' in c.trigger && c.trigger.literal === trigger);
    expect(calls.length, `found only ${calls.length} calls`).toBeGreaterThanOrEqual(8);
    expect(literal('app/onboarding/actions.ts', 'onboarding_completed')).toHaveLength(2);
    expect(literal('app/api/cron/journey-recovery/route.ts', 'onboarding_abandoned')).toHaveLength(1);
    expect(literal('app/api/cron/journey-recovery/route.ts', 'demo_abandoned')).toHaveLength(1);
    expect(literal('app/api/cron/checkout-abandoned/route.ts', 'checkout_abandoned')).toHaveLength(1);
    expect(literal('app/api/webhooks/stripe/route.ts', 'payment_completed')).toHaveLength(1);
    expect(literal('lib/marketing/public-form-automation.ts', 'form_submitted')).toHaveLength(1);
    expect(calls.filter((c) => c.file === 'app/api/webhooks/resend/route.ts' && 'computed' in c.trigger)).toHaveLength(1);
    expect(mapValues('app/api/webhooks/resend/route.ts', sourceOf('app/api/webhooks/resend/route.ts'), 'EVENT_TRIGGER').sort()).toEqual(['email_clicked', 'email_opened']);
    // The definition is not a call.
    expect(calls.filter((c) => c.file === 'lib/marketing/automation-events.ts')).toEqual([]);
  });

  it('every trigger passed to fireAutomationEvent is in FIRED_TRIGGERS', () => {
    expect(check(calls, sourceOf).problems).toEqual([]);
  });

  it('FIRED_TRIGGERS holds nothing that no call and no scheduled sweep fires', () => {
    const { passed } = check(calls, sourceOf);
    const scheduled = new Set<string>(SCHEDULED_TRIGGERS);
    expect(FIRED_TRIGGERS.filter((trigger) => !passed.has(trigger) && !scheduled.has(trigger))).toEqual([]);
  });

  it('catches a planted call on a trigger FIRED_TRIGGERS leaves out, a computed one it does not know, and one it cannot read', () => {
    const planted = [
      "await fireAutomationEvent(admin, { trigger: 'demo_started', email: null, subjectKey: 'demo_started:x' });",
      "await fireAutomationEvent(admin, { trigger: pick(event) as EventTrigger, email: null, subjectKey: 'x' });",
      'await fireAutomationEvent(admin, { ...params });',
    ].join('\n');
    const plantedCalls = fireCalls('app/planted/route.ts', planted);
    expect(plantedCalls).toHaveLength(3);
    const { problems } = check(plantedCalls, () => planted);
    expect(problems).toEqual([
      "app/planted/route.ts:1 fires 'demo_started', which FIRED_TRIGGERS leaves out",
      'app/planted/route.ts:2 passes a computed trigger (pick(event)) that COMPUTED does not list',
      'app/planted/route.ts:3 passes a trigger this guard cannot read: { ...params }',
    ]);
    // And a new key in the resend map is checked like a new literal.
    const resend = sourceOf('app/api/webhooks/resend/route.ts').replace("'email.clicked': 'email_clicked',", "'email.clicked': 'email_clicked',\n  'email.delivered': 'demo_started',");
    expect(check(fireCalls('app/api/webhooks/resend/route.ts', resend), () => resend).problems)
      .toEqual([expect.stringMatching(/^app\/api\/webhooks\/resend\/route\.ts:\d+ fires 'demo_started', which FIRED_TRIGGERS leaves out$/)]);
  });

  // R3-AW-GUARD-ALIAS. The reviewer's probe (line 3) passed at 448bf21e8: the
  // call was made under the name an aliased import gave it.
  it('follows the function under another name, through a namespace import, and reports a use it cannot follow', () => {
    const planted = [
      "import { fireAutomationEvent as fire } from '@/lib/marketing/automation-events';",
      "import * as events from '@/lib/marketing/automation-events';",
      "await fire(admin, { trigger: 'demo_started', email: null, subjectKey: 'demo_started:x' });",
      "await events.fireAutomationEvent(admin, { trigger: 'demo_started', email: null, subjectKey: 'b' });",
      "await events['fireAutomationEvent'](admin, { trigger: 'demo_started', email: null, subjectKey: 'c' });",
      'const { fireAutomationEvent: go } = events;',
      'const again = go;',
      "await again!(admin, { trigger: 'demo_started', email: null, subjectKey: 'd' });",
      "const { fireAutomationEvent: later } = await import('@/lib/marketing/automation-events');",
      "await later(admin, { trigger: 'payment_completed', email: null, subjectKey: 'e' });",
      'schedule(fire);',
      "export { fireAutomationEvent as fireIt } from '@/lib/marketing/automation-events';",
      "await fire.call(null, admin, { trigger: 'demo_started', email: null, subjectKey: 'f' });",
      'type Fire = typeof fire;',
    ].join('\n');
    const plantedCalls = fireCalls('app/planted/route.ts', planted);
    expect(plantedCalls.filter((c) => 'literal' in c.trigger).map((c) => c.line), 'a call under another name was not found').toEqual([3, 4, 5, 8, 10]);
    expect(check(plantedCalls, () => planted).problems).toEqual([
      "app/planted/route.ts:3 fires 'demo_started', which FIRED_TRIGGERS leaves out",
      "app/planted/route.ts:4 fires 'demo_started', which FIRED_TRIGGERS leaves out",
      "app/planted/route.ts:5 fires 'demo_started', which FIRED_TRIGGERS leaves out",
      "app/planted/route.ts:8 fires 'demo_started', which FIRED_TRIGGERS leaves out",
      'app/planted/route.ts:11 uses fireAutomationEvent where this guard cannot follow it: schedule(fire)',
      'app/planted/route.ts:12 uses fireAutomationEvent where this guard cannot follow it: fireAutomationEvent as fireIt',
      'app/planted/route.ts:13 uses fireAutomationEvent where this guard cannot follow it: fire.call',
    ]);
    // The callers as they are import it under its own name, and use it only to call it.
    expect(calls.filter((c) => 'unfollowed' in c.trigger)).toEqual([]);
  });

  // R4-AW-GUARD-EXPORTED-ALIAS. The reviewer's two files (the first and the
  // fifth below) passed at b5e2a7123: each source was read on its own, and
  // `export const fireIt = fireAutomationEvent` was followed as a local alias,
  // so the call of fireIt in app/ was not seen.
  it('follows the function into another file under every name a module exports it by, and reports an export nothing takes', () => {
    const program = new Map<string, string>([
      ['lib/zz-reviewer-alias.ts', [
        "import { fireAutomationEvent } from '@/lib/marketing/automation-events';",
        'export const fireIt = fireAutomationEvent;',
      ].join('\n')],
      ['lib/zz-more.ts', [
        "import * as events from '@/lib/marketing/automation-events';",
        'export const f = events.fireAutomationEvent;',
        'const local = f;',
        'export { local as viaSpecifier };',
        'export default f;',
        'export const { fireAutomationEvent: destructured } = events;',
      ].join('\n')],
      ['lib/zz-barrel/index.ts', [
        "export * from '../zz-reviewer-alias';",
        "export { f as relayed, destructured } from '@/lib/zz-more';",
      ].join('\n')],
      ['lib/zz-unused.ts', [
        "import { fireAutomationEvent as fire } from '@/lib/marketing/automation-events';",
        'export const unused = fire;',
      ].join('\n')],
      ['app/zz-reviewer-probe2.ts', [
        "import { fireIt } from '@/lib/zz-reviewer-alias';",
        "await fireIt(admin, { trigger: 'demo_started', email: null, subjectKey: 'demo_started:y' });",
      ].join('\n')],
      ['app/zz-probe3/route.ts', [
        "import fire, { viaSpecifier } from '../../lib/zz-more';",
        "import { fireIt as again, relayed, destructured } from '@/lib/zz-barrel';",
        "import * as more from '@/lib/zz-more';",
        "await fire(admin, { trigger: 'demo_started', email: null, subjectKey: 'a' });",
        "await viaSpecifier(admin, { trigger: 'demo_started', email: null, subjectKey: 'b' });",
        "await again(admin, { trigger: 'demo_started', email: null, subjectKey: 'c' });",
        "await relayed(admin, { trigger: 'demo_started', email: null, subjectKey: 'd' });",
        "await destructured(admin, { trigger: 'demo_started', email: null, subjectKey: 'e' });",
        "await more.f(admin, { trigger: 'demo_started', email: null, subjectKey: 'f' });",
      ].join('\n')],
      // A trigger the list holds, called through a dynamic import, is found and passes.
      ['app/zz-probe4.ts', [
        "const { viaSpecifier: later } = await import('@/lib/zz-more');",
        "await later(admin, { trigger: 'payment_completed', email: null, subjectKey: 'g' });",
      ].join('\n')],
    ]);
    const plantedCalls = programCalls(program);
    expect(plantedCalls.filter((c) => 'literal' in c.trigger).map((c) => `${c.file}:${c.line}`), 'a call under an exported name was not found').toEqual([
      'app/zz-reviewer-probe2.ts:2',
      ...[4, 5, 6, 7, 8, 9].map((line) => `app/zz-probe3/route.ts:${line}`),
      'app/zz-probe4.ts:2',
    ]);
    expect(check(plantedCalls, (file) => program.get(file) ?? '').problems).toEqual([
      'lib/zz-unused.ts:2 uses fireAutomationEvent where this guard cannot follow it: unused = fire',
      "app/zz-reviewer-probe2.ts:2 fires 'demo_started', which FIRED_TRIGGERS leaves out",
      ...[4, 5, 6, 7, 8, 9].map((line) => `app/zz-probe3/route.ts:${line} fires 'demo_started', which FIRED_TRIGGERS leaves out`),
    ]);
  });

  /** The reviewer's module that exports the function under another name. */
  const ALIAS_MODULE = [
    "import { fireAutomationEvent } from '@/lib/marketing/automation-events';",
    'export const fireIt = fireAutomationEvent;',
  ].join('\n');
  const cannotFollow = (where: string, text: string) => `${where} uses fireAutomationEvent where this guard cannot follow it: ${text}`;

  // R5-AW-GUARD-NAMESPACE-PASSED-ON. The reviewer's three probes (zz-b with
  // zz-c, zz-d with zz-e, zz-f with zz-g) passed at a8a1d832c with no call and
  // no problem: a namespace of a module that exports the function under a
  // name counted as taking all of them, and was followed only through its
  // members in the file that imported it. Passed on, re-exported, defaulted or
  // stored, it took the function where the guard does not follow it, as
  // `export * as ns from` already reports.
  it('reports a namespace of a module that exports the function under a name wherever it is passed on, and follows it where it is only read', () => {
    const program = new Map<string, string>([
      ['lib/zz-a.ts', ALIAS_MODULE],
      ['lib/zz-b.ts', ["import * as a from '@/lib/zz-a';", 'export { a };'].join('\n')],
      ['app/zz-c.ts', ["import { a } from '@/lib/zz-b';", "await a.fireIt(admin, { trigger: 'demo_started', email: null, subjectKey: 'c' });"].join('\n')],
      ['lib/zz-d.ts', ["import * as a from '@/lib/zz-a';", 'export default a;'].join('\n')],
      ['app/zz-e.ts', ["import d from '@/lib/zz-d';", "await d.fireIt(admin, { trigger: 'demo_started', email: null, subjectKey: 'e' });"].join('\n')],
      ['lib/zz-f.ts', ["import * as a from '@/lib/zz-a';", 'export const ns = a;'].join('\n')],
      ['app/zz-g.ts', ["import { ns } from '@/lib/zz-f';", "await ns.fireIt(admin, { trigger: 'demo_started', email: null, subjectKey: 'g' });"].join('\n')],
      // Passed on within a file, and a dynamic import's module passed on.
      ['app/zz-h.ts', [
        "import * as a from '@/lib/zz-a';",
        'schedule(a);',
        'const holder = { a };',
        "await a[pick()](admin, { trigger: 'demo_started', email: null, subjectKey: 'h' });",
        'const { other, ...rest } = a;',
        "const mod = await import('@/lib/zz-a');",
        'register(mod);',
        "import('@/lib/zz-a').then((m) => register(m));",
        "import('@/lib/zz-a').then(register);",
        "export const load = () => import('@/lib/zz-a');",
      ].join('\n')],
      // Only read through its members, under any local name: followed, nothing to report.
      ['app/zz-i.ts', [
        "import * as a from '@/lib/zz-a';",
        "await a.fireIt(admin, { trigger: 'payment_completed', email: null, subjectKey: 'i1' });",
        'const b = a;',
        "await b.fireIt(admin, { trigger: 'payment_completed', email: null, subjectKey: 'i2' });",
        "await (await import('@/lib/zz-a')).fireIt(admin, { trigger: 'payment_completed', email: null, subjectKey: 'i3' });",
        "await import('@/lib/zz-a').then((m) => m.fireIt(admin, { trigger: 'payment_completed', email: null, subjectKey: 'i4' }));",
        "await import('@/lib/zz-a').then(({ fireIt: go }) => go(admin, { trigger: 'payment_completed', email: null, subjectKey: 'i5' }));",
        'const { fireIt: named } = a;',
        "await named(admin, { trigger: 'payment_completed', email: null, subjectKey: 'i6' });",
        'type A = typeof a;',
      ].join('\n')],
    ]);
    const plantedCalls = programCalls(program);
    expect(plantedCalls.filter((c) => 'literal' in c.trigger).map((c) => `${c.file}:${c.line}`), 'a call through a namespace read in place was not found')
      .toEqual([2, 4, 5, 6, 7, 9].map((line) => `app/zz-i.ts:${line}`));
    expect(check(plantedCalls, (file) => program.get(file) ?? '').problems, 'a namespace passed on was neither followed nor reported').toEqual([
      cannotFollow('lib/zz-b.ts:2', 'export { a };'),
      cannotFollow('lib/zz-d.ts:2', 'export default a;'),
      cannotFollow('lib/zz-f.ts:2', 'ns = a'),
      cannotFollow('app/zz-h.ts:2', 'schedule(a)'),
      cannotFollow('app/zz-h.ts:3', '{ a }'),
      cannotFollow('app/zz-h.ts:4', 'a[pick()]'),
      cannotFollow('app/zz-h.ts:5', '{ other, ...rest } = a'),
      cannotFollow('app/zz-h.ts:7', 'register(mod)'),
      cannotFollow('app/zz-h.ts:8', 'register(m)'),
      cannotFollow('app/zz-h.ts:9', "import('@/lib/zz-a').then(register)"),
      cannotFollow('app/zz-h.ts:10', "() => import('@/lib/zz-a')"),
    ]);
  });

  // R5-AW-GUARD-NAMESPACE-PASSED-ON, the smaller limit. A file that imported
  // the reviewer's alias by a path resolveModule did not resolve (`.js`, a
  // folder with a trailing slash) was not read as taking it, and with another
  // file importing it normally the export was not reported either: the call
  // was missed with nothing said.
  it('resolves an import as the bundler does, and reports one that may take the function by a path it reads no source for', () => {
    const program = new Map<string, string>([
      ['lib/zz-a.ts', ALIAS_MODULE],
      ['lib/zz-bar/index.ts', "export { fireIt as barFire } from '../zz-a';"],
      ['app/zz-c.ts', ["import { fireIt } from '@/lib/zz-a';", "await fireIt(admin, { trigger: 'payment_completed', email: null, subjectKey: 'c' });"].join('\n')],
      ['app/zz-js.ts', ["import { fireIt } from '@/lib/zz-a.js';", "await fireIt(admin, { trigger: 'demo_started', email: null, subjectKey: 'js' });"].join('\n')],
      ['app/zz-slash.ts', ["import * as bar from '@/lib/zz-bar/';", "await bar.barFire(admin, { trigger: 'demo_started', email: null, subjectKey: 'slash' });"].join('\n')],
      ['app/zz-index/route.ts', ["import { barFire } from '../../lib/zz-bar/index.js';", "await barFire(admin, { trigger: 'demo_started', email: null, subjectKey: 'index' });"].join('\n')],
      ['app/zz-gone.ts', [
        "import { fireIt as lost } from '@/lib/zz-gone';",
        "import * as elsewhere from '../lib/zz-elsewhere.mjs';",
        'const later = await import(`@/lib/${name}`);',
        "export * from './zz-gone-too';",
        // Sources this guard reads (a .mjs, shared/: the tree's, which a planted program resolves against), or not a module: nothing to say.
        "import { parseBuildRevision } from '@/lib/build-identity.mjs';",
        "import messages from '@/lib/i18n/messages/en-US.json';",
        "import { createSessionRefreshFetch } from '@/shared/auth/refresh-fetch';",
        "await lost(admin, { trigger: 'demo_started', email: null, subjectKey: 'gone' });",
      ].join('\n')],
    ]);
    const plantedCalls = programCalls(program);
    expect(plantedCalls.filter((c) => 'literal' in c.trigger).map((c) => `${c.file}:${c.line}`), 'a call by an import path the bundler resolves was not found').toEqual([
      'app/zz-c.ts:2', 'app/zz-js.ts:2', 'app/zz-slash.ts:2', 'app/zz-index/route.ts:2',
    ]);
    expect(check(plantedCalls, (file) => program.get(file) ?? '').problems).toEqual([
      "app/zz-js.ts:2 fires 'demo_started', which FIRED_TRIGGERS leaves out",
      "app/zz-slash.ts:2 fires 'demo_started', which FIRED_TRIGGERS leaves out",
      "app/zz-index/route.ts:2 fires 'demo_started', which FIRED_TRIGGERS leaves out",
      "app/zz-gone.ts:1 may take fireAutomationEvent by '@/lib/zz-gone', which names no source this guard reads",
      "app/zz-gone.ts:2 may take fireAutomationEvent by '../lib/zz-elsewhere.mjs', which names no source this guard reads",
      'app/zz-gone.ts:3 may take fireAutomationEvent by `@/lib/${name}`, which names no source this guard reads',
      "app/zz-gone.ts:4 may take fireAutomationEvent by './zz-gone-too', which names no source this guard reads",
    ]);
  });

  const unresolvedAt = (where: string, path: string) => `${where} may take fireAutomationEvent by ${path}, which names no source this guard reads`;
  const loaderAt = (where: string, text: string) => `${where} loads a module where this guard cannot follow it: ${text}`;
  const firesDemoStarted = (where: string) => `${where} fires 'demo_started', which FIRED_TRIGGERS leaves out`;
  const literalsOf = (program: ReadonlyMap<string, string>) => programCalls(program).filter((c) => 'literal' in c.trigger).map((c) => `${c.file}:${c.line}`);
  const problemsOf = (program: ReadonlyMap<string, string>) => check(programCalls(program), (file) => program.get(file) ?? '').problems;
  /** A module that exports the function under a name of its own. */
  const aliasModule = (name: string) => ["import { fireAutomationEvent } from '@/lib/marketing/automation-events';", `export const ${name} = fireAutomationEvent;`].join('\n');
  /** The reviewer's control: a file that imports the alias normally, so its export is taken. */
  const CONTROL = ["import { fireIt } from '@/lib/zz-a';", "await fireIt(admin, { trigger: 'payment_completed', email: null, subjectKey: 'n' });"].join('\n');

  // R6-AW-GUARD-DEFINER-NAMESPACE. The reviewer's probes (zz-d, and zz-d2
  // through zz-reg) passed at 095357766 with no call and no problem: a
  // namespace of the module that defines the function was never tracked,
  // since its own `export async function` is a declaration, not a name it
  // exports the function under. The most direct form was the one left out:
  // the same `a[pick()]` on a module that exports an alias is reported above.
  it('tracks a namespace of the module that defines the function as it does one of a module that exports it under another name', () => {
    const program = new Map<string, string>([
      ['app/zz-d.ts', [
        "import * as ev from '@/lib/marketing/automation-events';",
        "await ev[pick()](admin, { trigger: 'demo_started', email: null, subjectKey: 'd1' });",
        'register(ev);',
        "const m = await import('@/lib/marketing/automation-events');",
        "await m[pick()](admin, { trigger: 'demo_started', email: null, subjectKey: 'd2' });",
      ].join('\n')],
      ['lib/zz-reg.ts', "export function call(m, k) { return m[k](admin, { trigger: 'demo_started', email: null, subjectKey: 'reg' }); }"],
      ['app/zz-d2.ts', [
        "import * as ev from '@/lib/marketing/automation-events';",
        "import { call } from '@/lib/zz-reg';",
        "await call(ev, 'fireAutomationEvent');",
        // Passed on whole, or chained and passed on.
        'export { ev };',
        "export * as events from '@/lib/marketing/automation-events';",
        "export const later = import('@/lib/marketing/automation-events').catch(() => null);",
        "import zz = require('@/lib/marketing/automation-events');",
        'remember(zz);',
        // Read in place: followed, nothing to report.
        "await ev.fireAutomationEvent(admin, { trigger: 'payment_completed', email: null, subjectKey: 'd3' });",
        "await zz['fireAutomationEvent'](admin, { trigger: 'payment_completed', email: null, subjectKey: 'd4' });",
        "await require('@/lib/marketing/automation-events').fireAutomationEvent(admin, { trigger: 'payment_completed', email: null, subjectKey: 'd5' });",
      ].join('\n')],
    ]);
    expect(literalsOf(program), 'a call through a namespace of the definer read in place was not found').toEqual([9, 10, 11].map((line) => `app/zz-d2.ts:${line}`));
    expect(problemsOf(program), 'a namespace of the definer was neither followed nor reported').toEqual([
      cannotFollow('app/zz-d.ts:2', 'ev[pick()]'),
      cannotFollow('app/zz-d.ts:3', 'register(ev)'),
      cannotFollow('app/zz-d.ts:5', 'm[pick()]'),
      cannotFollow('app/zz-d2.ts:3', "call(ev, 'fireAutomationEvent')"),
      cannotFollow('app/zz-d2.ts:4', 'export { ev };'),
      cannotFollow('app/zz-d2.ts:5', "export * as events from '@/lib/marketing/automation-events';"),
      cannotFollow('app/zz-d2.ts:6', "later = import('@/lib/marketing/automation-events').catch(() => null)"),
      cannotFollow('app/zz-d2.ts:8', 'remember(zz)'),
    ]);
  });

  // R6-AW-GUARD-CATCH-FINALLY. The reviewer's two files (zz-p1, zz-c) passed
  // at 095357766: only `.then` with a callback was read as the promise of the
  // module it is, and any other method of it as a member of the module, so
  // `.catch(...)` and `.finally(...)`, which resolve to the module again, took
  // it away unsaid. zz-p2 holds the rest of the class: `.then()` with no
  // callback, a method taken and not called, a callback that reads its
  // `arguments`, a method named by a string.
  it('follows a dynamic import through every promise chain, and reports the module wherever the chain passes it on', () => {
    const program = new Map<string, string>([
      ['lib/zz-a.ts', ALIAS_MODULE],
      ['app/zz-n.ts', CONTROL],
      ['app/zz-p1.ts', [
        "const mod = await import('@/lib/zz-a').catch(() => null);",
        'register(mod);',
        "const mod2 = await import('@/lib/zz-a').finally(() => {});",
        'register(mod2);',
      ].join('\n')],
      ['app/zz-c.ts', [
        "import('@/lib/zz-a').catch(() => null).then((m) => register(m));",
        "export const load = import('@/lib/zz-a').catch(() => null);",
      ].join('\n')],
      ['app/zz-p2.ts', [
        "register(import('@/lib/zz-a').then());",
        "const pending = import('@/lib/zz-a');",
        'register(pending.finally);',
        "import('@/lib/zz-a').then(function () { register(arguments[0]); });",
        "register(await import('@/lib/zz-a')['finally'](() => {}));",
        // Read in place at the end of a chain: followed to the call.
        "await import('@/lib/zz-a').catch(() => null).finally(() => {}).then((m) => m.fireIt(admin, { trigger: 'demo_started', email: null, subjectKey: 'p2' }));",
        'const { fireIt: go } = await pending.then().catch(() => null);',
        "await go(admin, { trigger: 'payment_completed', email: null, subjectKey: 'p3' });",
        // Thrown away: nothing takes it.
        "await import('@/lib/zz-a').finally(() => {});",
        "void import('@/lib/zz-a').catch(() => null);",
      ].join('\n')],
    ]);
    expect(literalsOf(program), 'a call at the end of a promise chain was not found').toEqual(['app/zz-n.ts:2', 'app/zz-p2.ts:6', 'app/zz-p2.ts:8']);
    expect(problemsOf(program), 'a module passed on down a promise chain was neither followed nor reported').toEqual([
      cannotFollow('app/zz-p1.ts:2', 'register(mod)'),
      cannotFollow('app/zz-p1.ts:4', 'register(mod2)'),
      cannotFollow('app/zz-c.ts:1', 'register(m)'),
      cannotFollow('app/zz-c.ts:2', "load = import('@/lib/zz-a').catch(() => null)"),
      cannotFollow('app/zz-p2.ts:1', "register(import('@/lib/zz-a').then())"),
      cannotFollow('app/zz-p2.ts:3', 'pending.finally'),
      cannotFollow('app/zz-p2.ts:4', "import('@/lib/zz-a').then(function () { register(arguments[0]); })"),
      cannotFollow('app/zz-p2.ts:5', "register(await import('@/lib/zz-a')['finally'](() => {}))"),
      firesDemoStarted('app/zz-p2.ts:6'),
    ]);
  });

  // R6-AW-GUARD-UNREAD-SOURCES-AND-REQUIRE, what is read. At 095357766 the
  // guard read .ts and .tsx under app/, lib/ and components/ only, and the
  // tree imports '@/lib/build-identity.mjs' and '@/shared/auth/refresh-fetch'
  // from there.
  it('reads every source the app can import, of every extension, and leaves out only the test suite, what is installed or generated, and type declarations', () => {
    // The tree as read: what the app imports from outside app/, lib/ and components/, and the files at the top.
    for (const file of ['lib/build-identity.mjs', 'lib/security/csp.mjs', 'shared/auth/refresh-fetch.ts', 'design/tokens.ts', 'held/api/cron/location-retention/route.ts',
      'middleware.ts', 'instrumentation.ts', 'next.config.mjs', 'public/sw.js', 'scripts/e2e-server-env.mjs', DEFINER]) {
      expect(sources.has(file), `${file} is not read`).toBe(true);
    }
    expect([...sources.keys()].filter((file) => file.startsWith('tests/') || file.endsWith('.d.ts'))).toEqual([]);
    // And every path as it would be read.
    const as = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, readAs(path)]));
    const app = ['shared/zz-x.ts', 'lib/zz-y.js', 'lib/zz-y.jsx', 'lib/zz-y.mjs', 'lib/zz-y.cjs', 'lib/zz-y.mts', 'lib/zz-y.cts', 'hooks/use-zz.tsx',
      'design/zz.ts', 'zz-at-the-top.mjs', 'held/zz/route.ts', 'public/zz.js', 'mobile/src/zz.ts', 'app/zz/page.tsx', 'app/.well-known/zz/route.ts'];
    expect(as(app)).toEqual(Object.fromEntries(app.map((path) => [path, 'app'])));
    const outside = ['scripts/zz.mjs', 'scripts/lib/zz.ts', 'mobile/scripts/zz.mjs', 'docs/zz/probe.mjs'];
    expect(as(outside)).toEqual(Object.fromEntries(outside.map((path) => [path, 'outside'])));
    const unread = ['tests/zz.test.ts', 'tests/helpers/zz.ts', 'node_modules/zz/index.js', 'lib/node_modules/zz.js', '.next/server/zz.js', '.claude/worktrees/zz/lib/zz.ts',
      'lib/zz.d.ts', 'lib/zz.json', 'app/zz.css'];
    expect(as(unread)).toEqual(Object.fromEntries(unread.map((path) => [path, null])));
    // localPath knows `@/` and relative paths only: hold the app to having no other way to name its own sources.
    const tsconfig = ts.parseConfigFileTextToJson('tsconfig.json', readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')).config;
    expect(tsconfig.compilerOptions.paths, 'tsconfig names its sources by a path localPath does not know').toEqual({ '@/*': ['./*'] });
    expect(tsconfig.compilerOptions.baseUrl, 'a baseUrl names sources by a bare path').toBeUndefined();
    expect(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).imports, 'package.json `imports` name sources by `#`').toBeUndefined();
    expect(sourceOf('next.config.mjs'), 'next.config.mjs aliases a path to a source').not.toMatch(/\balias\s*:|\.alias\b|resolveAlias|extensionAlias/);
  });

  // R6-AW-GUARD-UNREAD-SOURCES-AND-REQUIRE, the reviewer's first probe. With
  // shared/zz-x.ts and lib/zz-y.js not read, it passed at 095357766 with no
  // call and no problem: an import by a path no source answers was reported
  // only when it took a name some READ module exports the function under.
  it('follows the function out of every source the app can import, and reports an import by a path it reads no source for, whatever it takes', () => {
    const importer: [string, string] = ['app/zz-c.ts', [
      "import { fireIt } from '@/shared/zz-x';",
      "await fireIt(admin, { trigger: 'demo_started', email: null, subjectKey: 'x' });",
      "import { fireJs } from '@/lib/zz-y';",
      "await fireJs(admin, { trigger: 'demo_started', email: null, subjectKey: 'y' });",
      "import { fireMjs } from '../lib/zz-m.mjs';",
      "await fireMjs(admin, { trigger: 'demo_started', email: null, subjectKey: 'm' });",
      "import { helper } from '@/lib/zz-helper';",
      "import '@/lib/zz-side-effect';",
      "import type { Only } from '@/lib/zz-types';",
      "import { type AlsoOnly } from '@/lib/zz-types';",
    ].join('\n')];
    // Not read: every path that names no source is reported, whatever it takes; an import of types only loads nothing.
    expect(problemsOf(new Map([importer])), 'an import by a path that names no source was not reported').toEqual([
      unresolvedAt('app/zz-c.ts:1', "'@/shared/zz-x'"),
      unresolvedAt('app/zz-c.ts:3', "'@/lib/zz-y'"),
      unresolvedAt('app/zz-c.ts:5', "'../lib/zz-m.mjs'"),
      unresolvedAt('app/zz-c.ts:7', "'@/lib/zz-helper'"),
      unresolvedAt('app/zz-c.ts:8', "'@/lib/zz-side-effect'"),
    ]);
    // Read, in shared/ and as .js, .mjs and .cjs: followed to the calls, and a CommonJS export of the function reported.
    const program = new Map<string, string>([
      importer,
      ['shared/zz-x.ts', aliasModule('fireIt')],
      ['lib/zz-y.js', aliasModule('fireJs')],
      ['lib/zz-m.mjs', aliasModule('fireMjs')],
      ['lib/zz-helper.ts', 'export const helper = 1;'],
      ['lib/zz-side-effect.cjs', ["const events = require('./marketing/automation-events');", 'module.exports = { fireCjs: events.fireAutomationEvent };'].join('\n')],
      ['lib/zz-types.ts', 'export type Only = 1;\nexport type AlsoOnly = 2;'],
    ]);
    expect(literalsOf(program), 'a call of a name a .js, .mjs or shared/ module exports was not found').toEqual(['app/zz-c.ts:2', 'app/zz-c.ts:4', 'app/zz-c.ts:6']);
    expect(problemsOf(program)).toEqual([
      firesDemoStarted('app/zz-c.ts:2'),
      firesDemoStarted('app/zz-c.ts:4'),
      firesDemoStarted('app/zz-c.ts:6'),
      cannotFollow('lib/zz-side-effect.cjs:2', 'fireCjs: events.fireAutomationEvent'),
    ]);
    // Outside the app a name or a path that reaches the function is followed too, and a script an app source names is the app.
    const outside = new Map<string, string>([
      ['scripts/zz-s.mjs', [
        "import { fireAutomationEvent } from '../lib/marketing/automation-events.ts';",
        "await fireAutomationEvent(admin, { trigger: 'demo_started', email: null, subjectKey: 's' });",
        // The corner the header names: a script no app source names may load what it likes by a computed path.
        'await import(process.argv[2]);',
      ].join('\n')],
      ['app/zz-u.ts', "import { helper } from '@/scripts/zz-v.mjs';"],
      ['scripts/zz-v.mjs', ['export const helper = 1;', 'await import(process.argv[2]);'].join('\n')],
    ]);
    expect(problemsOf(outside)).toEqual([
      firesDemoStarted('scripts/zz-s.mjs:2'),
      unresolvedAt('scripts/zz-v.mjs:2', 'process.argv[2]'),
    ]);
  });

  // R6-AW-GUARD-UNREAD-SOURCES-AND-REQUIRE, the reviewer's second probe.
  // zz-r and zz-q passed at 095357766 beside the control: require() and
  // `import x = require()` were not read as imports, so their four calls of
  // demo_started were missed. zz-l holds the rest of the class: the module
  // passed on, and in the app every loader whose path is not written where
  // this guard reads it.
  it('reads require() and import x = require() as the imports they are, and reports a loader it cannot follow', () => {
    const program = new Map<string, string>([
      ['lib/zz-a.ts', ALIAS_MODULE],
      ['app/zz-n.ts', CONTROL],
      ['app/zz-r.ts', [
        "const m = require('@/lib/zz-a');",
        "await m.fireIt(admin, { trigger: 'demo_started', email: null, subjectKey: 'r1' });",
        "await require('@/lib/zz-a').fireIt(admin, { trigger: 'demo_started', email: null, subjectKey: 'r2' });",
        "const { fireIt: go } = require('../lib/zz-a');",
        "await go(admin, { trigger: 'demo_started', email: null, subjectKey: 'r3' });",
      ].join('\n')],
      ['app/zz-q.ts', ["import zz = require('@/lib/zz-a');", "await zz.fireIt(admin, { trigger: 'demo_started', email: null, subjectKey: 'q' });"].join('\n')],
      ['app/zz-l.ts', [
        "register(require('@/lib/zz-a'));",
        "export import again = require('@/lib/zz-a');",
        'const load = require;',
        'const late = require(name);',
        'const own = createRequire(import.meta.url);',
        'eval(code);',
        "const built = new Function('return 1');",
        'const context = import.meta.webpackContext(dir);',
        'const viaModule = module.require(path);',
        "const where = '@/lib/marketing/automation-events';",
        "new Worker(new URL('../lib/zz-a.ts', import.meta.url));",
        "import { createRequire as cr } from 'node:module';",
        'const { require: req } = module;',
        "const vm = await import('vm');",
        "import { fromTheTop } from '/lib/zz-a';",
        "const inline = await import('data:text/javascript,export default 1');",
        // A package, a URL beside this file, and a check against the constructor: nothing to say.
        "const crypto = require('crypto');",
        "const asset = new URL('./zz-asset.png', import.meta.url);",
        'const callable = handler instanceof Function;',
      ].join('\n')],
    ]);
    expect(literalsOf(program), 'a call through require() or import x = require() was not found').toEqual([
      'app/zz-n.ts:2', 'app/zz-r.ts:2', 'app/zz-r.ts:3', 'app/zz-r.ts:5', 'app/zz-q.ts:2',
    ]);
    expect(problemsOf(program), 'a require, or a loader, was neither followed nor reported').toEqual([
      firesDemoStarted('app/zz-r.ts:2'),
      firesDemoStarted('app/zz-r.ts:3'),
      firesDemoStarted('app/zz-r.ts:5'),
      firesDemoStarted('app/zz-q.ts:2'),
      cannotFollow('app/zz-l.ts:1', "register(require('@/lib/zz-a'))"),
      cannotFollow('app/zz-l.ts:2', "export import again = require('@/lib/zz-a');"),
      loaderAt('app/zz-l.ts:3', 'load = require'),
      unresolvedAt('app/zz-l.ts:4', 'name'),
      loaderAt('app/zz-l.ts:5', 'createRequire(import.meta.url)'),
      loaderAt('app/zz-l.ts:6', 'eval(code)'),
      loaderAt('app/zz-l.ts:7', "new Function('return 1')"),
      loaderAt('app/zz-l.ts:8', 'import.meta.webpackContext(dir)'),
      loaderAt('app/zz-l.ts:9', 'module.require(path)'),
      cannotFollow('app/zz-l.ts:10', "where = '@/lib/marketing/automation-events'"),
      cannotFollow('app/zz-l.ts:11', "new URL('../lib/zz-a.ts', import.meta.url)"),
      loaderAt('app/zz-l.ts:12', "import { createRequire as cr } from 'node:module';"),
      loaderAt('app/zz-l.ts:13', '{ require: req } = module'),
      loaderAt('app/zz-l.ts:14', "import('vm')"),
      unresolvedAt('app/zz-l.ts:15', "'/lib/zz-a'"),
      unresolvedAt('app/zz-l.ts:16', "'data:text/javascript,export default 1'"),
    ]);
  });

  // R7-AW-GUARD-TYPE-POSITION-VALUE. The reviewer's probe (zz-h, and zz-a
  // with zz-n) passed at 4a8facaed with no call and no problem beside the
  // control (zz-k): ts.isTypeNode counts an ExpressionWithTypeArguments as a
  // type, so every reference in a class's `extends` and in an instantiation
  // expression (`f<T>`) was taken for a type and dropped before it reached
  // `report`. An instantiation expression is not followed but reported, so
  // zz-a's export is reported where it is made, and zz-n's call of it needs
  // no following. zz-h's last lines hold the rest of the class: a call in a
  // class expression's `extends` is followed, and what is a type
  // (`implements`, an interface's `extends`, a type argument) still says
  // nothing.
  it('reads a class `extends` and an instantiation expression as the values they are, and still skips a type', () => {
    const program = new Map<string, string>([
      ['lib/zz-a.ts', [
        "import { fireAutomationEvent } from '@/lib/marketing/automation-events';",
        '// @ts-expect-error fireAutomationEvent takes no type arguments.',
        'export const fireIt = fireAutomationEvent<never>;',
      ].join('\n')],
      ['app/zz-n.ts', ["import { fireIt } from '@/lib/zz-a';", "await fireIt(admin, { trigger: 'demo_started', email: null, subjectKey: 'n' });"].join('\n')],
      ['app/zz-k.ts', ["import { fireAutomationEvent } from '@/lib/marketing/automation-events';", 'const K = withFire(fireAutomationEvent);'].join('\n')],
      ['app/zz-h.ts', [
        "import { fireAutomationEvent } from '@/lib/marketing/automation-events';",
        "import * as ev from '@/lib/marketing/automation-events';",
        'class A extends withFire(fireAutomationEvent) {}',
        'class B extends register(ev) {}',
        "class C extends load('@/lib/marketing/automation-events') {}",
        'class D extends createRequire(import.meta.url)(name) {}',
        'class E extends eval(code) {}',
        '// @ts-expect-error',
        'const go = fireAutomationEvent<never>;',
        "await go(admin, { trigger: 'demo_started', email: null, subjectKey: 'h1' });",
        '// @ts-expect-error',
        'const ns = ev<never>;',
        "await ns[pick()](admin, { trigger: 'demo_started', email: null, subjectKey: 'h2' });",
        // A call in a class expression's `extends`: followed to its trigger.
        "const Fired = class extends withResult(fireAutomationEvent(admin, { trigger: 'demo_started', email: null, subjectKey: 'h3' })) {};",
        // A type runs nothing: nothing to say.
        'interface Callable extends Function {}',
        'class Handler implements Function {}',
        'class Typed extends Base<typeof fireAutomationEvent, typeof ev> {}',
        'const typed = list<typeof fireAutomationEvent>;',
      ].join('\n')],
    ]);
    expect(literalsOf(program), 'a call in a class `extends` was not found').toEqual(['app/zz-h.ts:14']);
    expect(problemsOf(program), 'a value in a class `extends` or an instantiation expression was neither followed nor reported').toEqual([
      cannotFollow('lib/zz-a.ts:3', 'fireAutomationEvent<never>'),
      cannotFollow('app/zz-k.ts:2', 'withFire(fireAutomationEvent)'),
      cannotFollow('app/zz-h.ts:3', 'withFire(fireAutomationEvent)'),
      cannotFollow('app/zz-h.ts:4', 'register(ev)'),
      cannotFollow('app/zz-h.ts:5', "load('@/lib/marketing/automation-events')"),
      loaderAt('app/zz-h.ts:6', 'createRequire(import.meta.url)'),
      loaderAt('app/zz-h.ts:7', 'eval(code)'),
      cannotFollow('app/zz-h.ts:9', 'fireAutomationEvent<never>'),
      cannotFollow('app/zz-h.ts:12', 'ev<never>'),
      firesDemoStarted('app/zz-h.ts:14'),
    ]);
  });
});
