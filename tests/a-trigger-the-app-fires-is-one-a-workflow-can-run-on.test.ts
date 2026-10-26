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
// reads every call of fireAutomationEvent under app/, lib/ and components/,
// under whatever name a file imports it by from another, and holds the
// trigger each one passes to the list, so a newly fired trigger cannot drift
// out of it again; and holds the list to the callers, so a trigger nothing
// fires (demo_started) cannot drift in.

const ROOT = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(path);
  }
  return out;
}

type Trigger = { literal: string } | { computed: string } | { unreadable: string } | { unfollowed: string } | { unresolved: string };
type Call = { file: string; line: number; trigger: Trigger };

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
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
 * The module that defines it, always one this guard knows: it exports the
 * function under its own name, which is followed wherever it goes. A planted
 * program that imports it without carrying its source still resolves it.
 */
const DEFINER = 'lib/marketing/automation-events.ts';

/** The outermost expression a reference sits in, through parentheses, casts and `!`. */
function outermost(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e.parent) || ts.isAsExpression(e.parent) || ts.isSatisfiesExpression(e.parent) || ts.isNonNullExpression(e.parent)) e = e.parent;
  return e;
}

function inTypePosition(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) if (ts.isTypeNode(p)) return true;
  return false;
}

/** Whether an identifier is a name being declared here (an import, a binding, a declaration, a key), not a use. */
function declares(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
  if (ts.isBindingElement(parent)) return parent.name === node || parent.propertyName === node;
  return (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)
    || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)) && parent.name === node;
}

/** Where something sits in a source, and its text, for a problem. */
type Site = { line: number; text: string };
/** The names each module exports the function under (an alias, a re-export, a default), each with where it does. */
type FireExports = ReadonlyMap<string, ReadonlyMap<string, Site>>;
/** One source read: its calls, the names it exports the function under, and the `<module>#<name>` it takes from another (`#*`, all of them). */
type Analysis = { calls: Call[]; exports: Map<string, Site>; imports: Set<string> };

/** The path an import of the app's own names, from the root: `@/x` (tsconfig `paths`) or a relative path. A package has none. */
function localPath(from: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return specifier.slice(2);
  if (specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')) return posix.join(posix.dirname(from), specifier);
  return null;
}

/**
 * The source an import names, among those read, tried as the bundler does:
 * bare, with `.ts` or `.tsx`, or as a folder's index; `x.js` (or `.jsx`) as
 * the `x.ts` it is built from, and `x/` as the folder's index only.
 * R5-AW-GUARD-NAMESPACE-PASSED-ON: the last two were no source before, so a
 * file that took an exported name by either was not read as taking it.
 */
function resolveModule(from: string, specifier: string, known: ReadonlySet<string>): string | null {
  const path = localPath(from, specifier);
  if (path === null) return null;
  const candidates = path.endsWith('/') ? [`${path}index.ts`, `${path}index.tsx`]
    : /\.jsx?$/.test(path) ? [path.replace(/\.jsx?$/, '.ts'), path.replace(/\.jsx?$/, '.tsx')]
      : [path, `${path}.ts`, `${path}.tsx`, `${path}/index.ts`, `${path}/index.tsx`];
  return candidates.find((candidate) => known.has(candidate)) ?? null;
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

/**
 * Every call of fireAutomationEvent in one source, with the trigger it
 * passes, every other use of it, which this guard cannot follow, and the
 * names the source exports it under.
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
 * and a `.then` callback's parameter, and reported anywhere else. And an
 * import by a path that names no source read here (a file it does not read,
 * a computed path) is reported when it may take a name some module exports
 * the function under.
 */
function analyse(file: string, ast: ts.SourceFile, exported: FireExports, known: ReadonlySet<string>): Analysis {
  const names = new Set<string>([FIRE]);
  /** The member names the function goes by on a namespace this source reads. */
  const members = new Set<string>([FIRE]);
  /** The local names of a namespace of a module that exports the function under a name, and the dynamic imports of one. */
  const namespaces = new Set<string>();
  const namespaceImports = new Set<ts.CallExpression>();
  /** Every name a module exports the function under. */
  const aliases = new Set([...exported.values()].flatMap((their) => [...their.keys()]));
  const imports = new Set<string>();
  const exports = new Map<string, Site>();
  const calls: Call[] = [];
  const lineOf = (node: ts.Node) => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
  const site = (node: ts.Node): Site => ({ line: lineOf(node), text: node.getText(ast) });
  const theirs = (specifier: ts.Expression | undefined) => {
    const target = specifier && ts.isStringLiteralLike(specifier) ? resolveModule(file, specifier.text, known) : null;
    return { target, names: target ? exported.get(target) : undefined };
  };
  /**
   * Report an import by a path no source here answers when what it takes
   * (`*` for every name) may be the function under a name a module exports
   * it by. Its own name is followed wherever it comes from.
   */
  const unresolved = (specifier: ts.Expression | undefined, takes: readonly string[], at: ts.Node) => {
    if (!specifier) return;
    if (ts.isStringLiteralLike(specifier)) {
      if (localPath(file, specifier.text) === null || NOT_A_MODULE.test(specifier.text) || resolveModule(file, specifier.text, known)) return;
    }
    if (takes.some((name) => (name === '*' ? aliases.size > 0 : name !== FIRE && aliases.has(name)))) {
      calls.push({ file, line: lineOf(at), trigger: { unresolved: specifier.getText(ast) } });
    }
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
  // here, and what it passes on.
  const readModules = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const { target, names: their } = theirs(node.moduleSpecifier);
      const clause = node.importClause;
      if (clause?.name && their?.has('default')) { names.add(clause.name.text); imports.add(`${target}#default`); }
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings) && their) {
        for (const name of their.keys()) members.add(name);
        imports.add(`${target}#*`);
        namespaces.add(bindings.name.text);
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          const imported = (specifier.propertyName ?? specifier.name).text;
          if (imported === FIRE || their?.has(imported)) names.add(specifier.name.text);
          if (their?.has(imported)) imports.add(`${target}#${imported}`);
        }
      }
      unresolved(node.moduleSpecifier, [
        ...(clause?.name ? ['default'] : []),
        ...(bindings && ts.isNamespaceImport(bindings) ? ['*'] : []),
        ...(bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((s) => !s.isTypeOnly).map((s) => (s.propertyName ?? s.name).text) : []),
      ], node);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const { target, names: their } = theirs(node.arguments[0]);
      if (their) { for (const name of their.keys()) members.add(name); imports.add(`${target}#*`); namespaceImports.add(node); }
      unresolved(node.arguments[0], ['*'], node);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      const { target, names: their } = theirs(node.moduleSpecifier);
      const clause = node.exportClause;
      unresolved(node.moduleSpecifier, clause && ts.isNamedExports(clause)
        ? clause.elements.filter((s) => !s.isTypeOnly).map((s) => (s.propertyName ?? s.name).text) : ['*'], node);
      if (!clause) {
        // `export * from`: every name it exports the function under but the default.
        for (const name of their?.keys() ?? []) {
          if (name === 'default') continue;
          exports.set(name, site(node));
          imports.add(`${target}#${name}`);
        }
      } else if (ts.isNamespaceExport(clause)) {
        // `export * as ns from`: a namespace inside a namespace, not followed.
        if (their) { calls.push({ file, line: lineOf(node), trigger: { unfollowed: node.getText(ast) } }); imports.add(`${target}#*`); }
      } else {
        for (const specifier of clause.elements) {
          const imported = (specifier.propertyName ?? specifier.name).text;
          if (imported === FIRE || their?.has(imported)) exports.set(specifier.name.text, site(specifier));
          if (their?.has(imported)) imports.add(`${target}#${imported}`);
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

  /** Whether a node is such a namespace here: a dynamic import of the module, or a use of a name it goes by. */
  const isNamespace = (node: ts.Node): node is ts.Expression => {
    if (ts.isCallExpression(node)) return namespaceImports.has(node);
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
  /** What is done with a namespace: read through a member or a destructure (null), given another local name, or taken where this guard does not follow it. */
  const namespaceUse = (node: ts.Expression): { alias: string } | { unfollowed: ts.Node } | null => {
    let outer = node;
    while (ts.isParenthesizedExpression(outer.parent) || ts.isAsExpression(outer.parent) || ts.isSatisfiesExpression(outer.parent)
      || ts.isNonNullExpression(outer.parent) || ts.isAwaitExpression(outer.parent)) outer = outer.parent;
    const parent = outer.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === outer) {
      // `import(...).then((m) => ...)`: the module is the callback's first parameter.
      const call = parent.parent;
      if (parent.name.text !== 'then' || !ts.isCallExpression(call) || call.expression !== parent || call.arguments.length === 0) return null;
      const callback = call.arguments[0];
      if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return { unfollowed: call };
      const param = callback.parameters[0];
      if (!param) return null;
      if (param.dotDotDotToken) return { unfollowed: call };
      if (ts.isIdentifier(param.name)) return { alias: param.name.text };
      return namesItsKeys(param.name) ? null : { unfollowed: call };
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === outer) {
      return ts.isStringLiteralLike(parent.argumentExpression) ? null : { unfollowed: parent };
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === outer) {
      if (ts.isIdentifier(parent.name)) return inExportedStatement(parent) ? { unfollowed: parent } : { alias: parent.name.text };
      return namesItsKeys(parent.name) ? null : { unfollowed: parent };
    }
    // Passed, returned, stored or exported: an export or an object it sits in is read whole.
    if (ts.isExportSpecifier(parent)) return { unfollowed: parent.parent.parent };
    if (ts.isShorthandPropertyAssignment(parent) || ts.isSpreadAssignment(parent)) return { unfollowed: parent.parent };
    return { unfollowed: parent };
  };
  // The names a namespace goes by, to a fixed point (`const b = a;`, `.then((m) => ...)`).
  for (let size = -1; size !== namespaces.size;) {
    size = namespaces.size;
    const collect = (node: ts.Node) => {
      const use = isNamespace(node) ? namespaceUse(node) : null;
      if (use && 'alias' in use) namespaces.add(use.alias);
      ts.forEachChild(node, collect);
    };
    collect(ast);
  }

  const visit = (node: ts.Node) => {
    if (isNamespace(node)) {
      const use = namespaceUse(node);
      if (use && 'unfollowed' in use) calls.push({ file, line: lineOf(node), trigger: { unfollowed: use.unfollowed.getText(ast) } });
    }
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
        calls.push({ file, line: lineOf(outer), trigger: { unfollowed: parent.getText(ast) } });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { calls, exports, imports };
}

/**
 * Every call of fireAutomationEvent across a set of sources, and every use
 * this guard cannot follow, in file order and by line.
 *
 * The names each module exports the function under are worked out to a
 * fixed point, since one module can pass on another's (a barrel, a
 * re-export of a re-export). An export that no source read here takes is
 * reported: whatever calls it is somewhere this guard does not read.
 */
function programCalls(sources: ReadonlyMap<string, string>): Call[] {
  const known = new Set([...sources.keys(), DEFINER]);
  const asts = [...sources].map(([file, source]) => [file, parse(file, source)] as const);
  let exported: FireExports = new Map();
  let analyses: [string, Analysis][];
  for (let size = 0; ;) {
    analyses = asts.map(([file, ast]) => [file, analyse(file, ast, exported, known)]);
    exported = new Map(analyses.filter(([, a]) => a.exports.size > 0).map(([file, a]) => [file, a.exports]));
    const found = [...exported.values()].reduce((n, names) => n + names.size, 0);
    if (found === size) break;
    size = found;
  }
  const taken = new Set(analyses.flatMap(([, a]) => [...a.imports]));
  return analyses.flatMap(([file, { calls, exports }]) => {
    const untaken = [...exports].filter(([name]) => !taken.has(`${file}#${name}`) && !taken.has(`${file}#*`))
      .map(([, at]): Call => ({ file, line: at.line, trigger: { unfollowed: at.text } }));
    return [...calls, ...untaken].sort((a, b) => a.line - b.line);
  });
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

// components/ too: a server component imports from lib/ as a page does.
const files = ['app', 'lib', 'components'].flatMap((dir) => walk(join(ROOT, dir)));
const sources = new Map(files.map((path) => [relative(ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8')]));
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
        // Not a name any module exports the function under, or not a module: nothing to say.
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
});
