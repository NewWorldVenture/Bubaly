import { expect, test, type Page } from '@playwright/test';
import { hoverReveals, sourceFiles } from '../helpers/hover-reveals';

// A11Y-001 (WCAG 2.4.7), in the app's real CSS: every element the source hides
// until its row is hovered (tests/helpers/hover-reveals.ts reads them with the
// TypeScript parser) is rebuilt on /login, which loads the app's stylesheet,
// with its own opacity classes inside a `group`. A focusable one is a button;
// a wrapper holds a button. Then:
//   - at 1280 px with a mouse, each starts hidden (the desktop hover reveal is
//     kept) and is shown while it, or the button inside it, has keyboard focus;
//   - on a touch screen at 1280 px, and at 390 px, each is shown without hover.
// The rows themselves only render in a household with data, which the e2e
// accounts do not have; the classes are the part that decides.

test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block' });

const reveals = hoverReveals([...sourceFiles('app'), ...sourceFiles('components')]);
/** Only the opacity utilities (not `transition-opacity`, which would animate the reading). */
const opacityClasses = (classes: string[]) => classes.filter((c) => /(^|:)opacity-/.test(c)).join(' ');

async function mount(page: Page) {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.evaluate((items) => {
    const host = document.createElement('div');
    host.id = 'reveal-fixture';
    for (const [index, item] of items.entries()) {
      const row = document.createElement('div');
      row.className = 'group';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `action ${index}`;
      if (item.focusable) {
        button.className = item.classes;
        button.dataset.reveal = String(index);
        row.append(button);
      } else {
        const wrapper = document.createElement('div');
        wrapper.className = item.classes;
        wrapper.dataset.reveal = String(index);
        wrapper.append(button);
        row.append(wrapper);
      }
      host.append(row);
    }
    document.body.prepend(host);
  }, reveals.map((r) => ({ classes: opacityClasses(r.classes), focusable: r.focusable })));
}

/** The opacity of every revealed element, by index. */
const opacities = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'), (el) => getComputedStyle(el).opacity));

test('the source has hover-revealed controls to check (non-vacuity)', () => {
  expect(reveals.length).toBeGreaterThan(30);
});

test('at 1280 px with a mouse, each is hidden until hovered, and shown while it or its button has keyboard focus', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await mount(page);
  expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(true);
  // Desktop keeps the clean row: nothing shows until the row is hovered.
  expect(new Set(await opacities(page))).toEqual(new Set(['0']));
  await page.locator('#reveal-fixture .group').first().hover();
  expect((await opacities(page))[0]).toBe('1');
  await page.mouse.move(0, 799);

  // Tab from the top of the page through every fixture button.
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  const hidden: string[] = [];
  for (let i = 0; i < reveals.length; i += 1) {
    await page.keyboard.press('Tab');
    const seen = await page.evaluate(() => {
      const el = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-reveal]');
      return el ? { index: Number(el.dataset.reveal), opacity: getComputedStyle(el).opacity } : null;
    });
    expect(seen, `Tab ${i + 1} reaches fixture button ${i}`).toMatchObject({ index: i });
    if (seen!.opacity !== '1') hidden.push(`${reveals[i].at} <${reveals[i].tag}> opacity ${seen!.opacity}`);
  }
  expect(hidden).toEqual([]);
  await context.close();
});

for (const [name, options] of [
  ['on a touch screen at 1280 px', { viewport: { width: 1280, height: 800 }, hasTouch: true, isMobile: true }],
  ['at 390 px', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
] as const) {
  test(`${name}, each is shown without hover`, async ({ browser }) => {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await mount(page);
    if (name.startsWith('on a touch')) expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const shown = await opacities(page);
    expect(shown).toHaveLength(reveals.length);
    expect(reveals.filter((_, i) => shown[i] !== '1').map((r) => `${r.at} <${r.tag}>`)).toEqual([]);
    await context.close();
  });
}
