import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { test, expect, type Page } from '@playwright/test';

// Actual clock/photo components and temporal helpers execute with React in a
// browser whose timezone deliberately differs from the family's timezone.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sources = Object.fromEntries([
  'components/display/ambient-clock.tsx', 'components/display/photo-frame.tsx',
  'lib/display/ambient.ts', 'lib/display/calendar.ts', 'lib/onboarding/ics-time.ts',
].map(file => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText]));

type ClockConfig = { timezone?: string; clock24?: boolean; seconds?: boolean; locale?: string; photo?: boolean };
declare global { interface Window { __displayClock: { mount: (props: ClockConfig) => void; unmount: () => void; locale: string; errors: string[] } } }

test.use({ timezoneId: 'Asia/Tokyo' });

async function start(page: Page, instant: string, props: ClockConfig) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date(instant) });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' }));
  await page.goto('https://display-clock-fixture.invalid');
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)};
    const p = window.__displayClock = { locale: 'en-US', errors: [] };
    window.addEventListener('unhandledrejection', e => { p.errors.push(String(e.reason)); e.preventDefault(); });
    const mocks = { react: window.React, '@/components/i18n/locale-provider': { useLocale: () => p.locale, useTranslations: () => key => key } };
    const modules = {};
    function load(id) {
      if (id in mocks) return mocks[id];
      if (id in modules) return modules[id];
      if (!(id in sources)) throw new Error('Unexpected import: ' + id);
      const module = { exports: {} }; modules[id] = module.exports;
      const require = name => load(name.startsWith('./') ? id.slice(0, id.lastIndexOf('/') + 1) + name.slice(2) : name);
      new Function('require', 'module', 'exports', sources[id])(require, module, module.exports);
      return module.exports;
    }
    const Clock = load('@/components/display/ambient-clock').AmbientClock;
    const Frame = load('@/components/display/photo-frame').PhotoFrame;
    let root = ReactDOM.createRoot(document.getElementById('root'));
    p.mount = props => {
      p.locale = props.locale || 'en-US';
      const component = props.photo ? Frame : Clock;
      ReactDOM.flushSync(() => root.render(React.createElement(component, {
        clock24: false, seconds: false, photos: [], idleMinutes: 0.01, nextLine: null, ...props,
      })));
    };
    p.unmount = () => ReactDOM.flushSync(() => root.unmount());
  })();` });
  expect(errors).toEqual([]);
  await page.evaluate(value => window.__displayClock.mount(value), props);
}

test('header time and date follow the family zone across a year boundary', async ({ page }) => {
  await start(page, '2026-01-01T02:00:00Z', { timezone: 'America/Los_Angeles' });
  await expect(page.locator('#root')).toContainText('6:00');
  await expect(page.locator('#root')).toContainText('PM');
  await expect(page.locator('#root p')).toHaveText('Wednesday, December 31');
  expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Asia/Tokyo');
});

test('zone and locale changes rerender both the date and the hour', async ({ page }) => {
  await start(page, '2026-01-01T02:00:00Z', { timezone: 'America/Los_Angeles' });
  await expect(page.locator('#root p')).toHaveText('Wednesday, December 31');
  await page.evaluate(() => window.__displayClock.mount({ timezone: 'Europe/Paris', clock24: true, locale: 'fr-FR' }));
  await expect(page.locator('#root')).toContainText('03:00');
  await expect(page.locator('#root p')).toHaveText('jeudi 1 janvier');
});

test('ticks across the family DST jump without displaying nonexistent wall time', async ({ page }) => {
  await start(page, '2026-03-08T06:59:59Z', { timezone: 'America/New_York', clock24: true, seconds: true });
  await expect(page.locator('#root')).toContainText('01:59:59');
  await page.clock.runFor(1500);
  await expect(page.locator('#root')).toContainText('03:00:00');
  await expect(page.locator('#root p')).toHaveText('Sunday, March 8');
});

test('invalid configured timezone uses UTC for the date and clock together', async ({ page }) => {
  await start(page, '2026-01-01T02:00:00Z', { timezone: 'Invalid/Zone', clock24: true });
  await expect(page.locator('#root')).toContainText('02:00');
  await expect(page.locator('#root p')).toHaveText('Thursday, January 1');
});

test('idle photo frame passes the same family zone to its clock and wakes on interaction', async ({ page }) => {
  await start(page, '2026-01-01T02:00:00Z', { timezone: 'America/Los_Angeles', photo: true });
  await expect(page.locator('#root')).toBeEmpty();
  await page.clock.runFor(650);
  await expect(page.getByRole('button', { name: 'photoFrame.wakeDisplay' })).toBeVisible();
  await expect(page.locator('#root')).toContainText('6:00');
  await expect(page.locator('#root p')).toHaveText('Wednesday, December 31');
  await page.keyboard.press('Escape');
  await expect(page.locator('#root')).toBeEmpty();
});

test('unmount leaves no visible clock or rejected asynchronous work', async ({ page }) => {
  await start(page, '2026-01-01T02:00:00Z', { timezone: 'UTC' });
  await expect(page.locator('#root')).toContainText('2:00');
  await page.evaluate(() => window.__displayClock.unmount());
  await page.clock.runFor(5000);
  await expect(page.locator('#root')).toBeEmpty();
  expect(await page.evaluate(() => window.__displayClock.errors)).toEqual([]);
});
