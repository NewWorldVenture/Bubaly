import { createClient } from '@supabase/supabase-js';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createOwnedAccount, requireLocalOrigin, type OwnedAccount } from './helpers/durable-session';

// The assistant's composer on /dashboard/assistant either side of lg (1024px)
// and 2xl (1536px). Seen first from the corner orb on #778; measured here on
// the page as a signed-in parent opens it.
//
// On a fresh arrival with no thread restored, and again after "New chat", the
// page shows its welcome surface ("hero"): the big "Ask Bubaly" composer. A
// restored thread, or one opened from the history, shows the thread and its
// docked "Message Bubaly" composer instead. Below lg the workspace is one pane
// at a time (Chat | Plan | Context).
//
// From lg it was three columns, lg:grid-cols-[320px_1fr_330px] with gap-6,
// inside a main of the viewport less the 280px sidebar and 2 x 28px of
// padding. The fixed tracks and gaps took 698px, so the centre column, where
// the hero sits, measured W - 1034px: 0 at 1024, 66 at 1100, 146 at 1180. The
// hero's chrome takes about 146px of that, so its text box was 0px wide up to
// about 1180px: it could not be seen or pointed at, yet it still took focus
// and text, typed blind (recorded on #778 as test.fail() rows).
//
// components/assistant/workspace.tsx now lays out two columns from lg,
// conversation and results (300px and minmax(0,1fr)), with the household
// context across both below them, and the three columns from 2xl as before.
// These cases hold the composer, the layout either side of both breakpoints,
// the context's reachability and the absence of horizontal overflow. Real
// pages, a disposable local household, synthetic records only. Any request to
// a host other than this machine is aborted and fails the test, so nothing
// reaches an AI provider; nothing here sends a message.
const enabled = process.env.E2E_AUTHENTICATED === '1';
const provider = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off' });

let account: OwnedAccount | null = null;
let external: string[] = [];

/** Signs in and lands on `to`, past the login page (whose own URL carries `to`). */
async function signIn(page: Page, to: string) {
  await page.goto(`/login?redirect=${encodeURIComponent(to)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="email"]').fill(account!.email);
  await page.locator('input[name="password"]').fill(account!.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname === to, { timeout: 60_000 });
}

/** Box, and whether a pointer at its centre lands on the control itself. */
const geometry = (control: Locator) => control.evaluate((el) => {
  const b = el.getBoundingClientRect();
  const hit = b.width && b.height ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null;
  return { width: Math.round(b.width), height: Math.round(b.height), hitsItself: !!hit && (hit === el || el.contains(hit)) };
});

/** Waits until `control` has stopped moving (smooth scrolls, entrance animations). */
const settled = (control: Locator) => control.evaluate((el) => new Promise<void>((resolve) => {
  let last = Number.NaN;
  let still = 0;
  const tick = () => {
    const top = el.getBoundingClientRect().top;
    still = top === last ? still + 1 : 0;
    last = top;
    if (still >= 5) resolve(); else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));

/** Waits until the window has stopped scrolling (a smooth scroll the page started). */
const windowSettled = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => {
  let last = Number.NaN;
  let still = 0;
  const tick = () => {
    still = scrollY === last ? still + 1 : 0;
    last = scrollY;
    if (still >= 5) resolve(); else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));

/** Where `control` is against the window and the sticky top bar, as the page left it. */
const placement = (control: Locator) => control.evaluate((el) => {
  const b = el.getBoundingClientRect();
  const bar = document.querySelector('header.app-topbar')?.getBoundingClientRect().bottom ?? 0;
  const hit = b.width && b.height ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null;
  return {
    scrollY: Math.round(scrollY), top: Math.round(b.top), bottom: Math.round(b.bottom), barBottom: Math.round(bar), viewport: innerHeight,
    hitsItself: !!hit && (hit === el || el.contains(hit)),
  };
});

/** The desktop workspace grid as laid out: its tracks, and each child's box; null below lg. */
const desktopGrid = (page: Page) => page.evaluate(() => {
  const grid = Array.from(document.querySelectorAll('div')).find((d) => d.className.includes('grid-cols-[320px_1fr_330px]'));
  if (!grid || getComputedStyle(grid).display !== 'grid') return null;
  const box = (el: Element) => {
    const b = el.getBoundingClientRect();
    return { left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width), bottom: Math.round(b.bottom) };
  };
  return { tracks: getComputedStyle(grid).gridTemplateColumns.split(' '), grid: box(grid), children: Array.from(grid.children).map(box) };
});

/** Horizontal overflow of the page and of main, in px (0 when none). */
const overflow = (page: Page) => page.evaluate(() => {
  const main = document.querySelector('main')!;
  return { page: document.documentElement.scrollWidth - innerWidth, main: main.scrollWidth - main.clientWidth };
});

/** Tab on from where focus is now until `control` holds it; the number of presses, or null. */
async function tabOnTo(page: Page, control: Locator, limit = 12) {
  for (let presses = 1; presses <= limit; presses += 1) {
    await page.keyboard.press('Tab');
    if (await control.evaluate((el) => el === document.activeElement)) return presses;
  }
  return null;
}

/** Tab from the top of the page until `control` holds focus; the number of presses, or null. */
async function tabTo(page: Page, control: Locator, limit = 120) {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  for (let presses = 1; presses <= limit; presses += 1) {
    await page.keyboard.press('Tab');
    if (await control.evaluate((el) => el === document.activeElement)) return presses;
  }
  return null;
}

test.describe('assistant: the composer and the workspace either side of lg and 2xl', () => {
  test.skip(!enabled, 'Set E2E_AUTHENTICATED=1 to run against the disposable local Supabase.');

  test.beforeEach(async ({ context }) => {
    external = [];
    await context.route('**/*', (route) => {
      const { hostname } = new URL(route.request().url());
      if (hostname === 'localhost' || hostname === '127.0.0.1') return route.continue();
      external.push(hostname);
      return route.abort();
    });
    const origin = requireLocalOrigin(provider);
    account = await createOwnedAccount(origin, serviceKey);
    const admin = createClient(origin, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error } = await admin.from('subscriptions')
      .upsert({ family_id: account.familyId, plan: 'plus', status: 'active' }, { onConflict: 'family_id' });
    if (error) throw new Error(`Assistant composer E2E could not give its household a Plus plan (${error.code ?? 'no code'}).`);
  });
  test.afterEach(async () => {
    try { await account?.dispose(); } finally { account = null; }
    expect(external, 'requests that left this machine').toEqual([]);
  });

  /** The hero composer on a fresh arrival (no thread restored): in the Chat tab below lg, in the results column from lg. */
  async function openHero(page: Page, width: number) {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page, '/dashboard/assistant');
    const pane = width >= 1024 ? page.getByRole('region', { name: 'Plan and results' }) : page.locator('#assistant-pane-chat');
    const box = pane.getByRole('textbox', { name: 'Ask Bubaly' });
    await expect(box).toBeAttached();
    await settled(box);
    return { box, send: pane.getByRole('button', { name: 'Send' }) };
  }

  /**
   * The hero's text box and Send can be seen, pointed at, reached by Tab and
   * typed in. Each is reached by Tab, never focused by script, and pointed at
   * again where that focus left it: focus can scroll the window, and a
   * control scrolled under the sticky top bar still counts as visible.
   */
  async function expectUsableHero(page: Page, box: Locator, send: Locator) {
    const at = await geometry(box);
    expect(at.width, 'text box width').toBeGreaterThan(100);
    expect(at.hitsItself, 'a pointer at the text box lands on it').toBe(true);
    await expect(box).toBeVisible();
    expect(await tabTo(page, box), 'Tab reaches the text box').not.toBeNull();
    await settled(box);
    expect((await geometry(box)).hitsItself, 'where Tab left it, a pointer at the text box lands on it').toBe(true);
    await page.keyboard.type('Plan dinners');
    await expect(box).toHaveValue('Plan dinners');
    expect((await geometry(box)).width, 'and it is still a box you can see while typing').toBeGreaterThan(100);
    const sendAt = await geometry(send);
    expect(sendAt.width).toBe(44);
    expect(sendAt.hitsItself, 'a pointer at Send lands on it').toBe(true);
    expect(await tabOnTo(page, send), 'Tab on from the text box reaches Send').not.toBeNull();
    await settled(send);
    expect((await geometry(send)).hitsItself, 'where Tab left it, a pointer at Send lands on it').toBe(true);
  }

  // From lg: the grid's tracks, and where the context sits, either side of 2xl.
  const DESKTOP = [1024, 1100, 1180, 1280, 1440, 1535, 1536, 1600] as const;
  for (const width of DESKTOP) {
    const columns = width >= 1536 ? 3 : 2;
    test(`${width}px, fresh arrival (no thread restored): the composer works, ${columns} columns, the context ${columns === 3 ? 'in the third' : 'under the two'}, no horizontal overflow`, async ({ page }) => {
      const { box, send } = await openHero(page, width);
      await expectUsableHero(page, box, send);

      const grid = await desktopGrid(page);
      expect(grid, 'the desktop grid is laid out').not.toBeNull();
      expect(grid!.tracks).toHaveLength(columns);
      const [conversation, results, context] = grid!.children;
      if (columns === 2) {
        expect(grid!.tracks[0]).toBe('300px');
        // The context spans both columns, below them.
        expect(context.top).toBeGreaterThanOrEqual(Math.max(conversation.bottom, results.bottom));
        expect(Math.abs(context.width - grid!.grid.width)).toBeLessThanOrEqual(1);
      } else {
        expect(grid!.tracks[0]).toBe('320px');
        expect(grid!.tracks[2]).toBe('330px');
        expect(context.top).toBe(results.top);
        expect(context.left).toBeGreaterThan(results.left + results.width);
      }
      expect(await overflow(page)).toEqual({ page: 0, main: 0 });

      // The context can be reached: scrolled to, pointed at and focused.
      const calendar = page.getByRole('complementary', { name: 'Context' }).locator('a[href="/dashboard/calendar"]');
      await calendar.scrollIntoViewIfNeeded();
      await settled(calendar);
      expect((await geometry(calendar)).hitsItself, 'a pointer at the context\'s Calendar link lands on it').toBe(true);
      await calendar.focus();
      await expect(calendar).toBeFocused();
    });
  }

  // Below lg: one pane at a time, the hero in the Chat tab.
  for (const width of [390, 1000, 1023] as const) {
    test(`${width}px, fresh arrival (no thread restored): the composer works in the Chat tab, Plan and Context are tabs, no horizontal overflow`, async ({ page }) => {
      const { box, send } = await openHero(page, width);
      await expectUsableHero(page, box, send);
      expect(await desktopGrid(page)).toBeNull();
      expect(await overflow(page)).toEqual({ page: 0, main: 0 });
      const tabs = page.getByRole('tablist', { name: 'Assistant workspace' });
      await tabs.getByRole('tab', { name: /Context/ }).click();
      await expect(page.locator('#assistant-pane-context')).toBeVisible();
      await expect(page.locator('#assistant-pane-chat')).toBeHidden();
      await tabs.getByRole('tab', { name: /Chat/ }).click();
      await expect(box).toBeVisible();
    });
  }

  test('scrolls stop clear of the app\'s fixed chrome, on this page and every other, at every width', async ({ page }) => {
    // app/globals.css keeps a scroll from leaving anything under the sticky
    // top bar, or under the tab bar and the floating buttons at the bottom
    // (WCAG 2.4.11). It was this page's alone between lg and 2xl (#985); the
    // keyboard walk found the same on nine other pages.
    const padding = () => page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return [s.scrollPaddingTop, s.scrollPaddingBottom];
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page, '/dashboard/assistant');
    for (const [width, expected] of [[1280, ['72px', '152px']], [1024, ['72px', '152px']], [1600, ['72px', '152px']], [1023, ['72px', '200px']], [640, ['72px', '200px']], [639, ['64px', '200px']], [390, ['64px', '200px']]] as const) {
      await page.setViewportSize({ width, height: 800 });
      await expect.poll(padding, { message: `${width}px` }).toEqual(expected);
    }
    // Another page, by the app's own navigation: the same.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('a[href="/dashboard/calendar"]:visible').first().click();
    await page.waitForURL((url) => url.pathname === '/dashboard/calendar');
    expect(await padding()).toEqual(['72px', '152px']);
    // A page without the app shell scrolls as it did.
    await page.goto('/pricing');
    await expect.poll(padding).toEqual(['auto', 'auto']);
  });

  /**
   * Tabs through `route` and returns each stop's name and, if it was hidden,
   * what hid it: judged where the smooth scroll ends, by what is painted at
   * the stop's centre.
   */
  async function tabStops(page: Page, route: string, stops: number) {
    await page.goto(route);
    // The page itself, not a redirect or an error page.
    expect(new URL(page.url()).pathname).toBe(route);
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
    const seen: { name: string; hiddenBy: string | null }[] = [];
    for (let i = 0; i < stops; i += 1) {
      await page.keyboard.press('Tab');
      seen.push(await page.evaluate(async () => {
        for (let still = 0, last = -1, frames = 0; still < 3 && frames < 120; frames += 1) {
          await new Promise(requestAnimationFrame);
          still = scrollY === last ? still + 1 : 0;
          last = scrollY;
        }
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return { name: '', hiddenBy: null };
        const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return { name, hiddenBy: null };
        const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
        const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
        const top = document.elementFromPoint(x, y);
        if (!top || top === el || el.contains(top) || top.contains(el)) return { name, hiddenBy: null };
        const chrome = (top as HTMLElement).closest('.app-topbar, nav.fixed, .fixed');
        return { name, hiddenBy: chrome ? chrome.className.toString().slice(0, 40) : null };
      }));
    }
    return seen;
  }

  test('Tab never leaves a control under the top bar or the floating buttons', async ({ page }) => {
    // Three of the pages the keyboard walk caught at 1280x720: a control
    // under the top bar (reasoning, documents) and a link under the AI orb
    // (family COO). Every Tab stop must show at least its own centre.
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await signIn(page, '/dashboard/reasoning');
    for (const route of ['/dashboard/reasoning', '/dashboard/documents', '/dashboard/family-coo']) {
      const seen = await tabStops(page, route, 70);
      expect(seen.filter((s) => s.hiddenBy).map((s) => `${route}: "${s.name}" under ${s.hiddenBy}`)).toEqual([]);
    }
  });

  test('390x844: the controls the tab bar and the AI orb hid on main are reached, and visible', async ({ page }) => {
    // On main, at this size: family COO's "View all" under the orb and
    // "Change language" under the tab bar; dental's "Add Dentist" under the
    // orb and "Add visit" under the tab bar. Each must be reached by Tab, so
    // the walk cannot pass by stopping short, and none may be hidden.
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, '/dashboard/family-coo');
    for (const [route, named] of [
      ['/dashboard/family-coo', ['View all', 'Change language']],
      ['/dashboard/dental', ['Add Dentist', 'Add visit']],
    ] as const) {
      const seen = await tabStops(page, route, 30);
      for (const name of named) {
        expect(seen.some((s) => s.name.startsWith(name)), `${route}: Tab reached "${name}"`).toBe(true);
      }
      expect(seen.filter((s) => s.hiddenBy).map((s) => `${route}: "${s.name}" under ${s.hiddenBy}`)).toEqual([]);
    }
  });

  test('1024px, a conversation opened from the history: its docked composer works, and "New chat" brings back a working hero', async ({ page }) => {
    const origin = requireLocalOrigin(provider);
    const admin = createClient(origin, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: conversation, error } = await admin.from('ai_conversations')
      .insert({ family_id: account!.familyId, user_id: account!.userId, title: 'Probe dinner plan' }).select('id').single();
    if (error) throw new Error(`Could not seed a conversation (${error.code ?? 'no code'}).`);
    const seeded = await admin.from('ai_messages').insert([
      { family_id: account!.familyId, conversation_id: conversation.id, role: 'user', content: 'What is for dinner this week?' },
      { family_id: account!.familyId, conversation_id: conversation.id, role: 'assistant', content: 'Here is a simple plan.' },
    ]);
    if (seeded.error) throw new Error(`Could not seed its messages (${seeded.error.code ?? 'no code'}).`);

    await page.setViewportSize({ width: 1024, height: 800 });
    await signIn(page, '/dashboard/assistant');
    const left = page.getByRole('complementary', { name: 'Conversation' });
    // On a fresh arrival with no thread restored it is the hero, saved
    // conversation or not.
    await expect(page.getByRole('region', { name: 'Plan and results' }).getByRole('textbox', { name: 'Ask Bubaly' })).toBeAttached();
    await left.locator('button[aria-controls="assistant-conversation-list"]').click();
    // The list's own entry (its rename and delete buttons carry no text).
    await left.locator('#assistant-conversation-list button', { hasText: 'Probe dinner plan' }).click();
    await expect(left.getByText('What is for dinner this week?')).toBeVisible();

    const box = left.getByRole('textbox', { name: 'Message Bubaly' });
    const send = left.getByRole('button', { name: 'Send' });
    // As the page leaves it: opening a thread scrolls to its foot smoothly.
    // Read the docked composer once that scroll has settled, before anything
    // here scrolls or focuses.
    await windowSettled(page);
    await settled(box);
    // Measured (Chromium, 1024x800): the window at 360 and the composer at
    // 127, below a bar ending at 72. Without the scroll padding in
    // app/globals.css it settled at 55, under the bar.
    const opened = await placement(box);
    expect(opened.top, 'as opened, the composer starts below the top bar').toBeGreaterThanOrEqual(opened.barBottom);
    expect(opened.bottom, 'and ends inside the window').toBeLessThanOrEqual(opened.viewport);
    expect(opened.hitsItself, 'as opened, a pointer at the composer lands on it').toBe(true);
    expect((await geometry(box)).width).toBeGreaterThan(100);
    // Then by keyboard and pointer from there: into the box, type, Tab to
    // Send, and point at each where focus left it.
    await box.click();
    await page.keyboard.type('And on Friday?');
    await expect(box).toHaveValue('And on Friday?');
    expect(await tabOnTo(page, send), 'Tab on from the composer reaches Send').not.toBeNull();
    await settled(send);
    expect((await geometry(send)).hitsItself, 'where Tab left it, a pointer at Send lands on it').toBe(true);
    expect(await overflow(page)).toEqual({ page: 0, main: 0 });
    // After an explicit scroll to it, still usable (kept apart from the
    // measurement above, which no repair touches).
    await box.scrollIntoViewIfNeeded();
    await settled(box);
    expect((await geometry(box)).hitsItself).toBe(true);

    // "New chat" returns to the hero. Read it first where the page leaves it.
    await left.getByRole('button', { name: 'New chat' }).click();
    const pane = page.getByRole('region', { name: 'Plan and results' });
    const hero = pane.getByRole('textbox', { name: 'Ask Bubaly' });
    await expect(hero).toBeAttached();
    await windowSettled(page);
    await settled(hero);
    // Measured (Chromium, 1024x800): the page, shorter without the thread,
    // is back at the top, and the hero at 367.
    const fresh = await placement(hero);
    expect(fresh.top, 'after New chat, the hero starts below the top bar').toBeGreaterThanOrEqual(fresh.barBottom);
    expect(fresh.bottom, 'and ends inside the window').toBeLessThanOrEqual(fresh.viewport);
    expect(fresh.hitsItself, 'after New chat, a pointer at the hero lands on it').toBe(true);
    // Then, apart from that, from the top of the page: the same checks as a fresh arrival.
    await page.evaluate(() => window.scrollTo(0, 0));
    await settled(hero);
    await expectUsableHero(page, hero, pane.getByRole('button', { name: 'Send' }));
  });
});
