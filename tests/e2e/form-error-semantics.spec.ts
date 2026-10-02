import { createClient } from '@supabase/supabase-js';
import { expect, test, type CDPSession, type Locator, type Page, type Request } from '@playwright/test';
import { createOwnedAccount, requireLocalOrigin, type OwnedAccount } from './helpers/durable-session';

// A11Y-001, the two-form slice (JIMMY-BLK-FORM-A11Y-20261001): what the contact
// form (components/modules/contacts-module.tsx, /dashboard/contacts) and the
// paperwork composer (components/modules/paperwork-module.tsx,
// /dashboard/paperwork) expose when a submit is invalid, refused, and then
// recovers. Real pages, a signed-in Plus parent of a disposable local
// household, synthetic records only; nothing reaches a provider.
//
// The accessible-tree checks read Chromium's own tree over CDP. They are what
// assistive technology is given, not evidence from a person using a screen
// reader. Native constraint validation is the browser's own semantics and is
// treated as such: a form without Field or aria-invalid is not a defect by that
// alone.
//
// Tests marked test.fail() are reproduced defects. They run on every pass and
// are expected to fail on the current source; the fix removes the marker.
const enabled = process.env.E2E_AUTHENTICATED === '1';
const provider = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const COPY = {
  nameRequired: 'Name is required',
  duplicate: 'That already exists. Try a different value.',
  contactAdded: 'Contact added',
  notSaved: 'Nothing was changed. Check the details and try again.',
};
// What a production build hands the client in place of a thrown server
// action's message (captured from a real refusal of addPaperworkAction on a
// local production build; see useActionError in components/ui/action-error.tsx).
const PRODUCTION_REDACTED = 'Minified React error #441; visit https://react.dev/errors/441 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.';
const PAPER = 'Field trip permission slip: please sign and return by Friday.';

test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off' });

let account: OwnedAccount | null = null;

async function signIn(page: Page, to: string) {
  await page.goto(`/login?redirect=${to}`, { waitUntil: 'domcontentloaded' });
  try {
    await page.locator('input[name="email"]').fill(account!.email);
    await page.locator('input[name="password"]').fill(account!.password);
  } catch { throw new Error('Form error E2E could not fill its sign-in form.'); }
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${to.replace(/\//g, '\\/')}$`), { timeout: 60_000 });
}

/** Chromium's own accessibility tree: the nodes whose name holds `text`, and whether each is ignored. */
async function axNodes(cdp: CDPSession, text: string) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree') as {
    nodes: Array<{ name?: { value?: string }; role?: { value?: string }; ignored: boolean }>;
  };
  return nodes.filter((n) => n.role?.value === 'StaticText' && (n.name?.value ?? '') === text).map((n) => ({ ignored: n.ignored }));
}

const focusInside = (locator: Locator) => locator.evaluate((el) => el.contains(document.activeElement));
const focusIsBody = (page: Page) => page.evaluate(() => document.activeElement === document.body || document.activeElement === null);
const alertsReading = (page: Page, text: string) => page.getByRole('alert').filter({ hasText: text });

test.describe('form errors: what an invalid, refused and recovered submit exposes', () => {
  test.skip(!enabled, 'Set E2E_AUTHENTICATED=1 to run against the disposable local Supabase.');

  test.beforeEach(async () => {
    const origin = requireLocalOrigin(provider);
    account = await createOwnedAccount(origin, serviceKey);
    const admin = createClient(origin, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    // One retry, and only when nothing answered (status 0) or the gateway did
    // (5xx): the upsert is idempotent, and postgrest-js retries a GET on those
    // but never a POST. A refusal from the database (4xx) is thrown at once.
    // The status and code are reported; the message and details stay out of CI.
    const seen: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { data, error, status } = await admin.from('subscriptions')
        .upsert({ family_id: account.familyId, plan: 'plus', status: 'active' }, { onConflict: 'family_id' })
        .select('plan');
      if (!error && data?.length === 1 && data[0].plan === 'plus') return;
      seen.push(`${status}${error?.code ? ` ${error.code}` : ''}`);
      if (!error || (status !== 0 && status < 500)) break;
    }
    throw new Error(`Form error E2E could not give its household a Plus plan (${seen.join(', then ')}).`);
  });
  test.afterEach(async () => {
    try { await account?.dispose(); } finally { account = null; }
  });

  for (const width of [390, 1280]) {
    test.describe(`at ${width} px`, () => {
      test.use({ viewport: { width, height: width === 390 ? 844 : 800 } });

      // ── Contacts: Field-based, client validation and a direct database write ──

      async function openNewContact(page: Page) {
        await signIn(page, '/dashboard/contacts');
        const opener = page.getByRole('button', { name: 'Add Contact', exact: true }).first();
        await opener.click();
        const dialog = page.getByRole('dialog', { name: 'New Contact' });
        await expect(dialog).toBeVisible();
        return { opener, dialog };
      }
      // The held write has to be sent before anything else is asserted, and
      // waiting for it must end. Seen in CI: under load the shared session
      // boundary briefly reported the session unavailable, replaced the page
      // with its "temporarily unavailable" notice and reset everything under
      // it, so the dialog (and the typed name) was gone before Enter and no
      // write was ever sent. That is the session cache's behaviour, not this
      // form's; say so instead of timing the whole test out.
      async function writeSent(page: Page, sent: Promise<void>) {
        const timedOut = new Promise<false>((resolve) => { setTimeout(() => resolve(false), 10_000); });
        if (await Promise.race([sent.then(() => true as const), timedOut])) return;
        const main = await page.evaluate(() => document.querySelector('main')?.textContent?.replace(/\s+/g, ' ').trim() ?? '');
        throw new Error(/temporarily unavailable/i.test(main)
          ? 'The contact write was never sent: the session boundary reported the session unavailable and replaced the page, closing the dialog.'
          : `The contact write was not sent within 10 s. The page reads: "${main.slice(0, 200)}"`);
      }
      const refuseContactWrites = (page: Page) => page.route('**/rest/v1/family_contacts*', (route) => (
        route.request().method() === 'POST'
          ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint', details: null, hint: null }) })
          : route.continue()));

      test('contacts: invalid, refused, then saved — names, alerts, focus and readback', async ({ page, context }) => {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Accessibility.enable');
        const { opener, dialog } = await openNewContact(page);
        const name = dialog.getByRole('textbox', { name: 'Full name' });
        const email = dialog.getByRole('textbox', { name: 'Email' });
        await expect(name).toHaveAttribute('aria-required', 'true');
        let writes = 0;
        page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/rest/v1/family_contacts')) writes += 1; });

        // Invalid: no name. Refused before any write, said once in an alert,
        // exposed in Chromium's tree despite the aria-modal dialog, focus kept.
        await name.press('Enter');
        await expect(alertsReading(page, COPY.nameRequired)).toHaveCount(1);
        expect(await axNodes(cdp, COPY.nameRequired)).toEqual([{ ignored: false }]);
        await expect(name).toBeFocused();
        expect(writes).toBe(0);

        // Invalid: a malformed email is the browser's own constraint validation.
        await name.fill('Robin Probe');
        await email.fill('not-an-email');
        await name.press('Enter');
        await expect(email).toBeFocused();
        expect(await email.evaluate((el: HTMLInputElement) => el.validity.typeMismatch && el.validationMessage.length > 0)).toBe(true);
        expect(writes).toBe(0);
        await email.fill('');

        // Refused by the database: one alert in the reader's words, the dialog
        // and what was typed both kept.
        await refuseContactWrites(page);
        await name.press('Enter');
        await expect(alertsReading(page, COPY.duplicate)).toHaveCount(1);
        expect(await axNodes(cdp, COPY.duplicate)).toEqual([{ ignored: false }]);
        await expect(dialog).toBeVisible();
        await expect(name).toHaveValue('Robin Probe');
        expect(writes).toBe(1);

        // Recovered: saved, announced politely, the dialog closes and focus
        // returns to the control that opened it; the contact reads back.
        await page.unroute('**/rest/v1/family_contacts*');
        await name.focus();
        await name.press('Enter');
        await expect(page.getByRole('status').filter({ hasText: COPY.contactAdded })).toHaveCount(1);
        await expect(dialog).toBeHidden();
        await expect(opener).toBeFocused();
        await page.reload();
        await expect(page.getByText('Robin Probe').first()).toBeVisible();
      });

      test('contacts: a refused save keeps keyboard focus inside the dialog', async ({ page }) => {
        // Was: the shared Button is natively disabled while `loading`, so the
        // focused submit dropped focus to <body>, outside the aria-modal dialog
        // (COMPONENT-2795B661F080). The contact form's submit is now
        // aria-disabled while saving; the shared Button is unchanged.
        const { dialog } = await openNewContact(page);
        await dialog.getByRole('textbox', { name: 'Full name' }).fill('Robin Probe');
        let release!: () => void, sent!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const seen = new Promise<void>((resolve) => { sent = resolve; });
        await page.route('**/rest/v1/family_contacts*', async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          sent();
          await held;
          await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint', details: null, hint: null }) });
        });
        const submit = dialog.getByRole('button', { name: 'Add Contact' });
        await submit.focus();
        await page.keyboard.press('Enter');
        await writeSent(page, seen);
        // While the write is held: the pending state has rendered, and the
        // submit that was pressed still has the focus.
        await expect(dialog.locator('button[type="submit"] svg.animate-spin')).toBeVisible();
        await expect(submit).toBeFocused();
        release();
        await expect(alertsReading(page, COPY.duplicate)).toHaveCount(1);
        await expect(submit).toBeFocused();
        expect(await focusInside(dialog)).toBe(true);
      });

      test('contacts: a second Enter while a save is in flight sends one write', async ({ page }) => {
        const { dialog, opener } = await openNewContact(page);
        await dialog.getByRole('textbox', { name: 'Full name' }).fill('Robin Probe');
        // A control: a natively disabled submit also refused this. It guards
        // the contact form's own in-flight refusal now that the submit stays
        // focusable while saving.
        let posts = 0;
        let release!: () => void, sent!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const seen = new Promise<void>((resolve) => { sent = resolve; });
        await page.route('**/rest/v1/family_contacts*', async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          posts += 1;
          sent();
          await held;
          await route.continue();
        });
        const submit = dialog.getByRole('button', { name: 'Add Contact' });
        await submit.focus();
        await page.keyboard.press('Enter');
        await writeSent(page, seen);
        await expect(dialog.locator('button[type="submit"] svg.animate-spin')).toBeVisible();
        await page.keyboard.press('Enter');
        // A DOM click, not a pointer click: it submits the form whatever the
        // dialog's scroll position, so only the in-flight refusal can stop it.
        await submit.evaluate((button: HTMLButtonElement) => button.click());
        release();
        await expect(page.getByRole('status').filter({ hasText: COPY.contactAdded })).toHaveCount(1);
        await expect(dialog).toBeHidden();
        await expect(opener).toBeFocused();
        expect(posts).toBe(1);
      });

      if (width === 1280) {
        test('contacts: the refusal notice does not cover the dialog\'s own submit button', async ({ page }) => {
          // Reproduced: the toast stack sits bottom-centre above the dialog
          // and takes the pointer over "Add Contact" (and pauses its own
          // dismissal while hovered) — the class recorded for the meal toast
          // on 2026-09-27 (components/ui/toast.tsx; COMPONENT-433AE57D4A2F).
          test.fail();
          const { dialog } = await openNewContact(page);
          const name = dialog.getByRole('textbox', { name: 'Full name' });
          const submit = dialog.getByRole('button', { name: 'Add Contact' });
          // The usual order: a first try without a name, then a refused save.
          await submit.click();
          await expect(alertsReading(page, COPY.nameRequired)).toHaveCount(1);
          await name.fill('Robin Probe');
          await refuseContactWrites(page);
          await submit.click();
          await expect(alertsReading(page, COPY.duplicate)).toHaveCount(1);
          const box = (await submit.boundingBox())!;
          const hit = await page.evaluate(({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            return el?.closest('button')?.textContent?.trim() ?? el?.closest('[role]')?.getAttribute('role') ?? el?.tagName;
          }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
          expect(hit).toBe('Add Contact');
        });
      }

      // ── Paperwork: native `required`, a server action ──

      async function openComposer(page: Page) {
        // Next runs one server action at a time, so a save sent while the
        // page's own mount reads (the sidebar's preferences) are in flight
        // waits behind them; on a loaded runner that pushed a save past the
        // assertion's 5 s. Each case starts once those reads have settled.
        const inFlight = new Set<Request>();
        const settle = (r: Request) => { inFlight.delete(r); };
        page.on('request', (r) => { if (r.method() === 'POST' && r.headers()['next-action']) inFlight.add(r); });
        page.on('requestfinished', settle);
        page.on('requestfailed', settle);
        await signIn(page, '/dashboard/paperwork');
        await page.getByRole('button', { name: 'Add paperwork' }).click();
        const text = page.getByRole('textbox', { name: /paste the paperwork text/i });
        await expect(text).toBeVisible();
        // The click opened the composer, so the page has hydrated and run its
        // mount effects: their reads have been sent, and now have to settle.
        await expect.poll(() => inFlight.size, { message: "the page's own server actions settle" }).toBe(0);
        return { text, sender: page.getByRole('textbox', { name: /optional/ }), submit: page.getByRole('button', { name: 'Triage it' }) };
      }
      // The composer's save is the only action posted with its `text` field
      // (React sends the FormData as `_1_text`). Other actions on this page,
      // such as the sidebar's preference read, pass through and are not
      // counted, so a case refuses and counts exactly the save it is about.
      const isComposerSave = (request: Request) => request.method() === 'POST'
        && !!request.headers()['next-action'] && /name="_?\d+_text"/.test(request.postData() ?? '');
      const refuseNextAction = (page: Page) => page.route('**/dashboard/paperwork', (route) => (
        isComposerSave(route.request())
          ? route.fulfill({ status: 500, contentType: 'text/plain', body: PRODUCTION_REDACTED })
          : route.continue()));
      const countActions = (page: Page) => {
        const seen = { posts: 0 };
        page.on('request', (r) => { if (isComposerSave(r) && r.url().includes('/dashboard/paperwork')) seen.posts += 1; });
        return seen;
      };

      test('paperwork: an empty paste is the browser\'s own required-field refusal; a real paste is saved', async ({ page }) => {
        const { text, submit } = await openComposer(page);
        const seen = countActions(page);
        await submit.click();
        await expect(text).toBeFocused();
        expect(await text.evaluate((el: HTMLTextAreaElement) => el.validity.valueMissing && el.validationMessage.length > 0)).toBe(true);
        expect(seen.posts).toBe(0);

        await text.fill(PAPER);
        await submit.click();
        await expect(text).toBeHidden();
        await page.reload();
        await expect(page.getByText(/Field trip permission slip/).first()).toBeVisible();
        expect(seen.posts).toBeGreaterThan(0);
      });

      test('paperwork: a refused paste tells the reader it was not saved, in their words', async ({ page }) => {
        // Was: the composer showed a thrown action's message as-is, which in
        // production is React's redacted #441 text. It now reads the refusal
        // with refusalForThrown, as useActionError does.
        const { text, submit } = await openComposer(page);
        await refuseNextAction(page);
        const seen = countActions(page);
        await text.fill(PAPER);
        await submit.click();
        // First that the refused request was sent (so a failure here says which
        // side failed), then what the reader is told.
        await expect.poll(() => seen.posts).toBe(1);
        await expect(alertsReading(page, COPY.notSaved)).toHaveCount(1);
        await expect(page.getByRole('alert').filter({ hasText: 'Minified React error' })).toHaveCount(0);
      });

      test('paperwork: keyboard focus is not dropped to the page after a refused or a saved paste', async ({ page }) => {
        // Was: the natively disabled pending submit dropped focus to <body> on
        // a refusal, and a save unmounted the composer around it. The submit is
        // now aria-disabled while pending, and a save hands focus to the toggle.
        const { text, submit } = await openComposer(page);
        await refuseNextAction(page);
        await text.fill(PAPER);
        await submit.focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('alert').first()).toBeVisible();
        expect(await focusIsBody(page)).toBe(false);
        await expect(submit).toBeFocused();
        await page.unroute('**/dashboard/paperwork');
        await text.fill(PAPER);
        await submit.focus();
        await page.keyboard.press('Enter');
        await expect(text).toBeHidden();
        expect(await focusIsBody(page)).toBe(false);
        await expect(page.getByRole('button', { name: 'Add paperwork' })).toBeFocused();
      });

      test('paperwork: a save that lands after the reader has moved on leaves their focus alone', async ({ page }) => {
        // Review 5941818072 on #778: the save used to hand focus to the toggle
        // unconditionally, so a late answer pulled the reader back from
        // wherever they had gone. It now does so only while the composer that
        // sent it still holds the focus.
        const { text, submit } = await openComposer(page);
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        await page.route('**/dashboard/paperwork', async (route) => {
          if (route.request().method() === 'POST' && route.request().headers()['next-action']) await held;
          await route.continue();
        });
        await text.fill(PAPER);
        await submit.click();
        await page.getByRole('button', { name: 'Close' }).click();
        await expect(text).toBeHidden();
        const elsewhere = page.getByRole('button', { name: 'Archived', exact: true });
        await elsewhere.focus();
        const answered = page.waitForResponse((r) => r.request().method() === 'POST' && !!r.request().headers()['next-action']);
        release();
        await answered;
        await page.waitForLoadState('networkidle');
        await expect(elsewhere).toBeFocused();
      });

      test('paperwork: a paste the server refuses is kept, with the sender', async ({ page }) => {
        // A real refusal, not a stubbed response: a paste over the server
        // action body limit (1 MB by default) is refused by the framework.
        // <form action> used to reset its fields as the action settled, so
        // the pasted letter and its sender were wiped along with the refusal.
        const { text, sender, submit } = await openComposer(page);
        const letter = 'Permission slip: please sign and return by Friday. '.repeat(24_000);
        await text.fill(letter);
        await sender.fill('Riverside Elementary');
        await submit.click();
        await expect(alertsReading(page, COPY.notSaved)).toHaveCount(1);
        await expect(text).toBeVisible();
        expect((await text.inputValue()).length).toBe(letter.length);
        await expect(sender).toHaveValue('Riverside Elementary');
      });

      test('paperwork: a save from a closed composer does not close the one opened since', async ({ page }) => {
        const { text, submit } = await openComposer(page);
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        await page.route('**/dashboard/paperwork', async (route) => {
          if (route.request().method() === 'POST' && route.request().headers()['next-action']) await held;
          await route.continue();
        });
        await text.fill(PAPER);
        await submit.click();
        await page.getByRole('button', { name: 'Close' }).click();
        await expect(text).toBeHidden();
        await page.getByRole('button', { name: 'Add paperwork' }).click();
        await expect(text).toBeVisible();
        await text.fill('A second letter, still being written.');
        const answered = page.waitForResponse((r) => r.request().method() === 'POST' && !!r.request().headers()['next-action']);
        release();
        await answered;
        await page.waitForLoadState('networkidle');
        await expect(text).toBeVisible();
        await expect(text).toHaveValue('A second letter, still being written.');
      });

      test('paperwork: a whitespace-only paste is not closed as if it were done', async ({ page }) => {
        // Was: native `required` accepted spaces, the action trimmed them to
        // nothing and answered ok without saving, and the composer closed with
        // nothing said. A blank paste is now refused like an empty one.
        const { text, submit } = await openComposer(page);
        const seen = countActions(page);
        await text.fill('     ');
        await submit.click();
        await expect(text).toBeFocused();
        expect(await text.evaluate((el: HTMLTextAreaElement) => el.validity.valueMissing && el.validationMessage.length > 0)).toBe(true);
        await page.waitForLoadState('networkidle');
        await expect(text).toBeVisible();
        expect(seen.posts).toBe(0);
      });
    });
  }
});
