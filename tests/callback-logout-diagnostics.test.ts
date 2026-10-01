import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./e2e/callback-admission.spec.ts', import.meta.url), 'utf8');
const title = 'real emailed recovery completes PKCE and the saved password works after production logout';
const steps = ['account-menu', 'sign-out', 'confirmation', 'redirect-check', 'cookie-check'] as const;
type Step = typeof steps[number];
const phases = ['logout-start', ...steps.flatMap(step => [`logout-${step}-start`, `logout-${step}-complete`]), 'logout-complete'];

function extract(text: string) {
  const ast = ts.createSourceFile('callback-admission.spec.ts', text, ts.ScriptTarget.Latest, true);
  let body: ts.Block | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === title) {
      const callback = node.arguments[1];
      assert.ok(ts.isArrowFunction(callback) && ts.isBlock(callback.body));
      body = callback.body;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(body);
  const reporter = body.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === 'report'));
  const operation = body.statements.find(ts.isTryStatement);
  assert.ok(reporter && operation);
  const reportPhase = (node: ts.Statement) => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'report' && ts.isStringLiteral(node.expression.arguments[0])
    ? node.expression.arguments[0].text : undefined;
  const start = operation.tryBlock.statements.findIndex(node => reportPhase(node) === 'logout-start');
  const end = operation.tryBlock.statements.findIndex(node => reportPhase(node) === 'logout-complete');
  assert.ok(start >= 0 && end > start);
  const statements = operation.tryBlock.statements.slice(start, end + 1);
  function allowlistedCalls(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'report') {
      assert.ok(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
        && phases.includes(node.arguments[0].text), 'Logout diagnostics must use one allowlisted literal phase only');
    }
    ts.forEachChild(node, allowlistedCalls);
  }
  statements.forEach(allowlistedCalls);
  return `${reporter.getText(ast)}\nglobalThis.run = async () => {\n${statements.map(node => node.getText(ast)).join('\n')}\n};`;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Execute only the actual reporter and logout statements with in-memory doubles.
// The E2E module, browser, authentication fixture and provider helpers are never imported.
function fixture(text: string, held?: Step, failed?: Step, loggerThrows = false) {
  const entered = deferred(), release = deferred();
  const operations: Step[] = [];
  const records: Array<Record<string, unknown>> = [];
  const failure = new Error('Synthetic operation failure');
  const act = async (step: Step) => {
    operations.push(step);
    if (step === held) { entered.resolve(); await release.promise; }
    if (step === failed) throw failure;
  };
  const page = {
    getByRole(role: string, options?: { name: string; exact: boolean }) {
      if (role === 'dialog') return { getByRole: () => ({ click: () => act('confirmation') }) };
      assert.equal(role, 'button');
      assert.equal(options?.exact, true);
      assert.ok(options?.name === 'Account menu' || options?.name === 'Sign out');
      return { click: () => act(options.name === 'Account menu' ? 'account-menu' : 'sign-out') };
    },
    url: () => 'https://synthetic.invalid/login?token=SYNTHETIC_PRIVATE_TOKEN',
  };
  const assertion = Object.assign((value: unknown) => ({ toBe: (expected: unknown) => assert.equal(value, expected) }), {
    poll: (read: () => unknown) => ({ toBe: async (expected: unknown) => {
      await act('redirect-check');
      assert.equal(read(), expected);
    } }),
  });
  const sandbox = {
    page, context: { cookies: async () => { await act('cookie-check'); return ['SYNTHETIC_PRIVATE_COOKIE']; } },
    authCookies: () => [], authCookieName: () => 'synthetic-cookie-name', provider: 'synthetic-provider',
    expect: assertion, URL, startedAt: 10, performance: { now: () => 22.6 },
    testInfo: { timeout: 120000, retry: 1, project: { name: 'synthetic-project' }, workerIndex: 3, status: 'passed' },
    console: { log: (prefix: string, payload: string) => {
      if (loggerThrows) throw new Error('Synthetic logger failure');
      assert.equal(prefix, '[callback-admission-recovery]');
      records.push(JSON.parse(payload));
    } },
    run: undefined as unknown as () => Promise<void>,
  };
  const compiled = ts.transpileModule(extract(text), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  runInNewContext(compiled.outputText, sandbox, { timeout: 1000 });
  return { ...sandbox, entered, release, operations, records, failure };
}

async function assertBoundary(text: string, step: Step) {
  const harness = fixture(text, step);
  const execution = harness.run();
  try {
    await harness.entered.promise;
    const index = steps.indexOf(step);
    assert.deepEqual(harness.operations, steps.slice(0, index + 1));
    assert.deepEqual(harness.records.map(record => record.phase), phases.slice(0, index * 2 + 2));
  } finally {
    harness.release.resolve();
    await execution;
  }
  expect(harness.operations).toEqual(steps);
  expect(harness.records).toEqual(phases.map(phase => ({
    phase, elapsedMs: 13, timeoutMs: 120000, retry: 1, project: 'synthetic-project', workerIndex: 3, status: 'passed',
  })));
}

describe('recovery logout diagnostic boundaries', () => {
  it.each(steps)('brackets the pending %s operation without logging private state', async step => {
    await assertBoundary(source, step);
  });

  it.each(steps)('leaves %s as the last started operation when it rejects', async step => {
    const harness = fixture(source, undefined, step);
    await expect(harness.run()).rejects.toBe(harness.failure);
    const index = steps.indexOf(step);
    expect(harness.operations).toEqual(steps.slice(0, index + 1));
    expect(harness.records.map(record => record.phase)).toEqual(phases.slice(0, index * 2 + 2));
  });

  it('does not change logout when the diagnostic logger throws', async () => {
    const harness = fixture(source, undefined, undefined, true);
    await expect(harness.run()).resolves.toBeUndefined();
    expect(harness.operations).toEqual(steps);
  });

  it('detects a missing start marker', async () => {
    const mutant = source.replace("report('logout-account-menu-start');", '');
    expect(mutant).not.toBe(source);
    await expect(assertBoundary(mutant, 'account-menu')).rejects.toBeInstanceOf(assert.AssertionError);
  });

  it('detects a completion marker moved before its awaited operation', async () => {
    const mutant = source.replace("report('logout-account-menu-complete');", '')
      .replace("report('logout-account-menu-start');", "report('logout-account-menu-start'); report('logout-account-menu-complete');");
    expect(mutant).not.toBe(source);
    await expect(assertBoundary(mutant, 'account-menu')).rejects.toBeInstanceOf(assert.AssertionError);
  });

  it.each([
    "report(page.url());",
    "report('logout-account-menu-start', { url: page.url() });",
    "report('logout-unapproved-label');",
  ])('refuses an unsafe or unapproved diagnostic call: %s', replacement => {
    const mutant = source.replace("report('logout-account-menu-start');", replacement);
    expect(mutant).not.toBe(source);
    expect(() => extract(mutant)).toThrow('Logout diagnostics must use one allowlisted literal phase only');
  });
});
