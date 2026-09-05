import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const rejectCookies = page.getByRole('button', { name: 'Reject non-essential', exact: true });
  if (await rejectCookies.isVisible()) await rejectCookies.click();
});

test('the mobile menu becomes usable when its client code is ready', async ({ context }) => {
  const slowPage = await context.newPage();
  await slowPage.setViewportSize({ width: 390, height: 844 });
  let releaseScripts!: () => void;
  const scriptsReady = new Promise<void>((resolve) => { releaseScripts = resolve; });
  let heldScripts = 0;
  await slowPage.route(/\/_next\/static\/.*\.js(?:\?.*)?$/, async (route) => {
    heldScripts += 1;
    await scriptsReady;
    await route.continue();
  });

  try {
    await slowPage.goto('/', { waitUntil: 'commit' });
    const toggle = slowPage.getByRole('button', { name: 'Toggle menu' });
    const navigation = slowPage.getByRole('navigation', { name: 'Mobile navigation' });
    await expect(toggle).toBeVisible();
    await expect.poll(() => heldScripts).toBeGreaterThan(0);
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(navigation).toBeHidden();

    releaseScripts();
    await expect(toggle).toBeEnabled({ timeout: 15_000 });
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await slowPage.keyboard.press('Enter');
    await expect(navigation).toBeVisible();
    await slowPage.keyboard.press('Escape');
    await expect(navigation).toBeHidden();
    await expect(toggle).toBeFocused();
  } finally {
    releaseScripts();
    await slowPage.close();
  }
});

test('Get started reaches the welcome page before sign-in', async ({ page }) => {
  await page.getByRole('link', { name: /get started/i }).first().click();
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole('heading', { name: 'Welcome to Bubaly' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Get started', exact: true })).toHaveAttribute('href', '/signup');
});

test('each homepage feature leads to its existing detail card', async ({ page }) => {
  const links = page.getByRole('navigation', { name: 'Explore family tools' }).getByRole('link');
  await expect(links).toHaveCount(6);
  expect(await links.first().evaluate((node) => getComputedStyle(node).boxShadow)).toBe('none');
  const destinations = await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')!));
  expect(new Set(destinations).size).toBe(6);
  await links.first().click();
  await expect(page).toHaveURL(/\/features#smart-calendar$/);
  for (const destination of destinations) {
    await page.goto(destination);
    const card = page.locator(destination.slice(destination.indexOf('#')));
    await expect(card.getByRole('heading')).toBeVisible();
    await expect.poll(async () => (await card.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(56);
  }
});

test('kid sign-in has a labelled PIN and a usable visibility control', async ({ page }) => {
  await page.goto('/kid-login');
  const username = page.getByRole('textbox', { name: 'Username', exact: true });
  expect(await username.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
  const pin = page.getByLabel('4-digit PIN', { exact: true });
  await pin.fill('1234');
  await expect(pin).toHaveAttribute('type', 'password');
  const show = page.getByRole('button', { name: 'Show PIN', exact: true });
  const target = await show.boundingBox();
  expect(target?.width).toBeGreaterThanOrEqual(44);
  expect(target?.height).toBeGreaterThanOrEqual(44);
  await show.click();
  await expect(pin).toHaveAttribute('type', 'text');
  await expect(pin).toHaveValue('1234');
  await page.getByRole('button', { name: 'Hide PIN', exact: true }).click();
  await expect(pin).toHaveAttribute('type', 'password');
  await expect(page).toHaveURL(/\/kid-login$/);
});

test('the mobile menu supports keyboard dismissal and returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page.getByRole('button', { name: 'Toggle menu' });
  const navigation = page.getByRole('navigation', { name: 'Mobile navigation' });
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeEnabled();
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(navigation).toBeVisible();
  const firstLink = navigation.getByRole('link', { name: 'Features', exact: true });
  expect(await firstLink.evaluate((node) => getComputedStyle(node).boxShadow)).toBe('none');
  await page.keyboard.press('Tab');
  await expect(firstLink).toBeFocused();
  expect(await firstLink.evaluate((node) => getComputedStyle(node).boxShadow)).not.toBe('none');
  await page.keyboard.press('Escape');
  await expect(navigation).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('mobile navigation closes after a route change and marks the current page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page.getByRole('button', { name: 'Toggle menu' });
  const navigation = page.getByRole('navigation', { name: 'Mobile navigation' });
  await toggle.click();
  await navigation.getByRole('link', { name: 'Features', exact: true }).click();
  await expect(page).toHaveURL(/\/features$/);
  await expect(navigation).toBeHidden();
  await toggle.click();
  await expect(navigation.getByRole('link', { name: 'Features', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('mobile navigation stays usable on short screens and resets at desktop width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 480 });
  const toggle = page.getByRole('button', { name: 'Toggle menu' });
  const navigation = page.getByRole('navigation', { name: 'Mobile navigation' });
  await toggle.click();
  const panel = page.locator('#mobile-navigation');
  expect(await panel.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await navigation.getByRole('link', { name: 'Get Started Free' }).scrollIntoViewIfNeeded();
  await expect(navigation.getByRole('link', { name: 'Get Started Free' })).toBeInViewport();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('device permissions allow first-party tools but exclude third-party origins', async ({ page }) => {
  const report = await page.evaluate(() => {
    const policy = (document as Document & {
      featurePolicy: { allowsFeature: (feature: string, origin?: string) => boolean };
    }).featurePolicy;
    return ['camera', 'microphone', 'geolocation'].map((feature) => ({
      feature,
      ownOrigin: policy.allowsFeature(feature),
      otherOrigin: policy.allowsFeature(feature, 'https://example.com'),
    }));
  });
  expect(report).toEqual(['camera', 'microphone', 'geolocation'].map((feature) => ({
    feature, ownOrigin: true, otherOrigin: false,
  })));
});
