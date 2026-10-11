import { expect, test, type Page } from '@playwright/test';
import { hoverReveals, sourceFiles } from '../helpers/hover-reveals';

// A11Y-001 (WCAG 2.4.7), in the app's real CSS: every element the source hides
// until its row is hovered (tests/helpers/hover-reveals.ts reads them with the
// TypeScript parser) is rebuilt on /login, which loads the app's stylesheet,
// with ALL its own classes (display and responsive ones included; only the
// transition classes are left off, so a reading is never mid-fade) inside a
// `group`. A focusable one is a button; a wrapper holds a button. Then:
//   - at 1280 px with a mouse, each starts hidden (the desktop hover reveal is
//     kept) and is shown while it, or the button inside it, has keyboard focus;
//   - on a touch screen at 1280 px, and at 390 px, each is shown without hover.
// "Shown" is three things: displayed (not display:none), a real box (non-zero
// size) and opaque. The rows themselves only render in a household with data,
// which the e2e accounts do not have; the classes are the part that decides.
// (The populated rows were checked by hand on a seeded local household; see
// the PR.)

test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block' });

const reveals = hoverReveals([...sourceFiles('app'), ...sourceFiles('components')]);
/** Every class but the ones that animate (a reading mid-fade would be neither 0 nor 1). */
const staticClasses = (classes: string[]) => classes.filter((c) => !/(^|:)(transition|duration-|ease-|animate-|delay-)/.test(c)).join(' ');

async function mount(page: Page) {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.evaluate((items) => {
    const host = document.createElement('div');
    host.id = 'reveal-fixture';
    for (const [index, item] of items.entries()) {
      const row = document.createElement('div');
      row.className = 'group relative'; // as the real rows and cards are, so an absolute reveal stays inside its own
      row.style.minHeight = '40px'; // the room a real row's content gives an absolute overlay (the photos card)
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
  }, reveals.map((r) => ({ classes: staticClasses(r.classes), focusable: r.focusable })));
}

/** How each revealed element renders: 'shown', or what keeps it from being seen. */
const states = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'), (el) => {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  if (cs.display === 'none') return 'display:none';
  if (r.width < 1 || r.height < 1) return 'no box';
  return cs.opacity === '1' ? 'shown' : `opacity ${cs.opacity}`;
}));
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
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const state = getComputedStyle(el).display === 'none' ? 'display:none' : r.width < 1 || r.height < 1 ? 'no box'
        : getComputedStyle(el).opacity === '1' ? 'shown' : `opacity ${getComputedStyle(el).opacity}`;
      return { index: Number(el.dataset.reveal), state };
    });
    expect(seen, `Tab ${i + 1} reaches fixture button ${i}`).toMatchObject({ index: i });
    if (seen!.state !== 'shown') hidden.push(`${reveals[i].at} <${reveals[i].tag}> ${seen!.state}`);
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
    const shown = await states(page);
    expect(shown).toHaveLength(reveals.length);
    expect(reveals.map((r, i) => `${r.at} <${r.tag}> ${shown[i]}`).filter((line) => !line.endsWith(' shown'))).toEqual([]);
    await context.close();
  });
}
