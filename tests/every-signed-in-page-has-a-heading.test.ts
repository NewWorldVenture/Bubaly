import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// MAIN-F-D05. Thirteen signed-in pages rendered no <h1>, eleven of them no
// heading at all, so a screen-reader user landing on Smart Home, Tax Vault or a
// child's wallet had nothing to navigate by and no statement of where they were.
// tests/marketing-page-has-one-h1.test.ts covers the public pages; this is the
// same property for the app.
//
// Static and conservative: a page counts as headed if it, a component it imports
// (two levels deep), or a layout between it and app/(app) contains an <h1> or a
// PageHeader (which renders one). A pure redirect renders nothing and is skipped.

const pages = execSync("git ls-files 'app/(app)/**/page.tsx'", { encoding: 'utf8' }).trim().split('\n');
const H1 = /<h1\b|<PageHeader\b/;

function resolve(spec: string, from: string): string | null {
  const base = spec.startsWith('@/') ? spec.slice(2) : spec.startsWith('.') ? from.replace(/[^/]+$/, '') + spec.replace(/^\.\//, '') : null;
  if (!base) return null;
  for (const ext of ['.tsx', '.ts', '/index.tsx']) if (existsSync(base + ext)) return base + ext;
  return null;
}

function headed(file: string | null, depth = 0, seen = new Set<string>()): boolean {
  if (!file || seen.has(file) || depth > 2) return false;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  if (H1.test(src)) return true;
  for (const m of src.matchAll(/from '((?:@\/components|\.)[^']+)'/g)) if (headed(resolve(m[1], file), depth + 1, seen)) return true;
  return false;
}

function layoutsAbove(page: string): string[] {
  const out: string[] = [];
  for (let d = page.replace(/\/page\.tsx$/, ''); d.length > 'app/(app)'.length; d = d.replace(/\/[^/]+$/, '')) {
    if (existsSync(`${d}/layout.tsx`)) out.push(`${d}/layout.tsx`);
  }
  return out;
}

const isPureRedirect = (src: string) => /^\s*(redirect|permanentRedirect)\(/m.test(src) && !/return\s*\(?\s*</.test(src);

describe('every signed-in page has a heading', () => {
  it('checks the real app (guards the guard)', () => {
    expect(pages.length).toBeGreaterThan(300);
  });

  // The opposite failure. Main's page audit (P-06) gave eleven single-use
  // modules a visible <h1> while this guard's fix gave the same eleven pages a
  // screen-reader <h1>, and both merged: each page read out two page titles. The
  // assistant's module drew an <h1> once a conversation started, under the
  // page's own. An integrated axe crawl found them; this holds the shape. A page
  // that supplies a screen-reader <h1> does so because its module draws none.
  it('a page\'s screen-reader <h1> is not stacked on a module that draws its own', () => {
    const stacked: string[] = [];
    for (const p of pages) {
      const src = readFileSync(p, 'utf8');
      if (!/<h1 className="sr-only"/.test(src)) continue;
      for (const m of src.matchAll(/from '(@\/components[^']+)'/g)) {
        const file = resolve(m[1], p);
        if (file && /<h1\b/.test(readFileSync(file, 'utf8'))) stacked.push(`${p} + ${file}`);
      }
    }
    expect(stacked, 'drop the page\'s sr-only <h1>, or make the module\'s heading an <h2>').toEqual([]);
  });

  it('no page renders without an <h1>', () => {
    const bare = pages.filter((p) => !isPureRedirect(readFileSync(p, 'utf8')) && !headed(p) && !layoutsAbove(p).some((l) => headed(l)));
    expect(bare, 'add a visible title as an <h1>, or <h1 className="sr-only"> when the design has none').toEqual([]);
  });

  // The static walk above counts an <h1> anywhere in a page's imports, so a page
  // whose only <h1> is on a screen it shows in ONE state passes. /wallet/activity
  // imported the wallet activation screen, which has one; once the wallet was
  // active the page drew none (P-35, found by axe on an activated wallet).
  it('a wallet page draws its own <h1> once the wallet is active, not only the activation screen\'s', () => {
    for (const view of ['components/wallet/activity-view.tsx', 'components/wallet/send-money-view.tsx', 'components/wallet/child-detail-view.tsx']) {
      expect(readFileSync(view, 'utf8'), view).toMatch(/<h1\b/);
    }
  });
});
