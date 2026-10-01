import { createClient } from '@supabase/supabase-js';
import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
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
    const { error } = await admin.from('subscriptions')
      .upsert({ family_id: account.familyId, plan: 'plus', status: 'active' }, { onConflict: 'family_id' });
    if (error) throw new Error('Form error E2E could not give its household a Plus plan.');
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
        // Reproduced: the shared Button is natively disabled while `loading`,
        // so the focused submit drops focus to <body>, outside the aria-modal
        // dialog (components/ui/button.tsx; COMPONENT-2795B661F080).
        test.fail();
        const { dialog } = await openNewContact(page);
        await dialog.getByRole('textbox', { name: 'Full name' }).fill('Robin Probe');
        await refuseContactWrites(page);
        await dialog.getByRole('button', { name: 'Add Contact' }).focus();
        await page.keyboard.press('Enter');
        await expect(alertsReading(page, COPY.duplicate)).toHaveCount(1);
        expect(await focusInside(dialog)).toBe(true);
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
        await signIn(page, '/dashboard/paperwork');
        await page.getByRole('button', { name: 'Add paperwork' }).click();
        const text = page.getByRole('textbox', { name: /paste the paperwork text/i });
        await expect(text).toBeVisible();
        return { text, sender: page.getByRole('textbox', { name: /optional/ }), submit: page.getByRole('button', { name: 'Triage it' }) };
      }
      const refuseNextAction = (page: Page) => page.route('**/dashboard/paperwork', (route) => (
        route.request().method() === 'POST' && route.request().headers()['next-action']
          ? route.fulfill({ status: 500, contentType: 'text/plain', body: PRODUCTION_REDACTED })
          : route.continue()));
      const countActions = (page: Page) => {
        const seen = { posts: 0 };
        page.on('request', (r) => { if (r.method() === 'POST' && r.headers()['next-action'] && r.url().includes('/dashboard/paperwork')) seen.posts += 1; });
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
        // Reproduced: the composer shows a thrown action's message as-is; in
        // production that is React's redacted #441 text. useActionError
        // (components/ui/action-error.tsx) already maps it with
        // refusalForThrown; the composer does not (paperwork-module.tsx).
        test.fail();
        const { text, submit } = await openComposer(page);
        await refuseNextAction(page);
        await text.fill(PAPER);
        await submit.click();
        await expect(alertsReading(page, COPY.notSaved)).toHaveCount(1);
        await expect(page.getByRole('alert').filter({ hasText: 'Minified React error' })).toHaveCount(0);
      });

      test('paperwork: keyboard focus is not dropped to the page after a refused or a saved paste', async ({ page }) => {
        // Reproduced: the natively disabled pending submit drops focus to
        // <body> on a refusal, and a save unmounts the composer around it.
        test.fail();
        const { text, submit } = await openComposer(page);
        await refuseNextAction(page);
        await text.fill(PAPER);
        await submit.focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('alert').first()).toBeVisible();
        expect(await focusIsBody(page)).toBe(false);
        await page.unroute('**/dashboard/paperwork');
        await text.fill(PAPER);
        await submit.focus();
        await page.keyboard.press('Enter');
        await expect(text).toBeHidden();
        expect(await focusIsBody(page)).toBe(false);
      });

      test('paperwork: a whitespace-only paste is not closed as if it were done', async ({ page }) => {
        // Reproduced: native `required` accepts spaces, the action trims them
        // to nothing and answers ok without saving, and the composer closes
        // with nothing said (addPaperworkAction; ACTION-CD1E12585CD4).
        test.fail();
        const { text, submit } = await openComposer(page);
        await text.fill('     ');
        await submit.click();
        await page.waitForLoadState('networkidle');
        await expect(text).toBeVisible();
      });
    });
  }
});
