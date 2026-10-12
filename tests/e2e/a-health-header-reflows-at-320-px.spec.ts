import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { cn } from '../../lib/utils/cn';

// A11Y-001, WCAG 1.4.10 (reflow): the visits and immunizations headers at
// 320 px, with a long member name in the member filter and the Add control
// beside it, as the built CSS lays them out.
//
// The header (title, then the filter and Add) wraps; inside it the filter and
// Add sat in a row that did not, and a <select> is as wide as its longest
// option. On /dashboard/medical at 320 px a 52-character name made the select
// 482 px and the page 575 px wide. The row now wraps and the select is capped
// at the row's width: it shrinks (the chosen name is clipped in the closed
// control; the open list shows it whole) and Add goes to the next line.
//
// Each header is built from its module's own class strings, read from the
// source (Add is the shared Button, merged with the same cn()), and placed on
// the sign-in page (no account needed) at 296 px, the header's width at a
// 320 px viewport (12 px of shell padding each side), and at 240 px.
//
// A scratch sweep that chose the same long name in every member filter on all
// 246 member routes found two more filters that ran past the edge the same way:
// the activity feed's (494 px) and the timetable's (510 px). They are capped at
// their row too, and held here the same way.
test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block' });

const LONG = 'Maximiliana Alexandrina Featherstonehaugh-Montgomery';
const SHORT = 'Ada';

function sourceString(source: string, pattern: RegExp, what: string): string {
  const m = source.match(pattern);
  if (!m) throw new Error(`${what} not found in the source`);
  return m[1];
}

const button = readFileSync('components/ui/button.tsx', 'utf8');
const BUTTON = cn(
  sourceString(button, /'(inline-flex select-none [^']+)'/, "Button's base classes"),
  sourceString(button, /primary:\s+'([^']+)'/, "Button's primary variant"),
  sourceString(button, /sm: '([^']+)'/, "Button's sm size"),
);

type Header = { outer: string; title: string; row: string; select: string };

/** The header's classes: its wrapping row, its title, the filter-and-Add row, and the filter. */
function header(file: string): Header {
  const src = readFileSync(file, 'utf8');
  const block = sourceString(src, /(<div className="[^"]*justify-between[^"]*">\s*<h3[\s\S]*?<\/select>)/, `${file}'s header`);
  return {
    outer: sourceString(block, /^<div className="([^"]+)"/, `${file}'s header row`),
    title: sourceString(block, /<h3 className="([^"]+)"/, `${file}'s title`),
    row: sourceString(block, /<\/h3>\s*<div className="([^"]+)"/, `${file}'s filter row`),
    select: sourceString(block, /<select [\s\S]*?className="([^"]+)"/, `${file}'s filter`),
  };
}

const MODULES: [string, string, string][] = [
  ['visits', 'components/modules/health-visits-module.tsx', 'Add visit'],
  ['immunizations', 'components/modules/immunizations-module.tsx', 'Add'],
];

const fixture = (width: number, name: string, h: (file: string) => Header) => `
  <div id="fixture" class="bg-bg" style="position:absolute;left:0;top:0;width:${width}px">
    ${MODULES.map(([id, file, add]) => { const c = h(file); return `
      <div data-module="${id}" class="${c.outer}">
        <h3 class="${c.title}"><span class="h-4 w-4"></span> ${id === 'visits' ? 'Visit history' : 'Immunizations &amp; vaccines'}</h3>
        <div class="${c.row}">
          <select aria-label="Family member" class="${c.select}">
            <option value="all">Everyone</option>
            <option value="m" selected>${name}</option>
          </select>
          <button type="button" class="${BUTTON}"><span class="h-4 w-4"></span> ${add}</button>
        </div>
      </div>`; }).join('')}
  </div>`;

async function open(page: Page, html: string) {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/login', { waitUntil: 'networkidle' });
  // After hydration, outside React's tree, so nothing re-renders it away.
  await expect(page.locator('input[name="email"]')).toBeEditable();
  await page.evaluate((h) => document.body.insertAdjacentHTML('beforeend', h), html);
  await expect(page.locator('#fixture')).toBeAttached();
}

type Layout = { module: string; past: string[]; select: { w: number; top: number }; add: { top: number } };

/** For each header: what ends past the fixture's right edge, and where the filter and Add sit. */
function layout(page: Page): Promise<Layout[]> {
  return page.locator('#fixture').evaluate((root) => {
    const edge = root.getBoundingClientRect().right;
    return Array.from(root.querySelectorAll<HTMLElement>('[data-module]')).map((m) => {
      const past = Array.from(m.querySelectorAll<HTMLElement>('*'))
        .filter((e) => e.getBoundingClientRect().right > edge + 0.5)
        .map((e) => `${e.tagName.toLowerCase()} ends at ${Math.round(e.getBoundingClientRect().right)} (edge ${Math.round(edge)})`);
      const s = m.querySelector('select')!.getBoundingClientRect();
      const a = m.querySelector('button')?.getBoundingClientRect();
      return { module: m.dataset.module!, past, select: { w: Math.round(s.width), top: Math.round(s.top) }, add: { top: a ? Math.round(a.top) : NaN } };
    });
  });
}

test.describe('the visits and immunizations headers reflow at 320 px', () => {
  for (const width of [296, 240]) {
    test(`a long member name and Add fit in ${width} px`, async ({ page }) => {
      await open(page, fixture(width, LONG, header));
      const found = await layout(page);
      expect(found.map((l) => l.module)).toEqual(['visits', 'immunizations']);
      for (const l of found) {
        expect(l.past, l.module).toEqual([]);
        expect(l.select.w, `${l.module}: the filter takes the row`).toBe(width);
        expect(l.add.top, `${l.module}: Add wraps below the filter`).toBeGreaterThan(l.select.top);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    });
  }

  test('a short name keeps the filter and Add on one line', async ({ page }) => {
    await open(page, fixture(296, SHORT, header));
    for (const l of await layout(page)) {
      expect(l.past, l.module).toEqual([]);
      expect(l.add.top, `${l.module}: Add beside the filter`).toBe(l.select.top);
    }
  });

  test('control: the previous filter row, which did not wrap or shrink, runs past the edge', async ({ page }) => {
    const before = (file: string): Header => {
      const c = header(file);
      return { ...c, row: 'flex items-center gap-2', select: c.select.replace('min-w-0 max-w-full ', '') };
    };
    expect(before(MODULES[0][1]).select).not.toContain('max-w-full'); // the replacement took
    await open(page, fixture(296, LONG, before));
    for (const l of await layout(page)) expect(l.past.length, l.module).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeGreaterThan(320);
  });
});

// The activity feed's member filter sits at the end of its wrapping filter row;
// the timetable's is the shared Select (components/ui/input.tsx) in its own row.
const input = readFileSync('components/ui/input.tsx', 'utf8');
const SELECT_BASE = cn(
  sourceString(input, /const base =\s+'([^']+)'/, "the shared fields' base classes"),
  sourceString(input, /<select ref=\{ref\} className=\{cn\(base, '([^']+)'/, "Select's own classes"),
);
const activity = readFileSync('app/(app)/dashboard/activity/activity-feed.tsx', 'utf8');
const timetable = readFileSync('components/modules/timetable-module.tsx', 'utf8');
const FILTERS: { id: string; row: string; select: string }[] = [
  {
    id: 'activity',
    row: sourceString(activity, /\{\/\* Filters \*\/\}\s*<div className="([^"]+)"/, "the activity feed's filter row"),
    select: sourceString(activity, /<select aria-label=\{t\('fieldName\.filterByMember'\)\}[\s\S]*?className="([^"]+)"/, "the activity feed's member filter"),
  },
  {
    id: 'timetable',
    row: sourceString(timetable, /<div className="([^"]+)">\s*\{\/\* Member filter \*\/\}/, "the timetable's filter row"),
    select: cn(SELECT_BASE, sourceString(timetable, /aria-label=\{t\('timetable\.student'\)\} className="([^"]+)"/, "the timetable's member filter")),
  },
];

const filters = (strip: (c: string) => string) => `
  <div id="fixture" class="bg-bg" style="position:absolute;left:0;top:0;width:296px">
    ${FILTERS.map((f) => `
      <div data-module="${f.id}" class="${f.row}">
        <span class="h-4 w-4"></span>
        <select aria-label="Family member" class="${strip(f.select)}">
          <option value="all">Everyone</option>
          <option value="m" selected>${LONG}</option>
        </select>
      </div>`).join('')}
  </div>`;

test.describe('the other member filters a long name widened', () => {
  test('the activity feed and timetable filters fit in 296 px with a long name', async ({ page }) => {
    await open(page, filters((c) => c));
    const found = await layout(page);
    expect(found.map((l) => l.module)).toEqual(['activity', 'timetable']);
    for (const l of found) expect(l.past, l.module).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  });

  test('control: without the cap, both run past the edge', async ({ page }) => {
    for (const f of FILTERS) expect(f.select, f.id).toContain('max-w-full');
    await open(page, filters((c) => c.replace(/ ?\bmin-w-0 max-w-full\b/, '')));
    for (const l of await layout(page)) expect(l.past.length, l.module).toBeGreaterThan(0);
  });
});
