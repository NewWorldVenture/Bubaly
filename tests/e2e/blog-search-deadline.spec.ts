import fs from 'node:fs';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Real React, BlogSearch, loader, browser fetch/AbortController and DOM events.
// Only the public index HTTP response and peripheral link/i18n/icons are
// supplied here. The full Next route is covered by blog-search-unavailable.
const { react, reactDom } = reactBrowserScripts('production');
const origin = 'https://blog-deadline-fixture.invalid';
const article = { slug: 'bedtime', title: 'Bedtime routines', excerpt: 'Healthy routines', category: 'Parenting' };
const sources = Object.fromEntries([
  'app/(marketing)/blog/blog-search.tsx', 'lib/blog/search-index-loader.ts',
].map(file => [file, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText]));
const catalog = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8'));
const messages = Object.fromEntries([
  'blogBlogSearch.searchArticles', 'blogBlogSearch.searchUnavailable',
  'blogBlogSearch.noArticlesFoundForLdquo', 'states.loadingEllipsis', 'a11y.clearSearch',
].map(key => [key, catalog[key]]));

async function install(page: Page, stallFirst: boolean) {
  const requests: string[] = [], unexpected: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' }); return;
    }
    if (url.origin === origin && url.pathname === '/api/blog/search-index') {
      requests.push(route.request().url());
      // Intentionally no response: fetch must be aborted by the real loader.
      if (stallFirst && requests.length === 1) return;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify([article]) }); return;
    }
    unexpected.push(route.request().url()); await route.abort();
  });
  await page.goto(origin);
  await page.clock.install();
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: `(() => {
    const React = window.React, ReactDOM = window.ReactDOM, h = React.createElement;
    const sources = ${JSON.stringify(sources)}, messages = ${JSON.stringify(messages)}, modules = {};
    window.__blogErrors = [];
    window.addEventListener('unhandledrejection', event => { window.__blogErrors.push(String(event.reason)); event.preventDefault(); });
    const peripheral = {
      react: React,
      'next/link': { default: ({ children, ...props }) => h('a', props, children) },
      'lucide-react': { Search: () => null, X: () => null },
      '@/lib/utils/cn': { cn: (...values) => values.join(' ') },
      '@/components/i18n/locale-provider': { useTranslations: () => key => messages[key] ?? key },
    };
    function load(file) {
      if (modules[file]) return modules[file];
      const module = { exports: {} };
      const require = name => {
        if (name === '@/lib/blog/search-index-loader') return load('lib/blog/search-index-loader.ts');
        if (Object.hasOwn(peripheral, name)) return peripheral[name];
        throw new Error('Unexpected blog fixture import ' + name);
      };
      new Function('React', 'require', 'module', 'exports', sources[file])(React, require, module, module.exports);
      return modules[file] = module.exports;
    }
    const Component = load('app/(marketing)/blog/blog-search.tsx').BlogSearch;
    const root = ReactDOM.createRoot(document.getElementById('root'));
    window.__unmountBlog = () => ReactDOM.flushSync(() => root.unmount());
    ReactDOM.flushSync(() => root.render(h(Component)));
  })();` });
  return { requests, unexpected, errors };
}

test('a stalled index shows loading, then unavailable, and a later interaction recovers', async ({ page }) => {
  const state = await install(page, true);
  const box = page.getByPlaceholder(messages['blogBlogSearch.searchArticles']);
  await box.fill('bedtime');
  await expect.poll(() => state.requests.length).toBe(1);
  await expect(page.getByRole('status')).toHaveText(messages['states.loadingEllipsis']);
  await expect(page.getByText(/No articles found/)).toHaveCount(0);
  await page.clock.fastForward(10_000);
  await expect(page.getByRole('status')).toHaveText(messages['blogBlogSearch.searchUnavailable']);
  await box.press('End'); await box.type(' ');
  expect(state.requests).toHaveLength(1);
  await page.clock.fastForward(5_000);
  await box.type(' ');
  const result = page.getByRole('link', { name: /^Bedtime routines\s*Parenting$/ });
  await expect(result).toBeVisible();
  await expect(result).toHaveAttribute('href', '/blog/bedtime');
  expect(state.requests).toHaveLength(2);
  await box.fill('unmatched');
  await expect(page.getByText(/No articles found/)).toBeVisible();
  await box.fill('bedtime');
  await expect(result).toBeVisible();
  expect(state.requests).toHaveLength(2);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __blogErrors: string[] }).__blogErrors)).toEqual([]);
});

test('unmount aborts the pending index request without an unhandled rejection', async ({ page }) => {
  const state = await install(page, true);
  const cancelled: string[] = [];
  page.on('requestfailed', request => { if (request.url().endsWith('/api/blog/search-index')) cancelled.push(request.failure()?.errorText ?? 'failed'); });
  await page.getByPlaceholder(messages['blogBlogSearch.searchArticles']).fill('bedtime');
  await expect.poll(() => state.requests.length).toBe(1);
  await page.evaluate(() => (window as unknown as { __unmountBlog: () => void }).__unmountBlog());
  await expect.poll(() => cancelled.length).toBe(1);
  await page.clock.fastForward(20_000);
  expect(state.requests).toHaveLength(1);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __blogErrors: string[] }).__blogErrors)).toEqual([]);
});
