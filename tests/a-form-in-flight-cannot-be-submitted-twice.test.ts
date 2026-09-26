// A server-action form stays interactive while its action runs.
//
// `<form action={serverAction}>` does not disable itself, and a server action is
// not idempotent unless someone wrote it to be. Across the admin marketing
// console that meant two campaigns, two segments, two blog entries from one
// impatient double-click.
//
// Two things the original finding did not have, both found by re-measuring:
//
//  - It said all 89 were under `app/(app)/admin/marketing/`. SEVEN files are not,
//    and four of those are family-facing: a purchase-answer retry (a second model
//    call), a new mission, the social inbox and the media library.
//  - 34 of the 89 had NO `<button type="submit">` at all. They used a bare
//    `<button>`, which inside a form IS a submit button by HTML default — so the
//    defect was there and a scan for the explicit spelling could not see it. Any
//    of those a developer meant as a non-submit was already submitting.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const PENDING = /useFormStatus|pending|isPending|disabled|SubmitButton/;

/** Mutating action forms whose submit control does not know the form is in flight. */
function unguardedForms(): string[] {
  const hits: string[] = [];
  const files = execSync("git ls-files 'app/**/*.tsx' 'components/**/*.tsx'", { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!/<form\b/.test(source)) continue;
    const src = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node) => {
      if (ts.isJsxElement(n) && n.openingElement.tagName.getText() === 'form') {
        const open = n.openingElement.getText();
        // A GET form re-runs a query and writes nothing, so a second submit
        // costs nothing — `components/admin/filter-bar.tsx` is the whole of this
        // case and it is a filter bar. Excluded on what it DOES, not by name.
        const mutating = /action=\{/.test(open) && !/method="GET"/i.test(open);
        if (mutating && !PENDING.test(n.getText())) {
          hits.push(`${file}:${source.slice(0, n.getStart()).split('\n').length}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(src, visit);
  }
  return hits.sort();
}

describe('a form in flight cannot be submitted twice', () => {
  it('every mutating action form has a submit control that knows', () => {
    expect(unguardedForms(), 'this form can be submitted again while it is running').toEqual([]);
  });

  it('the primitive reads the status of the form it is inside', () => {
    // Why it is its own client component rather than a hook in the page:
    // useFormStatus returns pending:false when called by the component that
    // renders the <form> itself, so a hook at page level would always say ready.
    const source = readFileSync('components/ui/submit-button.tsx', 'utf8');
    expect(source).toMatch(/^'use client';/);
    expect(source).toContain("useFormStatus");
    expect(source).toMatch(/disabled=\{pending \|\| disabled\}/);
    // Announced, not just visually inert.
    expect(source).toContain('aria-busy');
  });

  it('the hook is resolved once at module load, not imported by name', () => {
    // Not a style choice. package.json declares react-dom ^18.3.1, which has no
    // useFormStatus — it arrived in React 19. Production works because Next 15
    // bundles its own React 19 and aliases `react-dom` to it for App Router
    // code; vitest does not, and resolves the hoisted 18.3.1. A direct
    // `import { useFormStatus } from 'react-dom'` therefore compiles, ships
    // correctly, and throws "useFormStatus is not a function" in every test that
    // renders a form — which is exactly how this was found.
    //
    // Resolving once at module load keeps the call unconditional within a build
    // and degrades to a plain submit where the hook does not exist. Delete this
    // when the react-dom version split is closed, and not before.
    const source = readFileSync('components/ui/submit-button.tsx', 'utf8');
    expect(source).not.toMatch(/import \{[^}]*useFormStatus[^}]*\} from 'react-dom'/);
    expect(source).toMatch(/const formStatus = \(ReactDOM as/);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['react-dom'], 'if react-dom is 19 now, this guard and the shim can go').toMatch(/\^18\./);
  });

  it('the scan is not blind', () => {
    // Planted in both shapes the defect took, because the implicit one is what a
    // scan for `type="submit"` could not see.
    for (const button of ['<button type="submit">Go</button>', '<button>Go</button>']) {
      const planted = `export default function P() { return <form action={a}>${button}</form>; }`;
      const src = ts.createSourceFile('p.tsx', planted, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let seen = false;
      const visit = (n: ts.Node) => {
        if (ts.isJsxElement(n) && n.openingElement.tagName.getText() === 'form'
          && /action=\{/.test(n.openingElement.getText()) && !PENDING.test(n.getText())) seen = true;
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(src, visit);
      expect(seen, button).toBe(true);
    }
  });

  it('the family-facing ones the finding placed in the admin console are covered', () => {
    // Named, because "all of them are behind the admin gate" was the reason the
    // finding was filed LOW and it was not quite true.
    for (const file of [
      'app/(app)/dashboard/assistant/purchases/[approvalId]/page.tsx',
      'app/(app)/missions/new/page.tsx',
      'app/(app)/dashboard/social/inbox/page.tsx',
      'app/(app)/dashboard/social/media-library/page.tsx',
      'components/sync/provider-controls.tsx',
    ]) expect(readFileSync(file, 'utf8'), file).toContain('SubmitButton');
  });
});
