import { expect, test, type Page } from '@playwright/test';

// A11Y-001: a click on a modal dialog's text, then Shift+Tab, must not leave
// the dialog.
//
// `Modal` gives its dialog element tabIndex -1, so a click on anything inside
// that is not a control moves focus to that element. useDialogBehavior's trap
// answered Shift+Tab only from the first control or from outside, so from the
// dialog element the browser's own Shift+Tab went to the control before the
// dialog: the page behind an `aria-modal="true"` dialog. Measured on main
// (36a516d, Chromium): from the cookie preferences dialog below, focus landed
// on the footer's "Privacy choices" button; from the signed-in "Add favorite"
// dialog, on "Ask the AI assistant". Every Modal shares the hook.
//
// The real home page, the real consent dialog (a shared Modal) and the real
// hook; keyboard and pointer only.
test.use({ locale: 'en-US' });

/** Where focus is, relative to the open modal dialog. */
const focusIn = (page: Page) => page.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  const active = document.activeElement as HTMLElement | null;
  return {
    inside: !!dialog && !!active && dialog.contains(active),
    name: active?.getAttribute('aria-label') ?? active?.textContent?.trim().slice(0, 40) ?? '',
  };
});

test.describe('a modal dialog keeps Shift+Tab inside', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Manage preferences' }).click();
    await expect(page.getByRole('dialog', { name: 'Privacy preferences' })).toBeVisible();
    // Every move focus makes from here on, so a single step outside is seen
    // even if a later one comes back.
    await page.evaluate(() => {
      const left: string[] = [];
      (window as unknown as { __left: string[] }).__left = left;
      document.addEventListener('focusin', (event) => {
        const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
        const target = event.target as HTMLElement;
        if (dialog && !dialog.contains(target)) left.push(target.getAttribute('aria-label') ?? target.textContent?.trim().slice(0, 40) ?? target.tagName);
      }, true);
    });
  });

  const left = (page: Page) => page.evaluate(() => (window as unknown as { __left: string[] }).__left);

  test('after a click on the dialog’s title, Shift+Tab goes to its last control', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Privacy preferences' });
    await dialog.getByRole('heading', { name: 'Privacy preferences' }).click();
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => focusIn(page)).toEqual({ inside: true, name: 'Save choices' });
    expect(await left(page), 'focus that left the dialog').toEqual([]);
  });

  test('a full Shift+Tab cycle from there never leaves it', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Privacy preferences' });
    const controls = await dialog.evaluate((d) => d.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])').length);
    await dialog.getByRole('heading', { name: 'Privacy preferences' }).click();
    for (let i = 0; i < controls + 2; i += 1) await page.keyboard.press('Shift+Tab');
    expect((await focusIn(page)).inside).toBe(true);
    expect(await left(page), 'focus that left the dialog').toEqual([]);
  });

  test('after a click on its text, Tab goes to its first control (unchanged)', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Privacy preferences' });
    await dialog.getByRole('heading', { name: 'Privacy preferences' }).click();
    await page.keyboard.press('Tab');
    await expect.poll(() => focusIn(page)).toEqual({ inside: true, name: 'Close dialog' });
    expect(await left(page), 'focus that left the dialog').toEqual([]);
  });
});
