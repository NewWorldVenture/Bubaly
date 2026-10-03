import fs from 'node:fs';
import ts from 'typescript';
import { test, expect, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

const scripts = reactBrowserScripts('development');
const sourceFiles = [
  'components/modules/calendar-module.tsx', 'lib/time/wall-clock.ts',
  'lib/time/zoned.ts', 'lib/calendar/recurrence.ts',
];
const sources = Object.fromEntries(sourceFiles.map(file => [
  '@/' + file.replace(/\.tsx?$/, ''),
  ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText,
]));
const browserErrors = new WeakMap<Page, string[]>();

type CalendarConfig = { day: string; zone?: string; events?: { id: string; title: string; starts_at: string; recurrence: string }[] };
declare global { interface Window { __calendarNavigation: { errors: string[]; reactVersion: string } } }
test.use({ timezoneId: 'Asia/Tokyo' });

async function start(page: Page, config: CalendarConfig) {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.type() + ': ' + message.text());
  });
  page.on('requestfailed', request => errors.push('Failed browser request: ' + request.url()));
  await page.clock.install({ time: new Date(config.day + 'T12:00:00Z') });
  // Every browser request is intercepted; no app server, Auth or provider is used.
  await page.route('**/*', route => {
    if (route.request().url() !== 'https://calendar-navigation-fixture.invalid/') {
      errors.push('Unexpected browser request: ' + route.request().url());
      return route.abort();
    }
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><main id="root"></main></body></html>',
    });
  });
  await page.goto('https://calendar-navigation-fixture.invalid');
  await page.addScriptTag({ content: scripts.react });
  await page.addScriptTag({ content: scripts.reactDom });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)};
    const config = ${JSON.stringify(config)};
    const p = window.__calendarNavigation = { errors: [], reactVersion: React.version };
    window.addEventListener('error', e => p.errors.push(e.message));
    window.addEventListener('unhandledrejection', e => { p.errors.push(String(e.reason)); e.preventDefault(); });
    const modules = {};
    const blank = () => null;
    const pass = props => React.createElement('div', null, props.children);
    const stub = new Proxy({ __esModule: true, default: pass }, { get: (obj, key) => key in obj ? obj[key] : blank });
    const mocks = {
      react: React,
      '@/components/app/app-context': { useApp: () => ({ familyId: 'synthetic-family', userId: 'synthetic-user', members: [], selfMember: null }) },
      '@/lib/hooks/use-realtime-query': { useRealtimeQuery: () => ({ data: config.events || [], loading: false, error: null, refresh: () => {} }) },
      '@/components/ui/toast': { useToast: () => ({ success: () => {}, error: () => {} }) },
      '@/components/i18n/locale-provider': { useTranslations: () => key => key },
      '@/lib/utils/cn': { cn: (...args) => args.filter(Boolean).join(' ') },
      '@/components/app/page-header': { PageHeader: props => React.createElement('header', null, props.title, props.action) },
      '@/components/ui/button': { Button: props => React.createElement('button', { onClick: props.onClick, disabled: props.disabled }, props.children) },
    };
    function load(id) {
      if (id in mocks) return mocks[id];
      if (id in modules) return modules[id];
      if (!(id in sources)) return stub;
      const module = { exports: {} }; modules[id] = module.exports;
      new Function('require', 'module', 'exports', sources[id])(load, module, module.exports);
      return module.exports;
    }
    const wall = load('@/lib/time/wall-clock');
    const zone = config.zone || 'UTC';
    const today = wall.wallFromKey(config.day);
    const clock = {
      timeZone: zone, wallNow: () => today, wallToday: () => today, todayKey: () => config.day,
      wallKey: wall.wallKey, wallOf: iso => wall.wallAt(new Date(iso), zone),
      dayKeyOf: iso => wall.wallKey(wall.wallAt(new Date(iso), zone)),
      toInstant: d => wall.wallToInstant(d, zone), addDays: wall.addWallDays,
      dayStart: offset => wall.wallToInstant(wall.addWallDays(today, offset), zone),
    };
    mocks['@/components/i18n/use-format'] = {
      useFamilyClock: () => clock,
      useFormat: () => ({
        fmtDate: (value, pattern) => {
          if (pattern === 'MMMM yyyy') return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(value + 'T12:00:00Z'));
          return value;
        },
        fmtTime: iso => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)),
      }),
    };
    // The two status effects receive inert responses. They never contact a provider.
    window.fetch = async url => {
      if (url === '/api/google/calendar/sync') return new Response(JSON.stringify({ connected: false }));
      if (url === '/api/sync/microsoft/status') return new Response(JSON.stringify({ connected: false, configured: false }));
      throw new Error('Unexpected synthetic calendar fetch: ' + url);
    };
    const Calendar = load('@/components/modules/calendar-module').CalendarModule;
    const root = ReactDOM.createRoot(document.getElementById('root'));
    ReactDOM.flushSync(() => root.render(React.createElement(Calendar)));
  })();` });
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__calendarNavigation.errors)).toEqual([]);
  expect(await page.evaluate(() => window.__calendarNavigation.reactVersion)).toMatch(/^19\./);
}
test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? []).toEqual([]);
  expect(await page.evaluate(() => window.__calendarNavigation?.errors ?? [])).toEqual([]);
});
const mainLabel = (page: Page) => page.locator('.module-page').getByText(/^[A-Z][a-z]+ \d{4}$/);
async function monthView(page: Page) { await page.getByRole('button', { name: 'month', exact: true }).click(); }
async function arrow(page: Page, dir: 'next' | 'previous') {
  await page.getByRole('button', { name: 'calendar.' + dir, exact: true }).click();
}

for (const [day, direction, wanted] of [
  ['2026-03-02', 'next', 'April 2026'], ['2026-03-30', 'previous', 'February 2026'],
  ['2026-12-07', 'next', 'January 2027'], ['2027-01-04', 'previous', 'December 2026'],
  ['2024-01-29', 'next', 'February 2024'], ['2026-02-02', 'next', 'March 2026'],
] as const) {
  test('month ' + direction + ' from ' + day + ' reaches ' + wanted, async ({ page }) => {
    await start(page, { day }); await monthView(page); await arrow(page, direction);
    await expect(mainLabel(page)).toHaveText(wanted);
    expect(await page.evaluate(() => window.__calendarNavigation.errors)).toEqual([]);
  });
}
test('repeated month arrows and Today keep the expected calendar month', async ({ page }) => {
  await start(page, { day: '2026-03-02' }); await monthView(page);
  await arrow(page, 'next'); await arrow(page, 'next'); await expect(mainLabel(page)).toHaveText('May 2026');
  await arrow(page, 'previous'); await arrow(page, 'previous'); await expect(mainLabel(page)).toHaveText('March 2026');
  await arrow(page, 'next'); await page.getByRole('button', { name: 'calendar.today', exact: true }).click();
  await expect(mainLabel(page)).toHaveText('March 2026');
});
test('week arrows retain one-week movement and Today resets it', async ({ page }) => {
  await start(page, { day: '2026-03-02' });
  const label = page.locator('.module-page').getByText('2026-03-02 – 2026-03-08', { exact: true });
  await expect(label).toBeVisible();
  await arrow(page, 'next'); await expect(page.locator('.module-page')).toContainText('2026-03-09 – 2026-03-15');
  await page.getByRole('button', { name: 'calendar.today', exact: true }).click(); await expect(label).toBeVisible();
});
test('mini-calendar Mondays sit below Monday and all leap-February dates remain selectable', async ({ page }) => {
  await start(page, { day: '2024-02-12' });
  const grid = page.locator('.module-sidebar .sidebar-card').first().locator('.grid');
  await expect(grid.locator(':scope > div').filter({ hasText: /^M$/ })).toHaveCount(1);
  const headers = await grid.locator(':scope > div').filter({ hasText: /^[MTWFS]$/ }).allTextContents();
  expect(headers).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
  expect(await grid.locator('button').allTextContents()).toEqual(Array.from({ length: 29 }, (_, i) => String(i + 1)));
  const index = await grid.getByRole('button', { name: '12', exact: true }).evaluate(button => Array.from(button.parentElement!.children).indexOf(button) - 7);
  expect(index % 7).toBe(0);
  await grid.getByRole('button', { name: '29', exact: true }).click();
  await page.getByRole('button', { name: 'day', exact: true }).click();
  await expect(page.locator('.module-page')).toContainText('2024-02-29');
});
test('family recurrence remains on its family date and time after month navigation', async ({ page }) => {
  await start(page, { day: '2026-03-02', zone: 'America/New_York', events: [
    { id: 'synthetic-practice', title: 'Synthetic practice', starts_at: '2026-03-02T23:00:00Z', recurrence: 'weekly' },
  ] });
  await monthView(page); await arrow(page, 'next'); await expect(mainLabel(page)).toHaveText('April 2026');
  await expect(page.getByRole('button', { name: 'Synthetic practice', exact: true })).toHaveCount(6);
  await page.getByRole('button', { name: 'day', exact: true }).click();
  await expect(page.locator('.module-page')).toContainText('2026-04-06');
  await expect(page.locator('#root')).toContainText('18:00');
  expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Asia/Tokyo');
  expect(await page.evaluate(() => window.__calendarNavigation.errors)).toEqual([]);
});
