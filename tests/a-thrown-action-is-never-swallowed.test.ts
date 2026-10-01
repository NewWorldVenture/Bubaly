import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * No client awaits a throwing server action and drops the reason on the floor.
 *
 * The auto and home sections are eleven near-identical clients built on actions
 * that fail by THROWING a translated Error (`saveRow(..., 'Could not save that
 * policy.')`, `softDelete`, `requireUserContext`). Every one of them awaited
 * bare inside a transition:
 *
 *     start(async () => { await deletePolicyAction(p.id); })
 *     <form action={(fd) => start(async () => { await savePolicyAction(fd); setOpen(false); })}>
 *
 * so a refusal threw past everything after it. The modal stayed open, the
 * spinner never cleared, and nothing was said — while the reason sat in the
 * thrown Error, already in the reader's language.
 *
 * `useActionError` catches and keeps that message and reports whether the
 * action got through, so the caller can decide what to close; `<ActionError>`
 * renders it next to the thing that failed. It is not a toast on purpose:
 * these components render on their own in tests with no <ToastProvider> above
 * them, and a toast would turn a failed save into a crash.
 */

const CLIENTS = [
  'components/auto/insurance-client.tsx',
  'components/auto/licenses-client.tsx',
  'components/auto/registration-client.tsx',
  'components/auto/rentals-client.tsx',
  'components/auto/service-client.tsx',
  'components/auto/vehicles-client.tsx',
  'components/home/pros-client.tsx',
  'components/home/service-client.tsx',
  'components/home/warranties-client.tsx',
  'components/app/app-shell.tsx',
];

/** `start(async () => { await someAction(...) })` with no `run(` around it. */
const BARE_AWAIT = /start\w*\(async \(\) => \{[^}]*await (?!run\()\w+Action\(/g;

function bulkIssueFunction(source: string) {
  const file = ts.createSourceFile('money-cards-view.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = file.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'MoneyCardsView');
  const bulk = component?.body?.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'issueAllVirtual');
  if (!bulk?.body) throw new Error('Missing MoneyCardsView.issueAllVirtual body');
  return { file, bulk, body: bulk.body };
}

function expectBulkIssueContract(source: string) {
  const { file, bulk, body } = bulkIssueFunction(source);
  const claim = body.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find(node => node.initializer && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'claimPending');
  const releaseName = claim && ts.isIdentifier(claim.name) ? claim.name.text : null;
  expect(releaseName, 'bulk must acquire its own pending release').not.toBeNull();
  const work = body.statements.find(ts.isTryStatement);
  expect(work?.tryBlock.getText(file)).toMatch(/await issueCardAction\(/);
  // Sibling handlers also release in finally. Only this loop's own cleanup
  // counts; a comment, deferred callback, or release on the success path does not.
  expect(work?.finallyBlock?.statements.some(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === releaseName && node.expression.arguments.length === 0),
  'bulk must invoke its claimed release directly in finally').toBe(true);

  const code = bulk.getText(file);
  // The count actually issued, not the count intended; singular and plural.
  expect(code).toMatch(/if \(issued > 0\) \{\s*success\(issued === 1[\s\S]{0,160}\{ count: issued \}/);
  expect(work?.tryBlock.getText(file)).toMatch(/if \(!res.ok\) failures.push\(res.error \|\| t\('globalError.somethingWentWrong'\)\);\s*else issued \+= 1;/);
  expect(work?.catchClause?.getText(file)).toContain("failures.push(err instanceof Error && err.message ? err.message : t('globalError.somethingWentWrong'))");
  expect(code).toContain('if (failures.length > 0) toastError(failures[0]);');
}

describe('a thrown server action is reported to the person who caused it', () => {
  for (const file of CLIENTS) {
    const source = readFileSync(file, 'utf8');

    it(`${file.split('/').pop()} routes its actions through run()`, () => {
      expect(source.match(BARE_AWAIT) ?? [], `${file}: an action is awaited bare`).toEqual([]);
      expect(source).toContain('useActionError');
    });

    it(`${file.split('/').pop()} renders the message it captures`, () => {
      // Capturing without rendering is the same silence with more steps.
      expect(source).toMatch(/<ActionError message=\{\w+\}/);
    });
  }

  it('gates the "close the modal" step on the action succeeding', () => {
    // The save handlers closed their modal unconditionally; a refusal has to
    // leave the form open with the reason on it.
    const insurance = readFileSync('components/auto/insurance-client.tsx', 'utf8');
    expect(insurance).toMatch(/if \(await run\(\(\) => savePolicyAction\(fd\)\)\) setOpen\(false\)/);
  });

  it('issuing cards in a loop reports how many actually issued', () => {
    // money-cards-view counted the children it MEANT to issue for, then threw
    // part-way and told nobody; the toast still named the full number.
    const cards = readFileSync('components/wallet/money-cards-view.tsx', 'utf8');
    expectBulkIssueContract(cards);
  });

  for (const [name, replacement] of [
    ['absent cleanup', 'finally {}'],
    ['cleanup after finally', 'finally {}\n    release();'],
    ['comment-only cleanup', 'finally { /* release(); */ }'],
    ['uncalled cleanup callback', 'finally { const cleanup = () => release(); }'],
  ]) {
    it(`rejects bulk ${name} even while sibling handlers still release`, () => {
      const cards = readFileSync('components/wallet/money-cards-view.tsx', 'utf8');
      const { file, bulk } = bulkIssueFunction(cards);
      const original = bulk.getText(file);
      const changed = original.replace(/finally \{\s*release\(\);\s*\}/, replacement);
      expect(changed).not.toBe(original);
      const mutant = cards.slice(0, bulk.getStart(file)) + changed + cards.slice(bulk.end);
      expect(mutant).toMatch(/finally \{\s*release\(\);\s*\}/);
      expect(() => expectBulkIssueContract(mutant)).toThrow('bulk must invoke its claimed release directly in finally');
    });
  }

  it('falls back to a message that exists in every locale', () => {
    const helper = readFileSync('components/ui/action-error.tsx', 'utf8');
    expect(helper).toContain("t('globalError.somethingWentWrong')");
    for (const locale of ['en-US', 'nl-NL', 'fr-FR', 'de-DE', 'es-ES', 'it-IT', 'pt-PT']) {
      const messages = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8'));
      expect(messages['globalError.somethingWentWrong'], locale).toBeTruthy();
    }
  });
});
