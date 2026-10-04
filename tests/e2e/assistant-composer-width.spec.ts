import { createClient } from '@supabase/supabase-js';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createOwnedAccount, requireLocalOrigin, type OwnedAccount } from './helpers/durable-session';

// The assistant's welcome composer on /dashboard/assistant at the widths
// either side of lg (1024px). Seen first from the corner orb on #778; measured
// here on its own, on the page as any signed-in parent opens it.
//
// The page opens on the welcome surface ("hero") until a conversation with a
// message of the reader's is open. That is the state on every arrival, with or
// without saved conversations, and again after "New chat". Below lg the hero
// fills the Chat tab. From lg the workspace is three columns,
// lg:grid-cols-[320px_1fr_330px] with gap-6 (components/assistant/workspace.tsx),
// inside a main that is the viewport less the 280px sidebar and 2 x 28px of
// padding. The fixed tracks and gaps take 698px, so the centre column, where
// the hero sits, is W - 1034px wide, and nothing below 1034. The hero's own
// chrome (padding, send button) takes about 146px of it, so its text box is
// 0px wide up to about 1180px.
//
// Reproduced defects are marked test.fail(), as in form-error-semantics: they
// run on every pass and are expected to fail on the current source; the fix
// removes the marker. Real pages, a disposable local household, synthetic
// records only. Any request to a host other than this machine is aborted and
// reported, so nothing reaches an AI provider; the page makes none on load.
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

/** Box, what a pointer at its centre lands on, and whether that is the control itself. */
const geometry = (control: Locator) => control.evaluate((el) => {
  const b = el.getBoundingClientRect();
  const hit = b.width && b.height ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null;
  return { width: Math.round(b.width), height: Math.round(b.height), hitsItself: !!hit && (hit === el || el.contains(hit)) };
});

/** The centre column of the desktop workspace, as laid out. */
const centreColumn = (page: Page) => page.evaluate(() => {
  const grid = Array.from(document.querySelectorAll('div')).find((d) => getComputedStyle(d).display === 'grid' && d.className.includes('lg:grid-cols-[320px_1fr_330px]'));
  return grid ? Math.round(grid.children[1].getBoundingClientRect().width) : null;
});

test.describe('assistant: the welcome composer either side of lg', () => {
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

  // Below lg: one pane, the hero in the Chat tab. From lg: the centre column.
  // `centre` is that column's measured width (W - 1034, not below 0).
  const WIDTHS: ReadonlyArray<{ width: number; centre: number | null; known?: string }> = [
    { width: 768, centre: null },
    { width: 1000, centre: null },
    { width: 1023, centre: null },
    { width: 1024, centre: 0, known: 'the centre column is 0px wide' },
    { width: 1100, centre: 66, known: 'the centre column (66px) is narrower than the composer chrome' },
    { width: 1180, centre: 146, known: 'the centre column (146px) leaves the text box 0px' },
    { width: 1280, centre: 246 },
    { width: 1440, centre: 406 },
  ];

  async function openHero(page: Page, width: number) {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page, '/dashboard/assistant');
    const pane = width >= 1024 ? page.getByRole('region', { name: 'Plan and results' }) : page.locator('#assistant-pane-chat');
    const box = pane.getByRole('textbox', { name: 'Ask Bubaly' });
    await expect(box).toBeAttached();
    return { box, send: pane.getByRole('button', { name: 'Send' }) };
  }

  for (const { width, centre, known } of WIDTHS) {
    test(`${width}px: the welcome composer's text box can be seen, pointed at and typed in${known ? ` (KNOWN: ${known})` : ''}`, async ({ page }) => {
      if (known) test.fail();
      const { box, send } = await openHero(page, width);
      const at = await geometry(box);
      expect(at.width, 'text box width').toBeGreaterThan(0);
      expect(at.hitsItself).toBe(true);
      await expect(box).toBeVisible();
      await box.click();
      await page.keyboard.type('Plan dinners');
      await expect(box).toHaveValue('Plan dinners');
      expect((await geometry(send)).hitsItself).toBe(true);
      expect(await centreColumn(page)).toBe(centre);
    });

    if (known) {
      test(`${width}px: what the reader gets instead, as it is today (KNOWN: ${known})`, async ({ page }) => {
        // The other half of the record, so the fix changes both: the centre
        // column's width, a text box with no width that a pointer cannot
        // reach, yet one that still takes focus and text from the keyboard,
        // typed blind; and the send button, which overflows the column and
        // still takes its own tap.
        const { box, send } = await openHero(page, width);
        expect(await centreColumn(page)).toBe(centre);
        const at = await geometry(box);
        expect(at.width).toBe(0);
        expect(at.hitsItself).toBe(false);
        await expect(box).toBeHidden();
        await box.focus();
        await expect(box).toBeFocused();
        await page.keyboard.type('Plan dinners');
        await expect(box).toHaveValue('Plan dinners');
        const sendAt = await geometry(send);
        expect(sendAt.width).toBe(44);
        expect(sendAt.hitsItself).toBe(true);
      });
    }
  }

  test('1024px, a conversation open: the docked composer sits in the left column and can be used', async ({ page }) => {
    // The control. With one of the reader's own messages in the open
    // conversation, the hero gives way to the thread and its docked composer
    // in the 320px left column, which is unaffected by the centre column.
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
    // On arrival it is still the hero, saved conversation or not.
    await expect(page.getByRole('region', { name: 'Plan and results' }).getByRole('textbox', { name: 'Ask Bubaly' })).toBeAttached();
    await left.locator('button[aria-controls="assistant-conversation-list"]').click();
    // The list's own entry (its rename and delete buttons carry no text).
    await left.locator('#assistant-conversation-list button', { hasText: 'Probe dinner plan' }).click();
    await expect(left.getByText('What is for dinner this week?')).toBeVisible();

    const box = left.getByRole('textbox', { name: 'Message Bubaly' });
    // Opening a thread scrolls to its foot smoothly; read the box once it is
    // in view and has stopped moving.
    await box.scrollIntoViewIfNeeded();
    await box.evaluate((el) => new Promise<void>((resolve) => {
      let last = Number.NaN; let still = 0;
      const tick = () => {
        const top = el.getBoundingClientRect().top;
        still = top === last ? still + 1 : 0;
        last = top;
        if (still >= 5) resolve(); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    const at = await geometry(box);
    expect(at.width).toBeGreaterThan(0);
    expect(at.hitsItself).toBe(true);
    await box.click();
    await page.keyboard.type('And on Friday?');
    await expect(box).toHaveValue('And on Friday?');
    const send = left.getByRole('button', { name: 'Send' });
    expect((await geometry(send)).hitsItself).toBe(true);
    // The centre column is still 0px; only the hero lived there.
    expect(await centreColumn(page)).toBe(0);
  });
});
