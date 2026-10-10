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

  /** The hero's text box and Send can be seen, pointed at, reached by Tab and typed in. */
  async function expectUsableHero(page: Page, box: Locator, send: Locator) {
    const at = await geometry(box);
    expect(at.width, 'text box width').toBeGreaterThan(100);
    expect(at.hitsItself, 'a pointer at the text box lands on it').toBe(true);
    await expect(box).toBeVisible();
    expect(await tabTo(page, box), 'Tab reaches the text box').not.toBeNull();
    await page.keyboard.type('Plan dinners');
    await expect(box).toHaveValue('Plan dinners');
    expect((await geometry(box)).width, 'and it is still a box you can see while typing').toBeGreaterThan(100);
    const sendAt = await geometry(send);
    expect(sendAt.width).toBe(44);
    expect(sendAt.hitsItself, 'a pointer at Send lands on it').toBe(true);
    await send.focus();
    await expect(send).toBeFocused();
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
    // Opening a thread scrolls to its foot smoothly; read the box once it is
    // in view and has stopped moving.
    await box.scrollIntoViewIfNeeded();
    await settled(box);
    const at = await geometry(box);
    expect(at.width).toBeGreaterThan(100);
    expect(at.hitsItself).toBe(true);
    await box.click();
    await page.keyboard.type('And on Friday?');
    await expect(box).toHaveValue('And on Friday?');
    expect((await geometry(left.getByRole('button', { name: 'Send' }))).hitsItself).toBe(true);
    expect(await overflow(page)).toEqual({ page: 0, main: 0 });

    // "New chat" returns to the hero, which works at this width too.
    await left.getByRole('button', { name: 'New chat' }).click();
    const pane = page.getByRole('region', { name: 'Plan and results' });
    const hero = pane.getByRole('textbox', { name: 'Ask Bubaly' });
    await expect(hero).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await settled(hero);
    await expectUsableHero(page, hero, pane.getByRole('button', { name: 'Send' }));
  });
});
