import fs from 'node:fs';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// I18N-011, mounted: the real LocaleProvider, ToastProvider, Field and
// ActionError, with React, in a browser page (no app server: every request is
// answered by the fixture). A refusal written while the reader is German must
// be German; the same toast, field and ActionError, still holding it, must turn
// French when the reader switches to French; and a sentence written on the
// server (English) must follow whichever provider receives it, a nested one
// included, without leaning on the provider that registered last.

const { react, reactDom } = reactBrowserScripts('development');
const sources = Object.fromEntries([
  'components/i18n/locale-provider.tsx', 'components/ui/toast.tsx', 'components/ui/input.tsx', 'components/ui/action-error.tsx',
  'lib/supabase/errors.ts', 'lib/i18n/locales.ts', 'lib/i18n/translate.ts', 'lib/time/zoned.ts', 'lib/actions/refusal.ts',
  'lib/hooks/use-media-query.ts',
].map((file) => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText]));

/** The keys these components read, from the real catalogues. */
function catalogue(locale: string): Record<string, string> {
  const all = JSON.parse(fs.readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
  return Object.fromEntries(Object.entries(all).filter(([key]) => /^(dbError|toast|actionRefusal|globalError)\./.test(key)));
}
const DE = catalogue('de-DE');
const FR = catalogue('fr-FR');
const ENGLISH = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8'))['dbError.permission'] as string;

declare global {
  interface Window {
    __refusal: {
      render: (locale: string, messages: Record<string, string>, nested?: { locale: string; messages: Record<string, string> } | null) => void;
      refuse: () => void; serverRefusal: (english: string) => void; unmount: () => void; errors: string[];
    };
  }
}

async function start(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' }));
  await page.goto('https://refusal-language-fixture.invalid');
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)};
    const h = window.__refusal = { errors: [] };
    const mocks = {
      react: window.React,
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/lib/utils/cn': { cn: (...parts) => parts.filter(Boolean).join(' ') },
    };
    const modules = {};
    function load(id) {
      if (id in mocks) return mocks[id];
      if (id in modules) return modules[id];
      if (!(id in sources)) throw new Error('Unexpected import: ' + id);
      const module = { exports: {} }; modules[id] = module.exports;
      new Function('require', 'module', 'exports', sources[id])(load, module, module.exports);
      return module.exports;
    }
    const { LocaleProvider } = load('@/components/i18n/locale-provider');
    const { ToastProvider, useToast } = load('@/components/ui/toast');
    const { Field, Input } = load('@/components/ui/input');
    const { ActionError } = load('@/components/ui/action-error');
    const { describeDbError } = load('@/lib/supabase/errors');
    const { localeOrDefault } = load('@/lib/i18n/locales');
    const e = React.createElement;

    // The app's shape: a component keeps a refusal in its own state and shows
    // it in a Field and an ActionError, and hands it to the toast.
    function Form() {
      const [error, setError] = React.useState(null);
      const { error: toastError } = useToast();
      h.refuse = () => {
        const text = describeDbError({ code: '42501', message: 'new row violates row-level security policy' }, 'fallback');
        ReactDOM.flushSync(() => setError(text));
        ReactDOM.flushSync(() => toastError(text));
      };
      h.serverRefusal = (english) => ReactDOM.flushSync(() => toastError(english));
      return e('form', null,
        e(Field, { label: 'Title', error }, (id) => e(Input, { id })),
        e('div', { id: 'action' }, e(ActionError, { message: error })));
    }
    function Nested({ text }) {
      return e('div', { id: 'nested' }, e(Field, { label: 'Nested', error: text }, (id) => e(Input, { id })));
    }
    const root = ReactDOM.createRoot(document.getElementById('root'));
    h.render = (locale, messages, nested) => ReactDOM.flushSync(() => root.render(
      e(LocaleProvider, { locale: localeOrDefault(locale), source: 'default', messages },
        e(ToastProvider, null,
          e(Form),
          nested ? e(LocaleProvider, { locale: localeOrDefault(nested.locale), source: 'default', messages: nested.messages },
            e(Nested, { text: ${JSON.stringify(ENGLISH)} })) : null))));
    h.unmount = () => ReactDOM.flushSync(() => root.unmount());
  })();` });
  expect(errors).toEqual([]);
  return errors;
}

const field = (page: Page) => page.locator('form [role="alert"]').first();
const action = (page: Page) => page.locator('#action [role="alert"]');
/** The toast stack's messages: whatever is inside the live region, not the form. */
const toastText = (page: Page) => page.locator('[aria-live]').filter({ hasNotText: 'Title' });

test.describe('a refusal follows the reader’s language', () => {
  test('written in German, it is German; the reader switches to French, and the same toast, field and ActionError turn French', async ({ page }) => {
    const errors = await start(page);
    await page.evaluate((m) => window.__refusal.render('de-DE', m), DE);
    // The provider registers after it commits; the refusal comes after that.
    await page.evaluate(() => window.__refusal.refuse());
    await expect(field(page)).toHaveText(DE['dbError.permission']);
    await expect(action(page)).toHaveText(DE['dbError.permission']);
    await expect(toastText(page)).toContainText(DE['dbError.permission']);

    await page.evaluate((m) => window.__refusal.render('fr-FR', m), FR);
    await expect(field(page)).toHaveText(FR['dbError.permission']);
    await expect(action(page)).toHaveText(FR['dbError.permission']);
    await expect(toastText(page)).toContainText(FR['dbError.permission']);
    await expect(toastText(page)).not.toContainText(DE['dbError.permission']);
    // The toast is still the toast: a live region, a labelled dismiss control in the reader's language.
    await expect(page.getByRole('button', { name: FR['toast.dismiss'] })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a sentence written on the server follows the provider that receives it, a nested one included, and an unmounted one leaves nothing behind', async ({ page }) => {
    const errors = await start(page);
    // A French page with a German subtree: each shows the server's English in its own language.
    await page.evaluate(({ fr, de }) => window.__refusal.render('fr-FR', fr, { locale: 'de-DE', messages: de }), { fr: FR, de: DE });
    await page.evaluate((english) => window.__refusal.serverRefusal(english), ENGLISH);
    await expect(toastText(page)).toContainText(FR['dbError.permission']);
    await expect(page.locator('#nested [role="alert"]')).toHaveText(DE['dbError.permission']);
    // The nested provider (which registered last) goes away; the outer one still answers in French.
    await page.evaluate((fr) => window.__refusal.render('fr-FR', fr, null), FR);
    await expect(page.locator('#nested')).toHaveCount(0);
    await page.evaluate(() => window.__refusal.refuse());
    await expect(field(page)).toHaveText(FR['dbError.permission']);
    await page.evaluate(() => window.__refusal.unmount());
    expect(errors).toEqual([]);
  });
});
