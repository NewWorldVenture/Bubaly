import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import {
  authCookieName, authCookies, closeWithoutSnapshot, createOwnedAccount, readSession, requireLocalOrigin, type OwnedAccount,
} from './helpers/durable-session';

// Runs against the real Next server and the CI job's disposable GoTrue. This is
// not a component fixture: route.fetch obtains the original HTTP redirect, and
// only its delivery is delayed. No provider response or server action is mocked.
// The invalid-code control covers rejection/fallback; the Mailpit case follows
// a real emailed recovery code through exchange, adoption and password change.
const enabled = process.env.E2E_AUTHENTICATED === '1';
const provider = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const test = base.extend<{ account: OwnedAccount; replacement: OwnedAccount }>({
  account: async ({ baseURL }, runFixture) => {
    requireLocalOrigin(baseURL);
    const account = await createOwnedAccount(provider, process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');
    try { await runFixture(account); } finally { await account.dispose(); }
  },
  replacement: async ({ baseURL }, runFixture) => {
    requireLocalOrigin(baseURL);
    const account = await createOwnedAccount(provider, process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');
    try { await runFixture(account); } finally { await account.dispose(); }
  },
});
test.use({ trace: 'off', screenshot: 'off', video: 'off', locale: 'en-US' });

async function signIn(page: Page, origin: string, account: OwnedAccount) {
  await page.goto(`${origin}/login?redirect=/home`, { waitUntil: 'domcontentloaded' });
  try {
    await page.locator('input[name="email"]').fill(account.email);
    await page.locator('input[name="password"]').fill(account.password);
  } catch { throw new Error('Callback admission E2E could not fill its owned sign-in form.'); }
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/home`, { timeout: 60_000 });
  expect(readSession(await page.context().cookies(), authCookieName(provider)).user.id === account.userId,
    'Production sign-in must adopt the owned fixture account').toBe(true);
}

async function seedInvalidExchange(context: BrowserContext, origin: string) {
  // No session is injected. This synthetic verifier accompanies a nonexistent
  // code so the unchanged control exercises the real action's rejection path.
  await context.addCookies([{ name: authCookieName(provider) + '-code-verifier',
    value: 'base64-' + Buffer.from(JSON.stringify('synthetic-admission-verifier-' + randomUUID())).toString('base64url'),
    url: origin, sameSite: 'Lax' }]);
  return `${origin}/auth/callback?code=${randomUUID()}&next=%2Fhome`;
}

function actionRequest(request: { url(): string; method(): string; headers(): Record<string, string> }, origin: string) {
  const url = new URL(request.url());
  return url.origin === origin && url.pathname === '/auth/complete' && request.method() === 'POST'
    && typeof request.headers()['next-action'] === 'string';
}

async function holdOriginalAdmission(page: Page, origin: string) {
  let ready = false, failed = false, release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.origin === origin && url.pathname === '/auth/callback', async route => {
    try {
      const response = await route.fetch({ maxRedirects: 0 });
      const location = new URL(response.headers().location ?? '', origin);
      if (response.status() !== 307 || location.origin !== origin || location.pathname !== '/auth/complete'
        || !location.searchParams.get('admission') || response.headers()['set-cookie']) {
        throw new Error('Unexpected callback admission response');
      }
      ready = true;
      await gate;
      await route.fulfill({ response });
      await response.dispose();
    } catch {
      failed = true;
      await route.abort().catch(() => {});
    }
  });
  return {
    wait: async () => {
      await expect.poll(() => ready || failed, { timeout: 30_000 }).toBe(true);
      if (failed) throw new Error('Callback admission E2E could not hold the original Next redirect.');
    },
    release,
    failed: () => failed,
  };
}

function sessionBytes(context: BrowserContext) {
  return context.cookies().then(cookies => JSON.stringify(authCookies(cookies, authCookieName(provider))
    .map(({ name, value }) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name))));
}

type MailpitMessage = { ID?: unknown; To?: { Address?: unknown }[]; Text?: unknown; HTML?: unknown };

async function readLocalMailbox(path: string): Promise<unknown> {
  // Supabase CLI 2.109.1 starts Mailpit here in the existing disposable stack.
  // No remote override or mailbox-wide cleanup is allowed for this fixture.
  const mailbox = requireLocalOrigin('http://127.0.0.1:54324');
  try {
    const response = await fetch(new URL(path, mailbox), { redirect: 'error', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error();
    const body = await response.text();
    if (body.length > 1_048_576) throw new Error();
    return JSON.parse(body) as unknown;
  } catch { throw new Error('Callback admission E2E requires the disposable Mailpit API on local port 54324.'); }
}

function ownedRecipient(message: MailpitMessage, email: string) {
  return Array.isArray(message.To) && message.To.length === 1 && message.To[0]?.Address === email;
}

function recoveryLink(message: MailpitMessage, origin: string): string | null {
  const providerOrigin = requireLocalOrigin(provider);
  const body = [message.Text, message.HTML].filter((value): value is string => typeof value === 'string').join('\n');
  if (body.length > 262_144) throw new Error('Callback admission E2E received an oversized owned recovery email.');
  const links = new Set<string>();
  // Mailpit returns decoded MIME content. Decode HTML ampersands without ever
  // rendering the message or visiting an arbitrary link contained in it.
  for (const candidate of body.replace(/&(?:amp|#38|#x26);/gi, '&').match(/https?:\/\/[^\s<>"')]+/g) ?? []) {
    let url: URL;
    try { url = new URL(candidate); } catch { continue; }
    if (url.origin !== providerOrigin || url.pathname !== '/auth/v1/verify') continue;
    const redirect = url.searchParams.getAll('redirect_to');
    const token = url.searchParams.getAll('token');
    const kind = url.searchParams.getAll('type');
    if (url.username || url.password || url.hash || candidate.length > 8_192
      || token.length !== 1 || !token[0] || token[0].length > 4_096
      || kind.length !== 1 || kind[0] !== 'recovery'
      || redirect.length !== 1 || redirect[0] !== `${origin}/auth/callback?next=/auth/recovery`) {
      throw new Error('Callback admission E2E recovery email has an invalid provider link or disposable redirect configuration.');
    }
    links.add(url.href);
  }
  if (links.size > 1) throw new Error('Callback admission E2E received ambiguous owned recovery links.');
  return links.values().next().value ?? null;
}

async function waitForOwnedRecoveryEmail(email: string, origin: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  const seen = new Set<string>();
  do {
    const result = await readLocalMailbox(`/api/v1/search?${new URLSearchParams({ query: `to:${email}`, limit: '5' })}`);
    if (!result || typeof result !== 'object' || !('messages' in result) || !Array.isArray(result.messages)) {
      throw new Error('Callback admission E2E received an invalid disposable Mailpit search response.');
    }
    for (const summary of result.messages.slice(0, 5) as MailpitMessage[]) {
      if (!summary || !ownedRecipient(summary, email)) continue;
      if (typeof summary.ID !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(summary.ID)) {
        throw new Error('Callback admission E2E received an invalid owned Mailpit message ID.');
      }
      if (seen.has(summary.ID)) continue;
      seen.add(summary.ID);
      const message = await readLocalMailbox(`/api/v1/message/${summary.ID}`) as MailpitMessage;
      if (!message || !ownedRecipient(message, email)) {
        throw new Error('Callback admission E2E refuses a mailbox message for a different recipient.');
      }
      const link = recoveryLink(message, origin);
      if (link) return link;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error('Callback admission E2E did not receive its owned recovery email within 30 seconds. Check disposable SMTP configuration.');
}

test.describe('callback admission through the real Next HTTP path', () => {
  test.skip(!enabled, 'Requires E2E_AUTHENTICATED=1 and the existing disposable local Supabase/Next CI setup.');
  test.setTimeout(120_000);

  test('held original redirect cannot continue after production logout before completion mounts', async ({ browser, baseURL, account }) => {
    const origin = requireLocalOrigin(baseURL), context = await browser.newContext({ locale: 'en-US' });
    let release = () => {};
    try {
      const decision = await context.newPage(); await signIn(decision, origin, account);
      const callbackUrl = await seedInvalidExchange(context, origin);
      const completion = await context.newPage();
      let actions = 0;
      completion.on('request', request => { if (actionRequest(request, origin)) actions++; });
      const held = await holdOriginalAdmission(completion, origin); release = held.release;
      const navigation = completion.goto(callbackUrl, { waitUntil: 'domcontentloaded' }).then(() => true, () => false);
      await held.wait();
      await decision.getByRole('button', { name: 'Account menu', exact: true }).click();
      await decision.getByRole('button', { name: 'Sign out', exact: true }).click();
      await decision.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(decision).toHaveURL(/\/login(?:\?|$)/);
      expect(authCookies(await context.cookies(), authCookieName(provider)).length).toBe(0);
      held.release(); expect(await navigation).toBe(true);
      await expect(completion.getByRole('alert')).toContainText('Your sign-in state changed');
      expect(new URL(completion.url()).pathname).toBe('/auth/complete');
      expect(actions, 'Stale admission must be refused before a real server action').toBe(0);
      expect(held.failed()).toBe(false);
      expect(authCookies(await context.cookies(), authCookieName(provider)).length).toBe(0);
    } finally { release(); await closeWithoutSnapshot(context); }
  });

  test('held original redirect preserves a newer production login without intervening logout', async ({ browser, baseURL, account, replacement }) => {
    const origin = requireLocalOrigin(baseURL), context = await browser.newContext({ locale: 'en-US' });
    let release = () => {};
    try {
      const decision = await context.newPage(); await signIn(decision, origin, account);
      const callbackUrl = await seedInvalidExchange(context, origin);
      const completion = await context.newPage();
      let actions = 0;
      completion.on('request', request => { if (actionRequest(request, origin)) actions++; });
      const held = await holdOriginalAdmission(completion, origin); release = held.release;
      const navigation = completion.goto(callbackUrl, { waitUntil: 'domcontentloaded' }).then(() => true, () => false);
      await held.wait();
      await signIn(decision, origin, replacement);
      const before = await sessionBytes(context);
      held.release(); expect(await navigation).toBe(true);
      await expect(completion.getByRole('alert')).toContainText('Your sign-in state changed');
      expect(new URL(completion.url()).pathname).toBe('/auth/complete');
      expect(actions, 'Newer login must be detected before a real server action').toBe(0);
      expect(held.failed()).toBe(false);
      expect(await sessionBytes(context) === before, 'The original response must preserve the newer session bytes').toBe(true);
      expect(readSession(await context.cookies(), authCookieName(provider)).user.id === replacement.userId).toBe(true);
    } finally { release(); await closeWithoutSnapshot(context); }
  });

  test('untouched admission runs the real rejected-code action and preserves the existing login', async ({ browser, baseURL, account }) => {
    const origin = requireLocalOrigin(baseURL), context = await browser.newContext({ locale: 'en-US' });
    try {
      const decision = await context.newPage(); await signIn(decision, origin, account);
      const callbackUrl = await seedInvalidExchange(context, origin);
      const before = await sessionBytes(context);
      const completion = await context.newPage();
      const action = completion.waitForResponse(response => actionRequest(response.request(), origin));
      await completion.goto(callbackUrl, { waitUntil: 'domcontentloaded' });
      const response = await action;
      expect(response.status()).toBe(200);
      const body = await response.text();
      expect(body.includes('"status":"rejected"'), 'The actual server action must reject the nonexistent provider code').toBe(true);
      await expect(completion).toHaveURL(`${origin}/home`, { timeout: 30_000 });
      expect(await sessionBytes(context) === before, 'Failed code exchange must retain the existing session bytes').toBe(true);
      expect(readSession(await context.cookies(), authCookieName(provider)).user.id === account.userId).toBe(true);
    } finally { await closeWithoutSnapshot(context); }
  });

  test('real emailed recovery completes PKCE and the saved password works after production logout', async ({ browser, baseURL, account }) => {
    const origin = requireLocalOrigin(baseURL), context = await browser.newContext({ locale: 'en-US' });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/login?reset=1`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Reset your password', exact: true })).toBeVisible();
      try { await page.locator('input[name="email"]').fill(account.email); }
      catch { throw new Error('Callback admission E2E could not fill its owned recovery request.'); }
      await page.getByRole('button', { name: 'Send recovery link', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('check your inbox for a recovery link', { timeout: 30_000 });
      const verifier = authCookieName(provider) + '-code-verifier';
      expect((await context.cookies()).some(cookie => cookie.value && (cookie.name === verifier || cookie.name.startsWith(`${verifier}.`))),
        'The production email request must create a PKCE verifier').toBe(true);
      const link = await waitForOwnedRecoveryEmail(account.email, origin);
      const exchange = page.waitForResponse(response => actionRequest(response.request(), origin), { timeout: 30_000 })
        .then(async response => response.status() === 200 && !response.headers()['set-cookie']
          && (await response.text()).includes('"status":"exchanged"')).catch(() => false);
      // Keep the token-bearing URL out of Playwright's named navigation steps.
      try { await page.evaluate(value => { window.location.assign(value); }, link); }
      catch { throw new Error('Callback admission E2E could not follow its validated local recovery link.'); }
      expect(await exchange, 'The real completion action must exchange the emailed PKCE code without setting auth cookies').toBe(true);
      // Compare a boolean so a broken redirect cannot expose its code in output.
      await expect.poll(() => page.url() === `${origin}/auth/recovery`, { timeout: 30_000 }).toBe(true);
      await expect(page.getByRole('button', { name: 'Save new password', exact: true })).toBeVisible({ timeout: 30_000 });
      expect(readSession(await context.cookies(), authCookieName(provider)).user.id === account.userId,
        'Successful callback adoption must install the owned recovery account').toBe(true);
      expect((await context.cookies()).some(cookie => cookie.name === verifier || cookie.name.startsWith(`${verifier}.`)),
        'Successful isolated exchange must retire its PKCE verifier').toBe(false);
      const password = `Recovery1!${randomBytes(24).toString('base64url')}`;
      try {
        await page.locator('input[name="password"]').fill(password);
        await page.locator('input[name="confirmation"]').fill(password);
      } catch { throw new Error('Callback admission E2E could not fill its owned replacement password.'); }
      await page.getByRole('button', { name: 'Save new password', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Password updated', exact: true })).toBeVisible({ timeout: 30_000 });
      await page.goto(`${origin}/home`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Account menu', exact: true }).click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname === '/login').toBe(true);
      expect(authCookies(await context.cookies(), authCookieName(provider)).length).toBe(0);
      await signIn(page, origin, { ...account, password });
    } finally { await closeWithoutSnapshot(context); }
  });
});
