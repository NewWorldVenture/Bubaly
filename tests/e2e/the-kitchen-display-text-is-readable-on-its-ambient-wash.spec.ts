import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import sharp from 'sharp';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// A11Y-001: the kitchen display's controls on its ambient wash, as Chromium
// RENDERS them. tests/the-kitchen-display-text-is-readable-on-its-ambient-wash.test.ts
// holds the arithmetic (each text composed through the parents read from the
// JSX); this measures pixels.
//
// The real DisplayShell, DisplaySetupCard and KitchenTimers run in Chromium
// with the app's own stylesheet (app/globals.css through the repo's Tailwind
// config): the wash, its glows, the ink scrim, body::before's tint, the grid
// tile, the buttons and their :hover and :focus-visible rules are all the
// browser's. Persistence, peripherals and the tiles under test's neighbours are
// stubbed; nothing leaves the page.
//
// A reading takes two screenshots of a text's box, one as drawn and one with
// that element's colour set to transparent (and its transition off), so the
// second is exactly what the text stands on. Each glyph pixel is compared with
// the same pixel without the text, and the text's ratio is the best of those:
// a fully covered pixel is the text's own colour over its own ground, and a
// partly covered (anti-aliased) one only reads lower, so this is a lower bound
// on the text's contrast, never an overestimate.
//
// The wash is painted flat in each theme's brightest colour (its first stop or
// its glow), so wherever a control sits it stands on the theme at its
// brightest; one case also keeps the morning gradient as drawn.

test.use({ locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, trace: 'off', screenshot: 'off', video: 'off' });

const ORIGIN = 'https://display-wash.invalid/';
const messages = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const { react, reactDom } = reactBrowserScripts('production');
const icons = fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')), 'dist/umd/lucide-react.min.js'), 'utf8');

// The display's real modules, transpiled; these stand in for the rest.
const isolated = new Set([
  'react', 'lucide-react', 'next/link', 'next/navigation',
  '@/lib/supabase/client', '@/components/ui/toast', '@/components/ui/avatar',
  '@/components/i18n/locale-provider', '@/components/i18n/use-format',
  '@/lib/constants/navigation', '@/lib/display/imagery', '@/lib/storage/use-family-media',
  './ask-tile', './handled-today-tile', './use-wake-lock', './ambient-clock', './display-weather', './photo-frame', './hints-ticker',
]);
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const id = path.resolve([filename, `${filename}.ts`, `${filename}.tsx`, path.join(filename, 'index.ts')]
    .find((f) => fs.existsSync(f) && fs.statSync(f).isFile()) ?? filename);
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = /\.tsx?$/.test(id)
    ? ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText
    : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (isolated.has(name)) { item.imports[name] = name; continue; }
    item.imports[name] = collect(name.startsWith('@/') ? path.resolve(name.slice(2))
      : name.startsWith('.') ? path.resolve(path.dirname(id), name)
        : require.resolve(name, { paths: [path.dirname(id)] }));
  }
  return id;
}
const entry = collect('components/display/display-grid.tsx');
const ambient = collect('lib/display/ambient.ts');

let css = '';
test.beforeAll(async () => {
  const config = { exports: {} as { default: Record<string, unknown> } };
  new Function('module', 'exports', 'require', ts.transpileModule(fs.readFileSync('tailwind.config.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText)(config, config.exports, require);
  const tailwind = { ...config.exports.default, content: ['components/display/**/*.tsx', 'app/(app)/display/**/*.tsx'] };
  css = (await postcss([tailwindcss(tailwind), autoprefixer()]).process(fs.readFileSync('app/globals.css', 'utf8'), { from: 'app/globals.css' })).css;
});

type Probe = { writes: { settings: { setupDismissed: boolean } }[]; errors: string[] };
declare global { interface Window { __wash: Probe } }

/** The display, mounted with one timers tile, the setup card showing and (optionally) a finished timer. */
async function display(page: Page, { finished = false } = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    if (route.request().url() !== ORIGIN) return route.abort();
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html class="dark" lang="en"><head></head><body><main id="root"></main></body></html>' });
  });
  await page.goto(ORIGIN);
  await page.addStyleTag({ content: css });
  for (const content of [react, reactDom, 'window.react = window.React;', icons]) await page.addScriptTag({ content });
  await page.evaluate(({ sources, entry, ambient, messages, finished }) => {
    const w = window as unknown as Record<string, any>;
    const R = w.React, D = w.ReactDOM, h = R.createElement;
    const probe: Probe = w.__wash = { writes: [], errors: [] };
    window.addEventListener('error', (e) => probe.errors.push(e.message));
    if (finished) {
      localStorage.setItem('display.timers', JSON.stringify([{ id: 'tea', label: 'Tea', emoji: '🍵', endsAt: Date.now() - 1000, totalSeconds: 240, done: true }]));
    } else localStorage.removeItem('display.timers');
    const tr = (key: string, vars: Record<string, unknown> = {}) =>
      Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), messages[key] ?? key);
    const none = () => null;
    const mocks: Record<string, unknown> = {
      react: R, 'lucide-react': w.LucideReact,
      'next/link': { default: (props: Record<string, unknown>) => h('a', props, props.children) },
      'next/navigation': { useRouter: () => ({ push: none, refresh: none }), usePathname: () => '/display' },
      '@/lib/supabase/client': { createClient: () => ({ from: (table: string) => {
        if (table !== 'display_layouts') throw new Error(`Unexpected table ${table}`);
        return { upsert: (write: Probe['writes'][number]) => { probe.writes.push(structuredClone(write)); return Promise.resolve({ error: null }); } };
      } }) },
      '@/components/ui/toast': { useToast: () => ({ success: none, error: (m: string) => probe.errors.push(m) }) },
      '@/components/ui/avatar': { Avatar: none },
      '@/components/i18n/locale-provider': { useTranslations: () => tr, useLocale: () => ({ code: 'en-US' }), useFamilyTimeZone: () => 'UTC' },
      '@/components/i18n/use-format': { useFormat: () => ({ fmtDate: () => '' }) },
      '@/lib/constants/navigation': { ALL_SERVICES_CATALOG: [], ALL_SERVICES_BY_HREF: new Map() },
      '@/lib/display/imagery': { recipeImage: () => '', mealImage: () => '', AMBIENT_FALLBACK_PHOTOS: [] },
      '@/lib/storage/use-family-media': { useFamilyMediaUrls: () => () => null },
      './ask-tile': { AskTile: none }, './handled-today-tile': { HandledTodayTile: none },
      './use-wake-lock': { useWakeLock: () => 'unsupported' }, './ambient-clock': { AmbientClock: none },
      './display-weather': { DisplayWeatherProvider: (props: { children: unknown }) => props.children, WeatherChip: none, WeatherTile: none },
      './photo-frame': { PhotoFrame: none }, './hints-ticker': { HintsTicker: none },
    };
    const loaded: Record<string, { exports: Record<string, any> }> = {};
    const load = (id: string): any => {
      if (id in mocks) return mocks[id];
      if (loaded[id]) return loaded[id].exports;
      const item = sources[id];
      if (!item) throw new Error(`Unexpected module ${id}`);
      const m = loaded[id] = { exports: {} };
      new Function('require', 'module', 'exports', 'process', item.source)((name: string) => load(item.imports[name]), m, m.exports, { env: { NODE_ENV: 'production' } });
      return m.exports;
    };
    w.__ambient = load(ambient);
    const props = {
      familyId: 'family-A', userId: 'user-A',
      initialTiles: [{ id: 'timers', widget: 'timers', size: 'md' }],
      initialSettings: w.__ambient.normalizeSettings({ ambient: true, background: 'gradient', screensaver: false, idleMinutes: 0, setupDismissed: false }),
      data: { familyName: 'Probe Family', timezone: 'UTC', members: [], events: [], upcoming: [], chores: [], meals: [],
        grocery: { items: [], count: 0 }, reminders: [], birthdays: [], notes: [], featured: [], photos: [],
        calendar: { year: 2026, month: 9, today: 11, eventDays: [] } },
    };
    D.createRoot(document.getElementById('root')).render(h(load(entry).DisplayShell, props));
  }, { sources: modules, entry, ambient, messages, finished });
  await expect(page.getByRole('region', { name: messages['displaySetupCard.setUpThisTablet'] })).toBeVisible();
  return { errors: async () => [...errors, ...await page.evaluate(() => window.__wash.errors)] };
}

/** The themes and the colours each paints the wash with: day parts through 'auto' at a time of day, and the fixed ones. */
const THEMES: Record<string, { choice: string; at: string }> = {
  dawn: { choice: 'auto', at: '2026-10-11T06:00:00Z' },
  morning: { choice: 'auto', at: '2026-10-11T08:00:00Z' },
  afternoon: { choice: 'auto', at: '2026-10-11T13:00:00Z' },
  evening: { choice: 'auto', at: '2026-10-11T18:00:00Z' },
  night: { choice: 'auto', at: '2026-10-11T23:00:00Z' },
  midnight: { choice: 'midnight', at: '2026-10-11T08:00:00Z' },
  aurora: { choice: 'aurora', at: '2026-10-11T08:00:00Z' },
  sunset: { choice: 'sunset', at: '2026-10-11T08:00:00Z' },
  forest: { choice: 'forest', at: '2026-10-11T08:00:00Z' },
};

/** Paint the wash element (and its glows) as `theme` does, or flat in its brightest colour. Returns that colour. */
function paintWash(page: Page, theme: string, flat: boolean): Promise<string> {
  return page.evaluate(({ choice, at, flat }) => {
    const w = window as unknown as { __ambient: { ambientTheme: (c: string, d: Date, tz: string) => { gradient: string; glow: string } } };
    const t = w.__ambient.ambientTheme(choice, new Date(at), 'UTC');
    const channel = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const lum = (h: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); };
    const brightest = [...(t.gradient.match(/#[0-9a-fA-F]{6}/g) ?? []), t.glow].sort((a, b) => lum(b) - lum(a))[0];
    const wash = [...document.querySelectorAll<HTMLElement>('div.fixed.inset-0')].find((d) => d.style.backgroundImage.includes('radial-gradient'));
    const glows = [...document.querySelectorAll<HTMLElement>('div.opacity-40 > div')];
    if (!wash || glows.length !== 2) throw new Error('the wash and its two glows were not found');
    wash.style.backgroundImage = flat ? `linear-gradient(${brightest}, ${brightest})` : t.gradient;
    for (const g of glows) g.style.background = flat ? brightest : t.glow;
    return brightest;
  }, { ...THEMES[theme], flat });
}

/** Let every transition finish, and every pulse rest on the frame asked for. */
async function settle(page: Page, pulseAt?: number) {
  await page.evaluate((pulseAt) => {
    for (const a of document.getAnimations()) {
      if ((a as CSSAnimation).animationName === 'pulse' && pulseAt !== undefined) { a.pause(); a.currentTime = pulseAt; } else if (a instanceof CSSTransition) a.finish();
    }
  }, pulseAt);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

const channel = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (c: number[]) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

type Reading = { what: string; ratio: number; glyphPixels: number };

/** The rendered contrast of one element's text: the best glyph pixel against the same pixel without the text. */
async function measure(page: Page, what: string, text: Locator, pulseAt?: number): Promise<Reading> {
  // Words only: an icon beside them is a separate SVG whose paths overlap at
  // their joins, where a translucent stroke is drawn twice and reads brighter.
  await text.evaluate((el) => el.querySelectorAll('svg').forEach((svg) => svg.style.setProperty('visibility', 'hidden')));
  await settle(page, pulseAt);
  const box = (await text.boundingBox())!;
  const clip = { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width) + 1, height: Math.ceil(box.height) + 1 };
  const shot = async () => sharp(await page.screenshot({ clip, animations: 'allow', caret: 'hide' })).removeAlpha().raw().toBuffer();
  const on = await shot();
  await text.evaluate((el) => { el.style.setProperty('color', 'transparent', 'important'); el.style.setProperty('transition', 'none', 'important'); });
  await settle(page, pulseAt);
  const off = await shot();
  await text.evaluate((el) => {
    el.style.removeProperty('color'); el.style.removeProperty('transition');
    el.querySelectorAll('svg').forEach((svg) => svg.style.removeProperty('visibility'));
  });
  let best = 0; let glyphPixels = 0;
  for (let i = 0; i < on.length; i += 3) {
    const a = [on[i], on[i + 1], on[i + 2]]; const b = [off[i], off[i + 1], off[i + 2]];
    if (Math.max(...a.map((v, k) => Math.abs(v - b[k]))) < 8) continue;
    glyphPixels++;
    best = Math.max(best, ratio(a, b));
  }
  return { what, ratio: Number(best.toFixed(2)), glyphPixels };
}

/** Tab until `target` has keyboard focus. */
async function tabTo(page: Page, target: Locator) {
  await page.mouse.move(1, 1);
  for (let i = 0; i < 40; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('never reached by Tab');
}

const picker = (page: Page) => page.getByRole('button', { name: /^🥚 Soft eggs/ });
const guide = (page: Page) => page.getByRole('link', { name: messages['displaySetupCard.openTheGuide'] });
const gotIt = (page: Page) => page.getByRole('button', { name: messages['displaySetupCard.gotIt'], exact: true });
const addTimer = (page: Page) => page.getByRole('button', { name: messages['kitchenTimers.addTimer'], exact: true });

function report(theme: string, readings: Reading[]) {
  console.log(`[rendered] ${theme}: ${readings.map((r) => `${r.what} ${r.ratio}`).join(' · ')}`);
  for (const r of readings) expect(r.glyphPixels, `${theme}: ${r.what} drew no text`).toBeGreaterThan(20);
  expect(readings.filter((r) => r.ratio < 4.5).map((r) => `${theme}: ${r.what} ${r.ratio}`)).toEqual([]);
}

for (const theme of Object.keys(THEMES)) {
  test(`${theme}, at its brightest colour: the timer picker, the setup guide and a finished timer read at 4.5:1 or more, idle, hovered and focused`, async ({ page }) => {
    const shell = await display(page, { finished: true });
    const stop = await paintWash(page, theme, true);
    const readings: Reading[] = [];

    // A finished timer: its words hold still while the wash under them pulses.
    const card = page.getByRole('listitem').filter({ hasText: messages['kitchenTimers.done'] });
    const label = card.getByText('Tea', { exact: true });
    const done = card.getByText(messages['kitchenTimers.done'], { exact: true });
    expect(await card.locator('.animate-pulse').count()).toBe(1);
    for (const [frame, at] of [['faintest frame', 1000], ['brightest frame', 0]] as const) {
      readings.push(await measure(page, `finished label, ${frame}`, label, at));
      readings.push(await measure(page, `"Done!", ${frame}`, done, at));
      const fades = await label.evaluate((el) => { const o: string[] = []; for (let e: Element | null = el; e; e = e.parentElement) if (getComputedStyle(e).opacity !== '1') o.push(e.className); return o; });
      expect(fades, 'nothing over the words is fading').toEqual([]);
    }

    readings.push(await measure(page, 'add timer', addTimer(page)));
    await addTimer(page).hover();
    readings.push(await measure(page, 'add timer, hovered', addTimer(page)));
    await addTimer(page).click();

    // The picker: the first preset's name and its duration, at rest, under the pointer, and under keyboard focus.
    const preset = picker(page);
    const name = preset.getByText('Soft eggs', { exact: true });
    const duration = preset.getByText('6:00', { exact: true });
    await page.mouse.move(1, 1);
    readings.push(await measure(page, 'preset name', name), await measure(page, 'preset duration', duration));
    await preset.hover();
    readings.push(await measure(page, 'preset name, hovered', name), await measure(page, 'preset duration, hovered', duration));
    await tabTo(page, preset);
    readings.push(await measure(page, 'preset duration, focused', duration));

    // The setup guide and its neighbour, in their own card above the grid.
    readings.push(await measure(page, 'setup guide', guide(page)), await measure(page, 'got it', gotIt(page)));
    await guide(page).hover();
    readings.push(await measure(page, 'setup guide, hovered', guide(page)));
    await gotIt(page).hover();
    readings.push(await measure(page, 'got it, hovered', gotIt(page)));
    await tabTo(page, guide(page));
    readings.push(await measure(page, 'setup guide, focused', guide(page)));

    report(`${theme} (${stop})`, readings);
    expect(await shell.errors()).toEqual([]);
  });
}

test('as drawn: the morning gradient, whose brightest corner is under the setup card', async ({ page }) => {
  const shell = await display(page);
  await paintWash(page, 'morning', false);
  const readings: Reading[] = [];
  readings.push(await measure(page, 'setup guide', guide(page)));
  await guide(page).hover();
  readings.push(await measure(page, 'setup guide, hovered', guide(page)));
  await page.getByRole('button', { name: messages['kitchenTimers.startATimer'], exact: true }).click();
  await picker(page).hover();
  readings.push(await measure(page, 'preset duration, hovered', picker(page).getByText('6:00', { exact: true })));
  report('morning as drawn', readings);
  expect(await shell.errors()).toEqual([]);
});

test('the timer picker and the setup guide keep their keyboard and pointer behaviour', async ({ page }) => {
  const shell = await display(page);
  await paintWash(page, 'morning', true);
  const start = page.getByRole('button', { name: messages['kitchenTimers.startATimer'], exact: true });
  await tabTo(page, start);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /^🥚 / })).toHaveCount(2);
  await tabTo(page, picker(page));
  await expect(picker(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Soft eggs', { exact: true })).toBeVisible();
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('display.timers') ?? '[]'))).toHaveLength(1);
  await tabTo(page, addTimer(page));
  await page.keyboard.press(' ');
  await expect(picker(page)).toBeVisible();
  await page.getByRole('button', { name: messages['a11y.close'], exact: true }).click();
  await expect(picker(page)).toHaveCount(0);
  await addTimer(page).click();
  await page.getByRole('button', { name: /^🍝 Pasta/ }).click();
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('display.timers') ?? '[]'))).toHaveLength(2);

  await tabTo(page, guide(page));
  await expect(guide(page)).toBeFocused();
  await expect(guide(page)).toHaveAttribute('href', '/display/setup');
  await tabTo(page, gotIt(page));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: messages['displaySetupCard.setUpThisTablet'] })).toHaveCount(0);
  const writes = await page.evaluate(() => window.__wash.writes);
  expect(writes).toHaveLength(1);
  expect(writes[0].settings.setupDismissed).toBe(true);
  expect(await shell.errors()).toEqual([]);
});
