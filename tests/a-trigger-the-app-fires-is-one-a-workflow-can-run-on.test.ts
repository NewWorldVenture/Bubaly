import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
// reads every call of fireAutomationEvent under app/ and lib/ and holds the
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

type Trigger = { literal: string } | { computed: string } | { unreadable: string } | { unfollowed: string };
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

/**
 * Every call of fireAutomationEvent in one source, with the trigger it
 * passes, and every other use of it, which this guard cannot follow.
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
 * argument, put in an object, re-exported, assigned, `.call`) is reported,
 * because the trigger such a use ends up firing is not in this source.
 */
function fireCalls(file: string, source: string): Call[] {
  const ast = parse(file, source);
  const names = new Set<string>([FIRE]);
  const isMember = (node: ts.Node): node is ts.Expression =>
    (ts.isPropertyAccessExpression(node) && node.name.text === FIRE)
    || (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === FIRE);
  const isFire = (expression: ts.Expression): boolean => {
    const e = unwrap(expression);
    return (ts.isIdentifier(e) && names.has(e.text)) || isMember(e);
  };

  // The names it goes by, to a fixed point (`const a = fire; const b = a;`).
  for (let size = -1; size !== names.size;) {
    size = names.size;
    const collect = (node: ts.Node) => {
      if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === FIRE) names.add(node.name.text);
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === FIRE) names.add(node.name.text);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isFire(node.initializer)) names.add(node.name.text);
      ts.forEachChild(node, collect);
    };
    collect(ast);
  }

  const calls: Call[] = [];
  const lineOf = (node: ts.Node) => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
  const visit = (node: ts.Node) => {
    const reference = isMember(node) ? node
      : ts.isIdentifier(node) && names.has(node.text) && !declares(node) && !inTypePosition(node) ? node : null;
    if (reference) {
      const outer = outermost(reference);
      const parent = outer.parent;
      if (ts.isCallExpression(parent) && parent.expression === outer) {
        calls.push({ file, line: lineOf(parent), trigger: triggerOf(parent.arguments[1], ast) });
      } else if (!(ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isIdentifier(parent.name))) {
        // `const fire = fireAutomationEvent` is an alias, followed above; nothing else is.
        calls.push({ file, line: lineOf(outer), trigger: { unfollowed: parent.getText(ast) } });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return calls;
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

const files = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))];
const sources = new Map(files.map((path) => [relative(ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8')]));
const calls = [...sources].flatMap(([file, source]) => fireCalls(file, source));
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
});
