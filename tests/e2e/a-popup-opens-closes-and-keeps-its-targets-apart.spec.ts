import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// A11Y-001: the popups a member opens, found by opening every dialog and menu
// on the 241 member routes of a seeded household (the earlier sweeps read the
// pages closed).
//
// The country picker (settings, family settings, and phone sign-in) gave its
// whole panel role="listbox": the search field and the list sat inside it, and
// its 52 options were owned by a <ul>, not the listbox (axe, critical:
// aria-required-children, aria-required-parent). Escape did not close it, and
// choosing a country left focus on <body>. Now the list alone is the listbox,
// Escape closes the panel, and closing hands focus back to the button. That
// button also toggles the panel shut; before, its own mousedown counted as an
// outside click and the click reopened it.
//
// The messages composer's emoji panel had no width of its own inside its
// 32 px wrapper. Its four-column grid shrank to fit, and the 32 px buttons
// overlapped 4.5 px apart, so a tap could land on the neighbouring emoji (axe:
// target-size, WCAG 2.5.8). It is `w-max` now. It is checked here from its own
// class strings, placed on the sign-in page (no account needed).
test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block' });

const browserFailures = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const failures: string[] = [];
  browserFailures.set(page, failures);
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') failures.push(`console ${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => failures.push(`page error: ${error.message}`));
  page.on('requestfailed', (request) => failures.push(`request failed: ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`));
  page.on('response', (response) => { if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${response.url()}`); });
});
test.afterEach(({ page }) => {
  expect(browserFailures.get(page), 'no console, page, request or HTTP failures').toEqual([]);
});

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function phonePicker(page: Page) {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Continue with phone' }).click();
  const trigger = page.getByRole('button', { name: /^Country: / });
  await expect(trigger).toBeVisible();
  return trigger;
}

test.describe('the country picker', () => {
  test('is a listbox of its options, which axe passes', async ({ page }) => {
    const trigger = await phonePicker(page);
    await trigger.focus();
    await page.keyboard.press('Enter');
    const list = page.getByRole('listbox', { name: 'Select country' });
    await expect(list).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const id = await list.getAttribute('id');
    expect(id, 'the listbox has an id its button points to').toBeTruthy();
    await expect(trigger).toHaveAttribute('aria-controls', id!);
    await expect(page.getByRole('textbox', { name: 'Search country or code…' })).toBeFocused();
    // Every option is owned by the listbox.
    const options = page.getByRole('option');
    expect(await options.count()).toBeGreaterThan(50);
    expect(await list.getByRole('option').count()).toBe(await options.count());
    const panel = list.locator('xpath=..');
    await panel.evaluate((p) => p.setAttribute('data-panel', ''));
    const axe = await new AxeBuilder({ page }).include('[data-panel]').withTags(TAGS).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });

  test('Escape closes it and focus returns to its button, from the search field or from the button itself', async ({ page }) => {
    const trigger = await phonePicker(page);
    const search = page.getByRole('textbox', { name: 'Search country or code…' });
    // From the search field, once the panel has taken focus.
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(search).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // From the button, before focus has moved into the panel.
    await trigger.click();
    await trigger.focus();
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('choosing a country by keyboard closes it and focus returns to its button', async ({ page }) => {
    const trigger = await phonePicker(page);
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'Search country or code…' }).fill('Germany');
    const germany = page.getByRole('option', { name: /Germany/ });
    await germany.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    const chosen = page.getByRole('button', { name: 'Country: Germany' });
    await expect(chosen).toBeFocused();
  });

  test('its button toggles it shut, and a search with no match leaves no empty listbox', async ({ page }) => {
    const trigger = await phonePicker(page);
    await trigger.click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.getByRole('textbox', { name: 'Search country or code…' }).fill('zzzz');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(page.getByText('No countries found')).toBeVisible();
    await trigger.click();
    await expect(page.getByRole('textbox', { name: 'Search country or code…' })).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});

function sourceString(file: string, pattern: RegExp, what: string): string {
  const m = readFileSync(file, 'utf8').match(pattern);
  if (!m) throw new Error(`${what} not found in ${file}`);
  return m[1];
}

test.describe('the emoji panel', () => {
  const src = 'components/modules/messages-module.tsx';
  const panel = sourceString(src, /setShowPicker\(!showPicker\)[\s\S]*?\{showPicker && \(\s*<div className="([^"]+)">/, 'the emoji panel');
  const grid = sourceString(src, /\{showPicker && \(\s*<div className="[^"]+">\s*<div className="([^"]+)">/, "the emoji panel's grid");
  const cell = sourceString(src, /QUICK_EMOJIS\.map\(\(e\) => \([\s\S]*?className="([^"]+)">\{e\}<\/button>/, 'an emoji button');
  const trigger = sourceString(src, /aria-label=\{tr\('messages\.emoji'\)\} aria-expanded=\{showPicker\}\s*className="([^"]+)"/, 'the emoji button');

  async function place(page: Page, panelClasses: string) {
    await page.goto('/login', { waitUntil: 'networkidle' });
    await expect(page.locator('input[name="email"]')).toBeEditable();
    const emojis = ['😀', '🎉', '👏', '✅', '🙏', '💪', '🤣', '😍'];
    await page.evaluate((h) => document.body.insertAdjacentHTML('beforeend', h), `
      <div id="fixture" style="position:fixed;left:200px;bottom:200px;z-index:9999" class="bg-surface p-4">
        <div class="relative"><button type="button" class="${trigger}">☺</button>
          <div data-panel class="${panelClasses}"><div class="${grid}">${emojis.map((e) => `<button type="button" class="${cell}">${e}</button>`).join('')}</div></div>
        </div>
      </div>`);
  }

  async function overlaps(page: Page): Promise<string[]> {
    return page.locator('[data-panel] button').evaluateAll((bs) => {
      const rects = bs.map((b) => b.getBoundingClientRect());
      const out: string[] = [];
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const [a, b] = [rects[i], rects[j]];
        if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) out.push(`${i}×${j}`);
      }
      return out;
    });
  }

  test('its buttons sit apart at 24 px or more, and axe passes their target size', async ({ page }) => {
    await place(page, panel);
    expect(await overlaps(page)).toEqual([]);
    const sizes = await page.locator('[data-panel] button').evaluateAll((bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); }));
    expect(sizes).toHaveLength(8);
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(24);
    const axe = await new AxeBuilder({ page }).include('[data-panel]').withRules(['target-size']).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });

  test('control: without its width, the grid shrinks into the 32 px wrapper and the buttons overlap', async ({ page }) => {
    expect(panel).toMatch(/\bw-max\b/);
    await place(page, panel.replace(/\s*\bw-max\b/, ''));
    expect((await overlaps(page)).length).toBeGreaterThan(0);
  });
});
