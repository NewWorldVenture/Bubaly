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

      // ── The toast stack (components/ui/toast.tsx), A11Y-001 #2 ──
      // Bottom-centre at every width, a 384px toast covered a centred dialog's
      // own footer (Cancel and its submit) at 1024-1280px, the moment a refusal
      // was shown. From lg the stack sits bottom-right, lifted 10rem above the
      // corner buttons, and each toast is at most 14rem (224px) wide; below lg
      // it keeps its mobile place.

      /** Every control a visible toast's box intersects, within `scope`. */
      const controlsUnderToasts = (page: Page, scope: string) => page.evaluate((within) => {
        const toasts = Array.from(document.querySelectorAll('.pointer-events-none.fixed > [role="alert"], .pointer-events-none.fixed > [role="status"]'))
          .map((t) => t.getBoundingClientRect());
        const covered: string[] = [];
        for (const el of Array.from(document.querySelectorAll(`${within} button, ${within} input, ${within} a[href], ${within} textarea, ${within} select`))) {
          const b = el.getBoundingClientRect();
          if (!b.width || !b.height) continue;
          if (toasts.some((t) => t.left < b.right && t.right > b.left && t.top < b.bottom && t.bottom > b.top)) {
            covered.push((el.getAttribute('aria-label') || el.textContent || (el as HTMLInputElement).name || el.tagName).trim());
          }
        }
        return covered;
      }, scope);
      const toastBoxes = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll('.pointer-events-none.fixed > [role="alert"], .pointer-events-none.fixed > [role="status"]'))
        .map((t) => {
          const b = t.getBoundingClientRect();
          const text = t.querySelector('span');
          return { left: b.left, right: b.right, bottom: b.bottom, width: b.width, overflows: !!text && text.scrollWidth > text.clientWidth + 1 };
        }));
      /** What a pointer at the centre of `target` would land on: the nearest button's name. */
      const hitAt = async (page: Page, target: Locator) => {
        const box = (await target.boundingBox())!;
        return page.evaluate(({ x, y }) => {
          const button = document.elementFromPoint(x, y)?.closest('button');
          return button?.getAttribute('aria-label') || button?.textContent?.trim() || null;
        }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      };
      const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

      if (width === 1280) {
        for (const [w, h] of [[1024, 768], [1280, 800], [1440, 900]] as const) {
          test(`contacts at ${w}x${h}: two refusal notices cover none of the dialog's own controls`, async ({ page }) => {
            await page.setViewportSize({ width: w, height: h });
            const { dialog } = await openNewContact(page);
            const submit = dialog.getByRole('button', { name: 'Add Contact' });
            // The usual order: a first try without a name, then a refused save.
            await submit.click();
            await expect(alertsReading(page, COPY.nameRequired)).toHaveCount(1);
            await dialog.getByRole('textbox', { name: 'Full name' }).fill('Robin Probe');
            await refuseContactWrites(page);
            await submit.click();
            await expect(alertsReading(page, COPY.duplicate)).toHaveCount(1);
            expect(await hitAt(page, submit)).toBe('Add Contact');
            expect(await controlsUnderToasts(page, '[role="dialog"]')).toEqual([]);
            const boxes = await toastBoxes(page);
            expect(boxes).toHaveLength(2);
            for (const box of boxes) {
              expect(box.width).toBeLessThanOrEqual(224.5);
              expect(Math.abs(box.right - (w - 16))).toBeLessThanOrEqual(1);
              expect(box.overflows).toBe(false);
            }
          });
        }

        test('contacts: a long German notice wraps inside the 14rem toast and still clears the dialog', async ({ page }) => {
          await page.setViewportSize({ width: 1024, height: 768 });
          await signIn(page, '/dashboard/contacts');
          // As a reader would: the language picker, then Deutsch.
          await page.getByRole('button', { name: 'Change language' }).click();
          await page.getByRole('option', { name: /Deutsch/ }).first().click();
          await page.getByRole('button', { name: 'Kontakt hinzufügen', exact: true }).first().click();
          const dialog = page.getByRole('dialog', { name: 'Neuer Kontakt' });
          await expect(dialog).toBeVisible();
          const submit = dialog.getByRole('button', { name: 'Kontakt hinzufügen' });
          await submit.click();
          await expect(page.getByRole('alert').filter({ hasText: 'Ein Name ist erforderlich' })).toHaveCount(1);
          await dialog.getByRole('textbox', { name: 'Vollständiger Name' }).fill('Robin Probe');
          await refuseContactWrites(page);
          await submit.click();
          await expect(page.locator('.pointer-events-none.fixed > [role="alert"]')).toHaveCount(2);
          const boxes = await toastBoxes(page);
          for (const box of boxes) {
            expect(box.width).toBeLessThanOrEqual(224.5);
            expect(box.left).toBeGreaterThanOrEqual(0);
            expect(box.bottom).toBeLessThanOrEqual(768);
            expect(box.overflows).toBe(false);
          }
          expect(await hitAt(page, submit)).toBe('Kontakt hinzufügen');
          expect(await controlsUnderToasts(page, '[role="dialog"]')).toEqual([]);
        });

        test('quick capture: the Undo toast sits bottom-right, Undo and Dismiss are its own, and it holds while hovered or focused', async ({ page }) => {
          // LIFETIME.action is 7s; the waits below outlast it on purpose.
          test.setTimeout(90_000);
          await signIn(page, '/dashboard/contacts');
          const capture = async (text: string) => {
            await page.getByRole('button', { name: 'Quick capture' }).click();
            const dialog = page.getByRole('dialog', { name: 'Quick capture' });
            await dialog.getByRole('textbox', { name: 'Task' }).fill(text);
            await dialog.getByRole('button', { name: 'Save', exact: true }).click();
            const toast = page.getByRole('status').filter({ has: page.getByRole('button', { name: 'Undo' }) });
            await expect(toast).toHaveCount(1);
            return toast;
          };
          const first = await capture('Probe toast hover');
          const [box] = await toastBoxes(page);
          expect(box.width).toBeLessThanOrEqual(224.5);
          expect(Math.abs(box.right - (1280 - 16))).toBeLessThanOrEqual(1);
          // Lifted 10rem, clear of Quick capture and the AI orb below it.
          const stackBottom = await first.evaluate((t) => t.parentElement!.getBoundingClientRect().bottom);
          expect(Math.abs(stackBottom - (800 - 160))).toBeLessThanOrEqual(1);
          expect(await hitAt(page, first.getByRole('button', { name: 'Undo' }))).toBe('Undo');
          expect(await hitAt(page, first.getByRole('button', { name: 'Dismiss' }))).toBe('Dismiss');
          // Hovered past its lifetime, it stays; let go, and it leaves on its own.
          await first.hover();
          await pause(7_800);
          await expect(first).toHaveCount(1);
          await page.mouse.move(10, 10);
          await expect(first).toHaveCount(0, { timeout: 10_000 });

          // Focused past its lifetime, it stays; Undo by keyboard still undoes.
          const second = await capture('Probe toast focus');
          await second.getByRole('button', { name: 'Undo' }).focus();
          await pause(7_800);
          await expect(second).toHaveCount(1);
          await page.keyboard.press('Enter');
          await expect(second).toHaveCount(0);
          await expect(page.getByRole('status').filter({ hasText: /undone|removed/i })).toHaveCount(1);
        });
      }

      if (width === 390) {
        test('contacts at 390 px: the notice sits above the tab bar, left of the corner buttons', async ({ page }) => {
          const { dialog } = await openNewContact(page);
          await dialog.getByRole('button', { name: 'Add Contact' }).click();
          await expect(alertsReading(page, COPY.nameRequired)).toHaveCount(1);
          const [box] = await toastBoxes(page);
          // pl-4, and pr-[calc(5rem+var(--safe-right))]: the corner column
          // (Quick capture and the orb, 3.5rem wide at right 1rem) plus a
          // 0.5rem gap. 390 - 16 - 64 = 310.
          expect(Math.abs(box.left - 16)).toBeLessThanOrEqual(1);
          expect(Math.abs(box.right - (390 - 80))).toBeLessThanOrEqual(1);
          // bottom-[calc(5rem+var(--safe-bottom))]: the stack (not a toast,
          // which fades in from below) ends clear of the 4rem tab bar.
          const stackBottom = await page.evaluate(() => document.querySelector('.pointer-events-none.fixed:has(> [role="alert"])')!.getBoundingClientRect().bottom);
          expect(Math.abs(stackBottom - (844 - 80))).toBeLessThanOrEqual(1);
        });
      }

      // ── The toast stack and the corner buttons: the trade-off, measured ──
      // Quick capture (components/app/quick-capture.tsx) and the AI orb
      // (components/app/ai-orb.tsx) are fixed at the right edge: from lg at
      // bottom 1.5rem and 6rem, right 1.5rem; below lg at bottom 5rem and 9rem
      // (plus the safe area), right 1rem. From lg the toast stack sits at the
      // same edge (right 1rem), lifted to bottom 10rem, clear of the orb's top
      // at 9.5rem; below lg it sits above the tab bar, level with Quick
      // capture, and stops 5rem from the right edge, left of the column both
      // buttons sit in (3.5rem wide at right 1rem, plus a 0.5rem gap). These
      // cases put up one short notice, one long one (German, the longest the
      // contact form can be made to say) and three at once on
      // /dashboard/contacts with no dialog open, and record: every control a
      // toast's box intersects, what a pointer at each corner button's centre
      // lands on, and that each button is still reached and opened from the
      // keyboard.
      //
      // CORNER is the pointer half as it is today, written down rather than
      // hidden: it is what a real pointer hits. At every size the stack now
      // covers neither button and each one is under its own centre. BEFORE is
      // the same half for the placements this replaced (lg:bottom-6 from lg;
      // full width, px-4, below lg), and the negative controls put those back
      // in the page to show they still read as blocked. A placement change
      // that moves either half changes these tables with it. The keyboard
      // half holds whatever the placement.
      type CornerState = 'short' | 'long' | 'stacked';
      const CORNER_NAMES = {
        en: { capture: 'Quick capture', ai: 'Ask the AI assistant', aiSheet: 'AI assistant', ask: 'Ask Bubaly' },
        de: { capture: 'Schnellerfassung', ai: 'Den KI-Assistenten fragen', aiSheet: 'KI-Assistent', ask: 'Bubaly fragen' },
      } as const;
      const TOASTS = '.pointer-events-none.fixed > [role="alert"], .pointer-events-none.fixed > [role="status"]';
      /** Every visible control outside the stack a toast's box intersects, and what a pointer at each named button's centre lands on ("toast" when it is a toast, with the toast's own button if it is one). */
      const cornerReport = (page: Page, names: { capture: string; ai: string }) => page.evaluate(async ({ selector, capture, ai }) => {
        // Where a long notice wraps, and so where its Dismiss falls, waits on
        // the web font.
        await document.fonts.ready;
        const toasts = Array.from(document.querySelectorAll(selector));
        // And on the notices coming to rest: each fades in from 8px below
        // (animate-fade-in, 0.4s), and read mid-slide a box sits lower than
        // it will. Locally that moved the point under the orb at 390x844 from
        // the long notice's Ausblenden to its body in 2 of 12 samples.
        await Promise.all(toasts.flatMap((t) => t.getAnimations({ subtree: true }))
          .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
          .map((a) => a.finished.catch(() => undefined)));
        const stack = toasts[0]?.parentElement ?? null;
        const boxes = toasts.map((t) => t.getBoundingClientRect());
        const nameOf = (el: Element) => (el.getAttribute('aria-label') || el.textContent || (el as HTMLInputElement).name || el.tagName).replace(/\s+/g, ' ').trim();
        const covered = new Set<string>();
        for (const el of Array.from(document.querySelectorAll('button, input, a[href], textarea, select'))) {
          if (stack?.contains(el)) continue;
          const b = el.getBoundingClientRect();
          if (!b.width || !b.height || getComputedStyle(el).visibility === 'hidden') continue;
          if (boxes.some((t) => t.left < b.right && t.right > b.left && t.top < b.bottom && t.bottom > b.top)) covered.add(nameOf(el));
        }
        const pointerAt = (name: string) => {
          const target = Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === name)!;
          const b = target.getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          const button = hit?.closest('button');
          const label = button ? (button.getAttribute('aria-label') || button.textContent?.trim() || '') : null;
          return hit && stack?.contains(hit) ? (label ? `toast: ${label}` : 'toast') : label;
        };
        return { covered: [...covered].sort(), capture: pointerAt(capture), ai: pointerAt(ai) };
      }, { selector: TOASTS, ...names });

      /** Raises `state` from the contact dialog on /dashboard/contacts, holds the notices by hovering them, and closes the dialog. */
      async function raiseNotices(page: Page, state: CornerState) {
        let dialog: Locator;
        let name: Locator;
        if (state === 'long') {
          await signIn(page, '/dashboard/contacts');
          // As a reader would: the language picker, then Deutsch.
          await page.getByRole('button', { name: 'Change language' }).click();
          await page.getByRole('option', { name: /Deutsch/ }).first().click();
          await page.getByRole('button', { name: 'Kontakt hinzufügen', exact: true }).first().click();
          dialog = page.getByRole('dialog', { name: 'Neuer Kontakt' });
          await expect(dialog).toBeVisible();
          name = dialog.getByRole('textbox', { name: 'Vollständiger Name' });
          // A write that comes back with no row: errors.thatChangeWasNotSaved,
          // the longest notice this form gives, and localized.
          await page.route('**/rest/v1/family_contacts*', (route) => (route.request().method() === 'POST'
            ? route.fulfill({ status: 201, contentType: 'application/json', body: '[]' })
            : route.continue()));
          await name.fill('Robin Probe');
          await name.press('Enter');
          await expect(page.getByRole('alert').filter({ hasText: /^Diese Änderung wurde nicht gespeichert/ })).toHaveCount(1);
        } else {
          ({ dialog } = await openNewContact(page));
          name = dialog.getByRole('textbox', { name: 'Full name' });
          await name.press('Enter');
          await expect(alertsReading(page, COPY.nameRequired)).toHaveCount(1);
          if (state === 'stacked') {
            await name.fill('Robin Probe');
            await refuseContactWrites(page);
            await name.press('Enter');
            await expect(alertsReading(page, COPY.duplicate)).toHaveCount(1);
            await name.press('Enter');
            await expect(alertsReading(page, COPY.duplicate)).toHaveCount(2);
          }
        }
        // Hovering the stack holds every notice past its lifetime; the
        // pointer stays there, and the report below reads what is under each
        // corner button's centre by elementFromPoint, not by moving it.
        const notices = page.locator(TOASTS);
        await notices.last().hover();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(notices).toHaveCount(state === 'stacked' ? 3 : 1);
        return notices;
      }

      /**
       * Who takes a tap at a corner button's centre: "toast" for any point
       * inside the stack, else the name of the button there. Which part of a
       * notice is under the point, its body or one of its own buttons, moves
       * with where the text wraps: at 390x844 the long German notice put
       * Ausblenden under the orb's centre locally and the notice's body there
       * in CI (run 37126950007). That is not the claim; the notice taking the
       * tap is.
       */
      const tapped = (hit: string | null) => (hit !== null && /^toast(: |$)/.test(hit) ? 'toast' : hit);
      type CornerRow = { covered: string[]; capture: string | null; ai: string | null };
      /** Whether `report` is the characterization `row`: the same controls covered, and the same taker of each tap. */
      const matchesCorner = (report: CornerRow, row: CornerRow) => JSON.stringify(report.covered) === JSON.stringify(row.covered)
        && tapped(report.capture) === tapped(row.capture) && tapped(report.ai) === tapped(row.ai);

      const CORNER_VIEWPORTS: ReadonlyArray<readonly [number, number]> = width === 1280 ? [[1024, 768], [1280, 800], [1440, 900]] : [[390, 844]];
      const QC = CORNER_NAMES.en.capture, AI = CORNER_NAMES.en.ai, DE = CORNER_NAMES.de;
      const CORNER: Record<string, CornerRow> = {
        // From lg: the stack sits above both buttons, so whatever the notices
        // say and however many there are, neither is covered and a pointer at
        // each one's centre lands on that button.
        '1024x768 short': { covered: [], capture: QC, ai: AI },
        '1024x768 long': { covered: [], capture: DE.capture, ai: DE.ai },
        '1024x768 stacked': { covered: [], capture: QC, ai: AI },
        '1280x800 short': { covered: [], capture: QC, ai: AI },
        '1280x800 long': { covered: [], capture: DE.capture, ai: DE.ai },
        '1280x800 stacked': { covered: [], capture: QC, ai: AI },
        '1440x900 short': { covered: [], capture: QC, ai: AI },
        '1440x900 long': { covered: [], capture: DE.capture, ai: DE.ai },
        '1440x900 stacked': { covered: [], capture: QC, ai: AI },
        // Below lg the stack stops left of the corner column, so neither
        // button is covered and each takes its own tap. KNOWN, and kept: a
        // long notice or three still reach the language bar at the foot of
        // this short page (page content, not a corner control).
        '390x844 short': { covered: [], capture: QC, ai: AI },
        '390x844 long': { covered: ['Sprache ändern'], capture: DE.capture, ai: DE.ai },
        '390x844 stacked': { covered: ['Change language'], capture: QC, ai: AI },
      };
      /** The placements this replaced, as measured on #778 (736e1ffd): from lg at bottom 1.5rem, below lg full width. */
      const BEFORE: Record<string, CornerRow> = {
        '1024x768 short': { covered: [QC], capture: 'toast', ai: AI },
        '1024x768 long': { covered: [DE.ai, DE.capture], capture: 'toast', ai: 'toast' },
        '1024x768 stacked': { covered: [AI, QC], capture: 'toast', ai: 'toast' },
        '1280x800 short': { covered: [QC], capture: 'toast', ai: AI },
        '1280x800 long': { covered: [DE.ai, DE.capture], capture: 'toast', ai: 'toast' },
        '1280x800 stacked': { covered: [AI, QC], capture: 'toast', ai: 'toast' },
        '1440x900 short': { covered: [QC], capture: 'toast', ai: AI },
        '1440x900 long': { covered: [DE.ai, DE.capture], capture: 'toast', ai: 'toast' },
        '1440x900 stacked': { covered: [AI, QC], capture: 'toast', ai: 'toast' },
        '390x844 short': { covered: [QC], capture: 'toast', ai: AI },
        '390x844 long': { covered: [DE.ai, DE.capture, 'Sprache ändern'], capture: 'toast', ai: 'toast' },
        '390x844 stacked': { covered: [AI, 'Change language', QC], capture: 'toast', ai: 'toast' },
      };
      /** The inline style that puts the replaced placement back on the stack, in one page only. */
      const REPLACED_PLACEMENT = (w: number): Record<string, string> => (w >= 1024 ? { bottom: '1.5rem' } : { paddingRight: '1rem' });

      test.describe('the toast stack and the corner buttons', () => {
        // These cases refuse the contact write with page.route. Locally, 3 of
        // the first ~60 runs saved it anyway: the route never saw the POST.
        // The cause was not pinned down; Playwright documents that page.route
        // may miss requests from a page a service worker controls, and
        // public/sw.js takes control during these tests. The worker has no
        // part in where a notice sits, so it is kept out (none missed in 32
        // runs since).
        test.use({ serviceWorkers: 'block' });
        for (const [w, h] of CORNER_VIEWPORTS) {
          for (const state of ['short', 'long', 'stacked'] as const) {
            test(`${w}x${h}, ${state}: what the notices cover, what a pointer hits, and the keyboard path to both corner buttons`, async ({ page }) => {
              await page.setViewportSize({ width: w, height: h });
              const names = CORNER_NAMES[state === 'long' ? 'de' : 'en'];
              const notices = await raiseNotices(page, state);
              const count = await notices.count();

              const report = await cornerReport(page, names);
              const expected = CORNER[`${w}x${h} ${state}`];
              expect(report.covered).toEqual(expected.covered);
              for (const which of ['capture', 'ai'] as const) {
                if (tapped(expected[which]) === 'toast') {
                  // Blocked: the point is inside the toast stack, so the
                  // notice takes the tap.
                  expect(tapped(report[which]), `${which}: a notice takes the tap`).toBe('toast');
                } else {
                  // Clear: the corner button is under its own centre.
                  expect(report[which], `${which}: the button takes its own tap`).toBe(expected[which]);
                }
              }
              expect(matchesCorner(report, expected)).toBe(true);
              if (w >= 1024) {
                // lg:bottom-40: the stack (not a toast, which fades in from
                // below) ends 10rem above the viewport's foot.
                const stackBottom = await notices.first().evaluate((t) => t.parentElement!.getBoundingClientRect().bottom);
                expect(Math.abs(stackBottom - (h - 160))).toBeLessThanOrEqual(1);
              }

              // The keyboard path, taken while the notices still show: each
              // corner button takes focus, Tab and Shift+Tab move between
              // them, and Enter opens what it names.
              const capture = page.getByRole('button', { name: names.capture, exact: true });
              const ai = page.getByRole('button', { name: names.ai, exact: true });
              await capture.focus();
              await expect(capture).toBeFocused();
              await page.keyboard.press('Tab');
              await expect(ai).toBeFocused();
              await page.keyboard.press('Shift+Tab');
              await expect(capture).toBeFocused();
              await page.keyboard.press('Enter');
              const captureDialog = page.getByRole('dialog', { name: names.capture });
              await expect(captureDialog).toBeVisible();
              await page.keyboard.press('Escape');
              await expect(captureDialog).toBeHidden();
              await expect(capture).toBeFocused();
              await expect(notices).toHaveCount(count);
              await page.keyboard.press('Tab');
              await expect(ai).toBeFocused();
              await page.keyboard.press('Enter');
              if (w >= 1024) {
                // From lg the orb goes to the assistant page.
                // A server-rendered navigation, given signIn's allowance.
                await expect(page).toHaveURL(/\/dashboard\/assistant$/, { timeout: 60_000 });
                const composer = page.getByRole('textbox', { name: names.ask });
                if (w > 1024) await expect(composer).toBeVisible();
                // KNOWN, and not the toast's: at 1024 the assistant page's
                // three columns (components/assistant/workspace.tsx,
                // lg:grid-cols-[320px_1fr_330px] in a 688px main) leave the
                // middle one, and the composer in it, 0px wide. Reported on
                // #778; this flips when that layout is fixed.
                else await expect(composer).toBeHidden();
              } else {
                // Below lg it opens the assistant over the page.
                const sheet = page.getByRole('dialog', { name: names.aiSheet });
                await expect(sheet).toBeVisible();
                await expect(sheet.getByRole('textbox', { name: names.ask })).toBeVisible();
              }
            });

            // The negative control: the same notices, put back where the
            // placement this replaced had them (the stack's own inline style,
            // in this page only; the app's CSS is untouched), must NOT pass as
            // clear. The obstructed corner reads as it did before the fix, and
            // the clear row no longer matches.
            test(`${w}x${h}, ${state}, replaced placement (negative control): an obstructed corner does not pass as clear`, async ({ page }) => {
              await page.setViewportSize({ width: w, height: h });
              const names = CORNER_NAMES[state === 'long' ? 'de' : 'en'];
              const notices = await raiseNotices(page, state);
              const count = await notices.count();
              const clearRow = CORNER[`${w}x${h} ${state}`];
              expect(matchesCorner(await cornerReport(page, names), clearRow)).toBe(true);
              await notices.first().evaluate((t, style) => { Object.assign((t.parentElement as HTMLElement).style, style); }, REPLACED_PLACEMENT(w));
              // Hold the notices again with the pointer where they now are.
              await notices.last().hover();
              await expect(notices).toHaveCount(count);
              const blocked = await cornerReport(page, names);
              expect(blocked.covered).toContain(names.capture);
              expect(tapped(blocked.capture), 'capture: a notice takes the tap').toBe('toast');
              expect(matchesCorner(blocked, BEFORE[`${w}x${h} ${state}`])).toBe(true);
              expect(matchesCorner(blocked, clearRow)).toBe(false);
              await expect(notices).toHaveCount(count);
            });
          }
        }
      });

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
