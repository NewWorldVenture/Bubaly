import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import type { DisplayData } from '../../components/display/display-grid';
import type { DisplaySettings } from '../../lib/display/ambient';
import type { Tile } from '../../lib/display/tiles';

// Real React, DisplayShell, setup card and layout/settings normalizers execute
// in Chromium. Only persistence and peripheral device/widget boundaries are
// controlled; no live account, database, provider or display device is touched.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.production.min.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.production.min.js'), 'utf8');
const sources = Object.fromEntries([
  'lib/display/ambient.ts', 'lib/display/tiles.ts', 'lib/display/calendar.ts', 'lib/onboarding/ics-time.ts',
  'lib/i18n/locales.ts',
  'components/display/setup-card.tsx', 'components/display/display-grid.tsx',
  'components/display/display-shell-client.tsx',
].map((file) => [file, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText]));

type Props = {
  familyId: string; userId: string; initialTiles: Tile[];
  initialSettings: DisplaySettings; data: DisplayData;
};
type Write = { family_id: string; updated_by: string; tiles: Tile[]; settings: DisplaySettings };
type DisplayProbe = {
  localeCode: string;
  props: Props; writes: Write[]; stored: Record<string, Write>; notices: Array<{ kind: string; message: string }>;
  render: (patch?: Partial<Props>) => void;
  finish: (index: number, message?: string, thrown?: boolean) => void;
  unmount: () => void;
};
declare global { interface Window { __displayProbe: DisplayProbe } }

const layout = (widget: Tile['widget'], id: string = widget): Tile[] => [{ id, widget, size: 'sm' }];
async function refresh(page: Page, patch: Partial<Props>) {
  await page.evaluate((next) => window.__displayProbe.render(next), patch);
}
async function settings(page: Page, patch: Partial<DisplaySettings>) {
  return page.evaluate((next) => ({ ...window.__displayProbe.props.initialSettings, ...next }), patch);
}
async function edit(page: Page) { await page.getByTitle('displayGrid.editDisplay', { exact: true }).click(); }
async function complete(page: Page, index: number, message?: string, thrown = false) {
  await page.evaluate(({ index, message, thrown }) => window.__displayProbe.finish(index, message, thrown), { index, message, thrown });
}
const clock = (page: Page) => page.locator('[data-clock24]').first();
const tileEditor = (page: Page) => page.getByRole('combobox', { name: 'displayGrid.section', exact: true }).first();
const setup = (page: Page) => page.getByRole('region', { name: 'displaySetupCard.setUpThisTablet' });

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => route.fulfill({ status: 200, body: '' }));
  await page.setContent('<!doctype html><html><body><main id="root"></main></body></html>');
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: `(() => {
    const React = window.React, ReactDOM = window.ReactDOM;
    const h = React.createElement, modules = {};
    const sources = ${JSON.stringify(sources)};
    const pending = [];
    const p = { writes: [], stored: {}, notices: [], localeCode: 'en-US' };
    const empty = () => null;
    const icons = new Proxy({}, { get: () => empty });
    const translation = key => key;
    const requires = {
      react: React,
      'next/link': { default: ({ children, ...props }) => h('a', props, children) },
      'next/dynamic': { default: () => props => h(load('components/display/display-grid.tsx').DisplayShell, props) },
      'lucide-react': icons,
      '@/lib/supabase/client': { createClient: () => ({ from: table => {
        if (table !== 'display_layouts') throw new Error('Unexpected table ' + table);
        return { upsert: (write, options) => {
          if (options.onConflict !== 'family_id') throw new Error('Unexpected conflict owner');
          p.writes.push(structuredClone(write));
          return new Promise((resolve, reject) => pending.push({ resolve, reject }));
        } };
      } }) },
      '@/components/ui/toast': { useToast: () => ({
        success: message => p.notices.push({ kind: 'success', message }),
        error: message => p.notices.push({ kind: 'error', message }),
      }) },
      '@/components/ui/avatar': { Avatar: empty },
      '@/components/i18n/locale-provider': { useTranslations: () => translation, useLocale: () => load('lib/i18n/locales.ts').localeOrDefault(p.localeCode) },
      '@/lib/utils/format': { fmtTime: value => String(value) },
      '@/lib/utils/cn': { cn: (...parts) => parts.flat().filter(Boolean).join(' ') },
      '@/lib/constants/navigation': { ALL_SERVICES_CATALOG: [], ALL_SERVICES_BY_HREF: new Map() },
      '@/lib/display/imagery': { recipeImage: () => '', mealImage: () => '', AMBIENT_FALLBACK_PHOTOS: [] },
      './ask-tile': { AskTile: empty }, './handled-today-tile': { HandledTodayTile: empty },
      './use-wake-lock': { useWakeLock: () => 'unsupported' },
      './ambient-clock': { AmbientClock: props => h('output', { 'data-clock24': String(props.clock24), 'data-timezone': props.timezone }) },
      './display-weather': { DisplayWeatherProvider: props => h(React.Fragment, null, props.children), WeatherChip: empty, WeatherTile: empty },
      './kitchen-timers': { KitchenTimers: empty },
      './photo-frame': { PhotoFrame: props => h('output', { 'data-frame-next': props.nextLine ?? '', 'data-frame-zone': props.timezone }) },
      './hints-ticker': { HintsTicker: props => h('div', { 'data-hints': true }, props.hints.join(' | ')) },
    };
    function load(file) {
      if (modules[file]) return modules[file];
      const exports = {}, module = { exports };
      const require = id => {
        if (id === '@/lib/display/ambient') return load('lib/display/ambient.ts');
        if (id === '@/lib/display/calendar') return load('lib/display/calendar.ts');
        if (id === '@/lib/onboarding/ics-time') return load('lib/onboarding/ics-time.ts');
        if (id === '@/lib/display/tiles') return load('lib/display/tiles.ts');
        if (id === './setup-card') return load('components/display/setup-card.tsx');
        if (Object.prototype.hasOwnProperty.call(requires, id)) return requires[id];
        throw new Error('Unexpected import ' + id);
      };
      new Function('React', 'exports', 'module', 'require', sources[file])(React, exports, module, require);
      modules[file] = module.exports;
      return module.exports;
    }
    p.props = {
      familyId: 'family-A', userId: 'user-A',
      initialTiles: [{ id: 'A', widget: 'schedule', size: 'sm' }],
      initialSettings: load('lib/display/ambient.ts').normalizeSettings({ clock24: false, setupDismissed: false, idleMinutes: 0, screensaver: false }),
      data: { familyName: 'Family A', members: [], events: [], upcoming: [], chores: [], meals: [],
        grocery: { items: [], count: 0 }, reminders: [], birthdays: [], notes: [], featured: [], photos: [],
        calendar: { year: 2026, month: 8, today: 12, eventDays: [] } },
    };
    const root = ReactDOM.createRoot(document.getElementById('root'));
    const Shell = load('components/display/display-shell-client.tsx').DisplayShellClient;
    p.render = patch => { p.props = { ...p.props, ...patch }; ReactDOM.flushSync(() => root.render(h(Shell, p.props))); };
    p.finish = (index, message, thrown) => {
      const write = pending[index];
      if (!write) throw new Error('Missing pending write ' + index);
      if (!message && !thrown) p.stored[p.writes[index].family_id] = structuredClone(p.writes[index]);
      if (thrown) write.reject(new Error(message));
      else write.resolve({ error: message ? { message } : null });
    };
    p.unmount = () => ReactDOM.flushSync(() => root.unmount());
    window.__displayProbe = p;
    p.render();
  })();` });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Family A');
});

test('idle refresh adopts persisted tiles, settings and setup dismissal', async ({ page }) => {
  await refresh(page, { initialTiles: layout('reminders'), initialSettings: await settings(page, { clock24: true, setupDismissed: true }) });
  await expect(page.getByText('Reminders', { exact: true })).toBeVisible();
  await expect(page.getByText("Today's Schedule", { exact: true })).toHaveCount(0);
  await expect(clock(page)).toHaveAttribute('data-clock24', 'true');
  await expect(setup(page)).toHaveCount(0);
});

test('family change resets an active draft and saves only the new family layout', async ({ page }) => {
  await edit(page);
  await tileEditor(page).selectOption('chores');
  await page.getByRole('button', { name: '24h', exact: true }).click();
  await refresh(page, { familyId: 'family-B', initialTiles: layout('reminders', 'B'), initialSettings: await settings(page, { clock24: false }) });
  await expect(page.getByText('displayGrid.displaySettings', { exact: true })).toHaveCount(0);
  await expect(clock(page)).toHaveAttribute('data-clock24', 'false');
  await expect(page.getByText('Reminders', { exact: true })).toBeVisible();
  await edit(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const writes = await page.evaluate(() => window.__displayProbe.writes);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ family_id: 'family-B', tiles: layout('reminders', 'B'), settings: { clock24: false } });
});

test('same-family refresh preserves the draft and cancel uses the refreshed baseline', async ({ page }) => {
  await edit(page);
  await tileEditor(page).selectOption('chores');
  await page.getByRole('button', { name: '24h', exact: true }).click();
  await refresh(page, { initialTiles: layout('reminders'), initialSettings: await settings(page, { clock24: false, setupDismissed: true }) });
  await expect(tileEditor(page)).toHaveValue('chores');
  await expect(clock(page)).toHaveAttribute('data-clock24', 'true');
  await page.getByRole('button', { name: 'displayGrid.cancel', exact: true }).click();
  await expect(page.getByText('Reminders', { exact: true })).toBeVisible();
  await expect(clock(page)).toHaveAttribute('data-clock24', 'false');
  await expect(setup(page)).toHaveCount(0);
});

test('changing user also resets the same-family local editing session', async ({ page }) => {
  await edit(page);
  await tileEditor(page).selectOption('chores');
  await refresh(page, { userId: 'user-B' });
  await expect(page.getByText('displayGrid.displaySettings', { exact: true })).toHaveCount(0);
  await expect(page.getByText("Today's Schedule", { exact: true })).toBeVisible();
});

test('a successful save becomes the local cancel baseline until persisted props refresh', async ({ page }) => {
  await edit(page);
  await tileEditor(page).selectOption('chores');
  await page.getByRole('button', { name: '24h', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await complete(page, 0);
  await expect(page.getByText('displayGrid.displaySettings', { exact: true })).toHaveCount(0);
  await expect(clock(page)).toHaveAttribute('data-clock24', 'true');
  await edit(page);
  await tileEditor(page).selectOption('reminders');
  await page.getByRole('button', { name: 'displayGrid.cancel', exact: true }).click();
  await expect(page.getByText('Chores', { exact: true })).toBeVisible();
  await expect(clock(page)).toHaveAttribute('data-clock24', 'true');
});

test('an old family save cannot finish the new family saving session or show its toast', async ({ page }) => {
  await edit(page);
  await tileEditor(page).selectOption('chores');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await refresh(page, { familyId: 'family-B', initialTiles: layout('reminders', 'B') });
  await edit(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await complete(page, 0);
  await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.__displayProbe.notices)).toEqual([]);
  expect((await page.evaluate(() => window.__displayProbe.writes)).map(({ family_id }) => family_id)).toEqual(['family-A', 'family-B']);
  await complete(page, 1);
  await expect(page.getByText('displayGrid.displaySettings', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Reminders', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__displayProbe.notices)).toHaveLength(1);
});

test('an obsolete save error stays with its original owner even after A to B to A', async ({ page }) => {
  await edit(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await refresh(page, { familyId: 'family-B' });
  await refresh(page, { familyId: 'family-A', initialTiles: layout('reminders') });
  await complete(page, 0, 'Old owner write failed');
  await expect(page.getByText('Reminders', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__displayProbe.notices)).toEqual([]);
});

for (const failed of [false, true]) {
  test(`a delayed ${failed ? 'failed' : 'successful'} setup dismissal cannot affect a new owner`, async ({ page }) => {
    await page.getByRole('button', { name: 'displaySetupCard.gotIt', exact: true }).click();
    await refresh(page, { familyId: 'family-B', initialSettings: await settings(page, { setupDismissed: false, clock24: true }) });
    await complete(page, 0, failed ? 'Old dismissal failed' : undefined);
    await expect(setup(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'displaySetupCard.gotIt', exact: true })).toBeEnabled();
    await expect(clock(page)).toHaveAttribute('data-clock24', 'true');
    expect(await page.evaluate(() => window.__displayProbe.notices)).toEqual([]);
  });
}

test('dismissal completion merges the flag without restoring old same-family preferences', async ({ page }) => {
  await page.getByRole('button', { name: 'displaySetupCard.gotIt', exact: true }).click();
  await refresh(page, { initialTiles: layout('reminders'), initialSettings: await settings(page, { clock24: true }) });
  await complete(page, 0);
  await expect(setup(page)).toHaveCount(0);
  await expect(clock(page)).toHaveAttribute('data-clock24', 'true');
  await expect(page.getByText('Reminders', { exact: true })).toBeVisible();
});

test('a rejected save retains the draft and re-enables retry without an unhandled rejection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await edit(page);
  await tileEditor(page).selectOption('chores');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await complete(page, 0, 'Fixture offline', true);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(tileEditor(page)).toHaveValue('chores');
  expect(await page.evaluate(() => window.__displayProbe.notices)).toEqual([{ kind: 'error', message: 'Fixture offline' }]);
  expect(errors).toEqual([]);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await page.evaluate(() => window.__displayProbe.writes)).toHaveLength(2);
});

test('a rejected dismissal keeps the card and re-enables retry without an unhandled rejection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: 'displaySetupCard.gotIt', exact: true }).click();
  await complete(page, 0, 'Fixture offline', true);
  await expect(setup(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'displaySetupCard.gotIt', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__displayProbe.notices)).toEqual([{ kind: 'error', message: 'Fixture offline' }]);
  expect(errors).toEqual([]);
  await page.getByRole('button', { name: 'displaySetupCard.gotIt', exact: true }).click();
  expect(await page.evaluate(() => window.__displayProbe.writes)).toHaveLength(2);
});

test('reset changes the layout draft while retaining settings, and cancel restores persisted state', async ({ page }) => {
  await edit(page);
  await page.getByRole('button', { name: '24h', exact: true }).click();
  await page.getByRole('button', { name: 'displayGrid.resetLayout', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'displayGrid.section', exact: true })).toHaveCount(9);
  await expect(clock(page)).toHaveAttribute('data-clock24', 'true');
  await page.getByRole('button', { name: 'displayGrid.cancel', exact: true }).click();
  await expect(clock(page)).toHaveAttribute('data-clock24', 'false');
  await expect(page.getByText("Today's Schedule", { exact: true })).toBeVisible();
});

test('a save resolving after unmount produces no completion toast', async ({ page }) => {
  await edit(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.evaluate(() => window.__displayProbe.unmount());
  await complete(page, 0);
  expect(await page.evaluate(() => window.__displayProbe.notices)).toEqual([]);
});

test('unavailable reads hide stale rows and calendar dots, then recover with refreshed data', async ({ page }) => {
  const data = await page.evaluate(() => {
    const now = Date.now();
    const event = { id: 'event', title: 'Visible family event', starts_at: new Date(now + 120000).toISOString(), ends_at: new Date(now + 3600000).toISOString(), all_day: false, location: null, assignee_id: null };
    return { ...window.__displayProbe.props.data, events: [event], upcoming: [{ ...event, id: 'future', title: 'Visible upcoming event' }],
      reminders: [{ id: 'reminder', title: 'Visible family reminder', remind_at: new Date(now).toISOString() }],
      calendar: { year: 2026, month: 8, today: 12, eventDays: [14, 15] },
      loadStatus: { events: 'error', upcoming: 'error', monthEvents: 'error', reminders: 'error' } as const };
  });
  await refresh(page, { data, initialTiles: [...layout('schedule'), ...layout('upcoming'), ...layout('calendar'), ...layout('reminders')] });
  for (const key of ['scheduleUnavailable', 'upcomingUnavailable', 'calendarUnavailable', 'remindersUnavailable', 'dataUnavailable']) {
    await expect(page.getByText(`displayGrid.${key}`, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('Visible family event', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Visible upcoming event', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Visible family reminder', { exact: true })).toHaveCount(0);
  await expect(page.getByText('September 2026', { exact: true })).toBeVisible();
  await expect(page.locator('span.h-1.w-1.bg-brand')).toHaveCount(0);
  await expect(page.locator('[data-hints]')).not.toContainText('All clear');
  await expect(page.locator('[data-hints]')).not.toContainText('Visible family event');
  await expect(page.locator('[data-frame-next]')).toHaveAttribute('data-frame-next', '');
  await refresh(page, { data: { ...data, loadStatus: { events: 'ok', upcoming: 'ok', monthEvents: 'ok', reminders: 'ok' } } });
  await expect(page.getByText('displayGrid.dataUnavailable', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Visible family event', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Visible upcoming event', { exact: true })).toBeVisible();
  await expect(page.getByText('Visible family reminder', { exact: true })).toBeVisible();
  await expect(page.locator('span.h-1.w-1.bg-brand')).toHaveCount(2);
  await expect(page.locator('[data-frame-next]')).toHaveAttribute('data-frame-next', /Visible family event/);
});

test('a reminder failure preserves a verified calendar hint without claiming all clear', async ({ page }) => {
  const data = await page.evaluate(() => ({ ...window.__displayProbe.props.data,
    events: [{ id: 'event', title: 'Verified calendar event', starts_at: new Date(Date.now() + 120000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(), all_day: false, location: null, assignee_id: null }],
    reminders: [{ id: 'stale', title: 'Unread reminder', remind_at: new Date().toISOString() }],
    loadStatus: { events: 'ok', upcoming: 'ok', monthEvents: 'ok', reminders: 'error' } as const,
  }));
  await refresh(page, { data, initialTiles: layout('reminders') });
  await expect(page.getByText('displayGrid.remindersUnavailable', { exact: true })).toBeVisible();
  await expect(page.locator('[data-hints]')).toContainText('Verified calendar event');
  await expect(page.locator('[data-hints]')).not.toContainText('reminder coming up');
  await expect(page.locator('[data-hints]')).not.toContainText('All clear');
});

test('an event failure preserves verified reminder content and hints', async ({ page }) => {
  const data = await page.evaluate(() => ({ ...window.__displayProbe.props.data,
    reminders: [{ id: 'reminder', title: 'Verified reminder', remind_at: new Date().toISOString() }],
    loadStatus: { events: 'error', upcoming: 'ok', monthEvents: 'ok', reminders: 'ok' } as const,
  }));
  await refresh(page, { data, initialTiles: layout('reminders') });
  await expect(page.getByText('Verified reminder', { exact: true })).toBeVisible();
  await expect(page.locator('[data-hints]')).toContainText('1 reminder coming up');
  await expect(page.locator('[data-hints]')).not.toContainText('All clear');
});

test('a successful empty read remains an honest empty state', async ({ page }) => {
  const data = await page.evaluate(() => ({ ...window.__displayProbe.props.data,
    loadStatus: { events: 'ok', upcoming: 'ok', monthEvents: 'ok', reminders: 'ok' } as const,
  }));
  await refresh(page, { data, initialTiles: [...layout('schedule'), ...layout('reminders')] });
  await expect(page.getByText('displayGrid.nothingScheduledToday', { exact: true })).toBeVisible();
  await expect(page.getByText('displayGrid.noRemindersDue', { exact: true })).toBeVisible();
  await expect(page.getByText('displayGrid.dataUnavailable', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-hints]')).toContainText('All clear');
});

test('family timezone formats event times and timed dates while preserving all-day dates', async ({ page }) => {
  const data = await page.evaluate(() => ({ ...window.__displayProbe.props.data, timezone: 'America/Los_Angeles',
    events: [{ id: 'timed', title: 'Timed event', starts_at: '2026-09-12T02:00:00Z', ends_at: '2026-09-12T03:00:00Z', all_day: false, location: null, assignee_id: null }],
    upcoming: [
      { id: 'timed', title: 'Timed next date', starts_at: '2026-09-12T02:00:00Z', all_day: false, location: null, assignee_id: null },
      { id: 'all-day', title: 'All-day next date', starts_at: '2026-09-12T00:00:00Z', all_day: true, location: null, assignee_id: null },
    ],
  }));
  await refresh(page, { data, initialTiles: [...layout('schedule'), ...layout('upcoming'), ...layout('clock')] });
  await expect(page.getByText('7:00 PM', { exact: true })).toBeVisible();
  await expect(page.getByText('Timed next date', { exact: true }).locator('..')).toContainText('Sep 11');
  await expect(page.getByText('All-day next date', { exact: true }).locator('..')).toContainText('Sep 12');
  await expect(clock(page)).toHaveAttribute('data-timezone', 'America/Los_Angeles');
  await expect(page.locator('[data-frame-zone]')).toHaveAttribute('data-frame-zone', 'America/Los_Angeles');
  await refresh(page, { initialSettings: await settings(page, { clock24: true }) });
  await expect(page.getByText('19:00', { exact: true })).toBeVisible();
  for (const item of await page.locator('[data-clock24]').all()) await expect(item).toHaveAttribute('data-clock24', 'true');
  await page.evaluate(() => { window.__displayProbe.localeCode = 'fr-FR'; window.__displayProbe.render(); });
  await expect(page.getByText('Timed next date', { exact: true }).locator('..')).toContainText('11 sept.');
  await expect(page.getByText('All-day next date', { exact: true }).locator('..')).toContainText('12 sept.');
});

test('timezone fallback is visible and invalid input renders safely in UTC', async ({ page }) => {
  const data = await page.evaluate(() => ({ ...window.__displayProbe.props.data, timezone: 'Invalid/Fixture', timezoneFallback: true }));
  await refresh(page, { data });
  await expect(page.getByText('displayGrid.timezoneFallback', { exact: true })).toBeVisible();
  await expect(clock(page)).toHaveAttribute('data-timezone', 'UTC');
  await expect(page.locator('[data-frame-zone]')).toHaveAttribute('data-frame-zone', 'UTC');
});

test('a delayed setup write cannot overwrite a newer durable layout save', async ({ page }) => {
  await page.getByRole('button', { name: 'displaySetupCard.gotIt', exact: true }).click();
  await edit(page);
  await tileEditor(page).selectOption('chores');
  // Try saving while dismissal is unresolved. If it is allowed through, force
  // the newer save to finish first: the old bug then overwrites its row.
  await page.getByRole('button', { name: 'Save', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  const writeCount = await page.evaluate(() => window.__displayProbe.writes.length);
  if (writeCount === 2) {
    await complete(page, 1);
    await complete(page, 0);
  } else {
    expect(writeCount).toBe(1);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await complete(page, 0);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await complete(page, 1);
  }
  expect(await page.evaluate(() => window.__displayProbe.stored['family-A'].tiles)).toEqual(layout('chores', 'A'));
  expect(await page.evaluate(() => window.__displayProbe.stored['family-A'].settings.setupDismissed)).toBe(true);
});

for (const action of ['save', 'dismiss'] as const) {
  test(`${action} claims the shared write slot before React flushes state`, async ({ page }) => {
    if (action === 'save') await edit(page);
    const button = page.getByRole('button', { name: action === 'save' ? 'Save' : 'displaySetupCard.gotIt', exact: true });
    await button.evaluate((element) => {
      // Call the mounted React handler twice in one turn before its pending
      // state can commit. This specifically tests the synchronous ref guard.
      const key = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
      if (!key) throw new Error('Missing mounted React button props');
      const props = (element as unknown as Record<string, { onClick: () => void }>)[key];
      props.onClick();
      props.onClick();
    });
    expect(await page.evaluate(() => window.__displayProbe.writes)).toHaveLength(1);
    await complete(page, 0);
  });
}

test('pending save guards dismissal and preserves a newer editor draft', async ({ page }) => {
  await edit(page);
  await tileEditor(page).selectOption('chores');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await tileEditor(page).selectOption('reminders');
  await edit(page);
  const dismiss = page.getByRole('button', { name: 'displaySetupCard.gotIt', exact: true });
  await expect(dismiss).toBeDisabled();
  await dismiss.evaluate((element) => {
    const key = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
    if (!key) throw new Error('Missing mounted React button props');
    (element as unknown as Record<string, { onClick: () => void }>)[key].onClick();
  });
  expect(await page.evaluate(() => window.__displayProbe.writes)).toHaveLength(1);
  await edit(page);
  await complete(page, 0);
  await expect(tileEditor(page)).toHaveValue('reminders');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__displayProbe.stored['family-A'].tiles)).toEqual(layout('chores', 'A'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await complete(page, 1);
  expect(await page.evaluate(() => window.__displayProbe.stored['family-A'].tiles)).toEqual(layout('reminders', 'A'));
});

test('cancel cannot revert the UI while an issued save can still succeed', async ({ page }) => {
  await edit(page);
  await tileEditor(page).selectOption('chores');
  await page.getByRole('button', { name: '24h', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const cancel = page.getByRole('button', { name: 'displayGrid.cancel', exact: true });
  await expect(cancel).toBeDisabled();
  await cancel.evaluate((element) => {
    const key = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
    if (!key) throw new Error('Missing mounted React button props');
    (element as unknown as Record<string, { onClick: () => void }>)[key].onClick();
  });
  await complete(page, 0);
  await expect(page.getByText('displayGrid.displaySettings', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Chores', { exact: true })).toBeVisible();
  await expect(clock(page)).toHaveAttribute('data-clock24', 'true');
  expect(await page.evaluate(() => window.__displayProbe.stored['family-A'].tiles)).toEqual(layout('chores', 'A'));
});
