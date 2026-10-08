import { createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { Database, Tables } from '../../lib/database.types';
import { authCookieName, closeWithoutSnapshot, createOwnedAccount, readSession, requireLocalOrigin } from './helpers/durable-session';

const phase = process.env.E2E_BILL_ANCHOR_PHASE;
if (phase !== undefined && !['old', 'modern'].includes(phase)) throw new Error('Unknown isolated bill phase.');

// RFC 6238, SHA1/30 seconds/6 digits. Secrets and codes stay in memory.
function totp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.toUpperCase().replace(/=+$/, '')) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error('Invalid disposable TOTP seed.');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = bits.match(/.{8}/g)?.map(value => parseInt(value, 2)) ?? [];
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest[19] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

function localClient(origin: string, key: string) {
  requireLocalOrigin(origin);
  if (!key) throw new Error('Disposable bill credentials are required.');
  return createClient<Database>(origin, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]),
    }) },
  });
}

const rowFor = (page: Page, name: string) => page.getByText(name, { exact: true }).locator('..').locator('..');
test.use({ trace: 'off', screenshot: 'off', video: 'off', locale: 'en-US' });
test.describe('authenticated recurring bill durable anchor', () => {
  test.skip(phase === undefined, 'Requires the explicitly owned isolated CI bill stack and phase.');
  test.setTimeout(240_000);
  test('real Auth, Next schedule action, browser payment and fresh reload preserve or refuse the anchor', async ({ browser, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Run the owned desktop fixture once.');
    const app = requireLocalOrigin(baseURL), provider = requireLocalOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(new URL(provider).hostname) || new URL(provider).port !== '54321'
      || new URL(app).port !== '3107' || process.env.CI !== 'true' || process.env.GITHUB_JOB !== 'e2e'
      || !/^\d+-\d+:[a-f0-9-]{36}$/.test(process.env.BUBALY_BILL_STACK_MARKER ?? '')
      || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.RESEND_API_KEY
      || process.env.SENDGRID_API_KEY || process.env.TWILIO_ACCOUNT_SID) throw new Error('Refuse unowned or provider-enabled bill fixture.');
    const admin = localClient(provider, process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');
    const client = localClient(provider, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '');
    const account = await createOwnedAccount(provider, process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');
    let context: BrowserContext | undefined;
    const ids: string[] = [];
    try {
      context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
      await context.route('**/*', route => [app, provider].includes(new URL(route.request().url()).origin)
        ? route.continue() : route.abort('blockedbyclient'));
      await context.routeWebSocket('**/*', route => {
        const url = new URL(route.url()); url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
        if ([app, provider].includes(url.origin)) route.connectToServer(); else void route.close();
      });
      const login = await client.auth.signInWithPassword({ email: account.email, password: account.password });
      expect(!login.error && login.data.user?.id === account.userId, 'Real owned Auth sign-in').toBe(true);
      const enrollment = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Owned bill fixture' });
      if (enrollment.error || !enrollment.data || enrollment.data.type !== 'totp') throw new Error('Disposable GoTrue must support genuine TOTP enrollment.');
      const secret = enrollment.data.totp.secret;
      const usedCounter = Math.floor(Date.now() / 30_000);
      const verification = await client.auth.mfa.challengeAndVerify({ factorId: enrollment.data.id, code: totp(secret) });
      expect(!verification.error, 'Real GoTrue verifies the owned TOTP factor').toBe(true);
      const level = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(!level.error && level.data?.currentLevel === 'aal2', 'SDK has genuine AAL2').toBe(true);
      const page = await context.newPage();
      let nextActions = 0, payments = 0;
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === app && request.method() === 'POST' && request.headers()['next-action']) nextActions++;
        if (url.origin === provider && url.pathname === '/rest/v1/bills' && request.method() === 'PATCH') payments++;
      });
      await page.goto(`${app}/login?redirect=${encodeURIComponent('/dashboard/bills')}`);
      try {
        await page.locator('input[name="email"]').fill(account.email);
        await page.locator('input[name="password"]').fill(account.password);
      } catch { throw new Error('Could not fill owned bill login.'); }
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page).toHaveURL(/\/auth\/step-up\?/, { timeout: 60_000 });
      await expect.poll(() => Math.floor(Date.now() / 30_000) > usedCounter, { timeout: 35_000 }).toBe(true);
      const inputs = page.getByRole('group').filter({ has: page.locator('input[autocomplete="one-time-code"]') }).locator('input');
      await expect(inputs).toHaveCount(6);
      try { for (const [index, digit] of [...totp(secret)].entries()) await inputs.nth(index).fill(digit); }
      catch { throw new Error('Could not enter owned TOTP code.'); }
      await expect(page).toHaveURL(`${app}/dashboard/bills`, { timeout: 60_000 });
      const browserSession = readSession(await context.cookies(), authCookieName(provider));
      expect(browserSession.user.id === account.userId, 'Browser owns the authenticated session').toBe(true);
      const jwt = JSON.parse(Buffer.from(browserSession.access_token.split('.')[1], 'base64url').toString());
      expect(jwt.aal === 'aal2', 'Real browser step-up issued AAL2').toBe(true);

      const year = new Date().getUTCFullYear() + 1;
      async function seed(date: string, recurrence = 'monthly') {
        const id = randomUUID(), name = `Bill fixture ${id}`; ids.push(id);
        const result = await admin.from('bills').insert({ id, name, family_id: account.familyId, created_by: account.userId,
          amount: 12, due_date: date, is_recurring: true, recurrence, status: 'upcoming', autopay: false,
          ...(phase === 'modern' ? { due_day: null } : {}),
        });
        expect(!result.error, 'Own synthetic bill seeded').toBe(true);
        await page.reload(); await expect(rowFor(page, name)).toBeVisible();
        return { id, name };
      }
      async function read(id: string): Promise<Tables<'bills'>> {
        const result = await client.from('bills').select('*').eq('id', id).eq('family_id', account.familyId).single();
        expect(!result.error && result.data?.id === id, 'Fresh authenticated SDK reread').toBe(true);
        return result.data!;
      }
      async function reloadDate(name: string, date: string) {
        const readResponse = page.waitForResponse(response => new URL(response.url()).origin === provider
          && new URL(response.url()).pathname === '/rest/v1/bills' && response.request().method() === 'GET' && response.ok());
        await page.reload(); await readResponse;
        const formatted = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
        await expect(rowFor(page, name)).toContainText(`Due ${formatted}`);
      }
      async function confirm(name: string, day: string, message: string) {
        await rowFor(page, name).getByRole('button', { name: 'Edit schedule', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Edit schedule' });
        await dialog.getByRole('combobox', { name: 'Day of month' }).selectOption(day);
        const before = nextActions;
        const response = page.waitForResponse(result => new URL(result.url()).origin === app
          && result.request().method() === 'POST' && !!result.request().headers()['next-action']);
        await dialog.getByRole('button', { name: 'Save schedule', exact: true }).click();
        await response;
        await expect(page.getByText(message, { exact: true })).toBeVisible();
        expect(nextActions > before, 'Actual Next schedule server action was dispatched').toBe(true);
        if (message === 'Bill schedule saved.') await expect(dialog).toBeHidden();
      }
      async function paid(bill: { id: string; name: string }, date: string, day?: number) {
        const before = await read(bill.id), requests = payments;
        await rowFor(page, bill.name).getByRole('button', { name: 'Mark paid', exact: true }).click();
        await expect.poll(async () => (await read(bill.id)).due_date).toBe(date);
        const after = await read(bill.id);
        expect(after.updated_at !== before.updated_at, 'Source trigger changed updated_at').toBe(true);
        expect(after.status).toBe('upcoming');
        if (day !== undefined) expect(after.due_day).toBe(day);
        expect(payments > requests, 'Actual browser SDK payment PATCH was dispatched').toBe(true);
        await reloadDate(bill.name, date);
        expect((await read(bill.id)).due_date).toBe(date);
      }
      const unavailable = 'Recurring bill schedules are not available yet. This change was not saved.';
      if (phase === 'old') {
        const safe = await seed(`${year}-01-15`);
        await paid(safe, `${year}-02-15`);
        const known = await seed(`${year}-01-31`), before = await read(known.id);
        const missingColumn = page.waitForResponse(response => new URL(response.url()).origin === provider
          && new URL(response.url()).pathname === '/rest/v1/bills' && response.request().method() === 'PATCH');
        await rowFor(page, known.name).getByRole('button', { name: 'Mark paid', exact: true }).click();
        const refused = await missingColumn;
        expect(refused.status(), 'Real old-schema PostgREST refusal').toBe(400);
        expect((await refused.json()).code, 'Genuine PostgREST missing-column code').toBe('PGRST204');
        await expect(page.getByText(unavailable, { exact: true })).toBeVisible();
        expect(await read(known.id)).toEqual(before);
        const ambiguous = await seed(`${year}-03-28`), snapshot = await read(ambiguous.id);
        await confirm(ambiguous.name, '31', unavailable);
        expect(await read(ambiguous.id)).toEqual(snapshot);
        await page.reload(); expect(await read(ambiguous.id)).toEqual(snapshot);
      } else {
        const monthly = await seed(`${year}-01-31`);
        await confirm(monthly.name, '31', 'Bill schedule saved.');
        expect((await read(monthly.id)).due_date).toBe(`${year}-01-31`);
        const feb = new Date(Date.UTC(year, 2, 0)).getUTCDate();
        await paid(monthly, `${year}-02-${feb}`, 31);
        await paid(monthly, `${year}-03-31`, 31);
        await paid(monthly, `${year}-04-30`, 31);
        await paid(monthly, `${year}-05-31`, 31);
        const ambiguous = await seed(`${year}-03-28`);
        await confirm(ambiguous.name, '31', 'Bill schedule saved.');
        expect((await read(ambiguous.id)).due_date).toBe(`${year}-03-28`);
        expect((await read(ambiguous.id)).due_day).toBe(31);
        await paid(ambiguous, `${year}-04-30`, 31);
        await paid(ambiguous, `${year}-05-31`, 31);
        let leap = year; while (new Date(Date.UTC(leap, 1, 29)).getUTCMonth() !== 1) leap++;
        const yearly = await seed(`${leap}-02-29`, 'yearly');
        await confirm(yearly.name, '29', 'Bill schedule saved.');
        for (let offset = 1; offset <= 4; offset++) {
          const y = leap + offset, last = new Date(Date.UTC(y, 2, 0)).getUTCDate();
          await paid(yearly, `${y}-02-${last}`, 29);
        }
        const stale = await seed(`${year}-06-15`);
        await rowFor(page, stale.name).getByRole('button', { name: 'Edit schedule', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Edit schedule' });
        await dialog.getByRole('combobox', { name: 'Day of month' }).selectOption('31');
        const updated = await client.from('bills').update({ amount: 13 }).eq('id', stale.id).eq('family_id', account.familyId).select('id');
        expect(!updated.error && updated.data?.length === 1, 'Authenticated competing update succeeds').toBe(true);
        const retained = await read(stale.id);
        await dialog.getByRole('button', { name: 'Save schedule', exact: true }).click();
        await expect(page.getByText('This bill changed. Refresh before confirming its schedule.', { exact: true })).toBeVisible();
        expect(await read(stale.id)).toEqual(retained);
        await page.reload(); expect(await read(stale.id)).toEqual(retained);
      }
    } finally {
      try { if (context) await closeWithoutSnapshot(context); }
      finally {
        try {
          if (ids.length) {
            const removed = await admin.from('bills').delete().in('id', ids).eq('family_id', account.familyId).eq('created_by', account.userId);
            if (removed.error) throw new Error('Could not clean up owned bill records.');
          }
        } finally { await account.dispose(); }
      }
    }
  });
});
