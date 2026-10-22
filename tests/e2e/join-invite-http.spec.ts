import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';
import type { Database } from '../../lib/database.types';
import {
  authCookieName, closeWithoutSnapshot, createOwnedAccount, readSession, requireLocalOrigin, type OwnedAccount,
} from './helpers/durable-session';

type Admin = SupabaseClient<Database>;
type Fixture = {
  app: string; provider: string; admin: Admin; context: BrowserContext; page: Page;
  invitee: OwnedAccount; families: [OwnedAccount, OwnedAccount]; tokens: [string, string];
  previewResponses: number;
  rpc: Array<{ ok: boolean; tokenA: boolean; tokenB: boolean; familyA: boolean; familyB: boolean }>;
};
const familyNames = ['Invite HTTP Family A', 'Invite HTTP Family B'] as const;
const acceptButton = (page: Page) => page.getByRole('button', { name: 'Accept invitation', exact: true });
const isAction = (request: Request, app: string) => {
  const url = new URL(request.url());
  return url.origin === app && url.pathname === '/join'
    && request.method() === 'POST' && !!request.headers()['next-action'];
};

function localAdmin(provider: string, key: string): Admin {
  requireLocalOrigin(provider);
  if (!key) throw new Error('Invite HTTP fixture requires the disposable backend service key.');
  return createClient<Database>(provider, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => {
      const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (target.origin !== provider) throw new Error('Invite HTTP fixture refuses non-owned backend requests.');
      return fetch(input, { ...init, redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]) });
    } },
  });
}

async function membership(fixture: Fixture) {
  const result = await fixture.admin.from('family_members').select('family_id, is_active')
    .eq('user_id', fixture.invitee.userId).in('family_id', fixture.families.map(account => account.familyId));
  expect(!result.error && Array.isArray(result.data), 'Read only the owned invitee membership rows').toBe(true);
  return {
    a: result.data!.some(row => row.family_id === fixture.families[0].familyId && row.is_active),
    b: result.data!.some(row => row.family_id === fixture.families[1].familyId && row.is_active),
  };
}

async function signIn(fixture: Fixture) {
  await fixture.page.goto(`${fixture.app}/login?redirect=/home`, { waitUntil: 'domcontentloaded' });
  try {
    await fixture.page.locator('input[name="email"]').fill(fixture.invitee.email);
    await fixture.page.locator('input[name="password"]').fill(fixture.invitee.password);
  } catch { throw new Error('Invite HTTP fixture could not fill its owned sign-in form.'); }
  await fixture.page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(fixture.page).toHaveURL(`${fixture.app}/home`, { timeout: 60_000 });
  expect(readSession(await fixture.context.cookies(), authCookieName(fixture.provider)).user.id === fixture.invitee.userId,
    'The real browser session belongs to the disposable invitee').toBe(true);
}

async function showA(fixture: Fixture) {
  try {
    await fixture.page.goto(`${fixture.app}/join?token=${encodeURIComponent(fixture.tokens[0])}`,
      { waitUntil: 'domcontentloaded' });
  } catch { throw new Error('Invite HTTP fixture could not open its owned invitation.'); }
  await expect(fixture.page.getByText(familyNames[0], { exact: false })).toBeVisible();
  await expect(acceptButton(fixture.page)).toBeVisible();
  await expect.poll(() => fixture.previewResponses, { message: 'The actual Next preview action completed' }).toBeGreaterThan(0);
  expect(fixture.rpc, 'Loading an invite does not call accept_invite').toHaveLength(0);
  expect(await membership(fixture), 'Preview creates no household membership').toEqual({ a: false, b: false });
  await fixture.page.evaluate(() => { document.documentElement.dataset.inviteHttpVisit = 'same-document'; });
}

async function changeQuery(fixture: Fixture, token: string | null) {
  // Next App Router integrates the native History API with useSearchParams.
  // This changes the real mounted route; it neither reloads the page nor mocks
  // the router, React, auth, server action or accept_invite implementation.
  await fixture.page.evaluate(value => {
    const next = new URL(location.href);
    if (value === null) next.searchParams.delete('token');
    else next.searchParams.set('token', value);
    history.pushState({}, '', next.pathname + next.search);
  }, token);
  expect(await fixture.page.evaluate(() => document.documentElement.dataset.inviteHttpVisit),
    'The existing document survives the query transition').toBe('same-document');
}

async function acceptAndReadBack(fixture: Fixture, family: 0 | 1) {
  await expect(fixture.page.getByText(familyNames[family], { exact: false })).toBeVisible();
  expect(await membership(fixture), 'The fresh confirmation still requires an explicit click').toEqual({ a: false, b: false });
  await acceptButton(fixture.page).click();
  await expect.poll(() => fixture.rpc.length, { message: 'The browser receives its real authenticated accept_invite response' }).toBe(1);
  expect(fixture.rpc[0], 'The authenticated RPC accepts only the displayed invitation').toEqual({
    ok: true, tokenA: family === 0, tokenB: family === 1, familyA: family === 0, familyB: family === 1,
  });
  await expect.poll(() => membership(fixture), { message: 'PostgREST reads back only the explicitly accepted household' })
    .toEqual({ a: family === 0, b: family === 1 });
  const invites = await fixture.admin.from('invites').select('token, status, accepted_by')
    .eq('email', fixture.invitee.email).in('family_id', fixture.families.map(account => account.familyId));
  expect(!invites.error && invites.data?.length === 2, 'Read back the two owned invitation records').toBe(true);
  expect(invites.data?.some(row => row.token === fixture.tokens[family]
    && row.status === 'accepted' && row.accepted_by === fixture.invitee.userId),
  'The accepted invitation belongs to the actual signed-in account').toBe(true);
  expect(invites.data?.some(row => row.token === fixture.tokens[1 - family]
    && row.status === 'pending' && row.accepted_by === null),
  'The other household invitation remains unaccepted').toBe(true);
  // The fixture's existing home membership is its active preference. The
  // unchanged server landing resolver therefore chooses /home after success.
  await expect.poll(() => fixture.page.url() === `${fixture.app}/home`,
    { timeout: 30_000, message: 'The accepted invitation reaches the server-selected home route' }).toBe(true);
}

test.use({ trace: 'off', screenshot: 'off', video: 'off', locale: 'en-US' });
test.describe('invite ownership through real Next, Auth and PostgREST', () => {
  test.skip(process.env.E2E_DURABLE_SESSION !== '1', 'Requires the disposable local Supabase E2E stack.');
  test.setTimeout(180_000);

  for (const scenario of ['initial', 'changed', 'missing', 'delayed-preview'] as const) {
    test(`${scenario}: confirmation and real membership belong to the current invitation`, async ({ browser, baseURL }, testInfo) => {
      test.skip(testInfo.project.name !== 'chromium', 'The independent real HTTP invitation controls run once on desktop Chromium.');
      // Origin guards precede credentials, account creation and HTTP requests.
      const app = requireLocalOrigin(baseURL);
      const provider = requireLocalOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
      if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.RESEND_API_KEY
        || process.env.SENDGRID_API_KEY || process.env.TWILIO_ACCOUNT_SID) {
        throw new Error('Invite HTTP fixture refuses external provider credentials.');
      }
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
      const admin = localAdmin(provider, serviceKey);
      const accounts: OwnedAccount[] = [];
      let context: BrowserContext | undefined;
      let releasePreview = () => {};
      const pendingResponses: Promise<void>[] = [];
      let responseFailure = false;
      let primaryFailure: { error: unknown } | undefined;
      try {
        for (let index = 0; index < 3; index++) accounts.push(await createOwnedAccount(provider, serviceKey));
        const [invitee, ownerA, ownerB] = accounts;
        const families: [OwnedAccount, OwnedAccount] = [ownerA, ownerB];
        const tokens: [string, string] = [randomUUID(), randomUUID()];
        for (const [index, owner] of families.entries()) {
          const name = await admin.from('families').update({ name: familyNames[index] })
            .eq('id', owner.familyId).eq('created_by', owner.userId).select('id');
          expect(!name.error && name.data?.length === 1, 'Name only the owned synthetic household').toBe(true);
          const invite = await admin.from('invites').insert({
            family_id: owner.familyId, email: invitee.email, role: 'parent', token: tokens[index],
            invited_by: owner.userId, status: 'pending', expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }).select('id');
          expect(!invite.error && invite.data?.length === 1, 'Create only the owned synthetic invitation').toBe(true);
        }
        context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
        await context.route('**/*', route => {
          const target = new URL(route.request().url());
          return [app, provider].includes(target.origin) ? route.continue() : route.abort('blockedbyclient');
        });
        await context.routeWebSocket('**/*', route => {
          const target = new URL(route.url());
          target.protocol = target.protocol === 'ws:' ? 'http:' : 'https:';
          if ([app, provider].includes(target.origin)) route.connectToServer();
          else void route.close();
        });
        const page = await context.newPage();
        const fixture: Fixture = { app, provider, admin, context, page, invitee, families, tokens, previewResponses: 0, rpc: [] };
        page.on('response', response => {
          const request = response.request(), target = new URL(response.url());
          if (isAction(request, app) && request.postData()?.includes(tokens[0]) && response.ok()) fixture.previewResponses++;
          if (target.origin !== provider || target.pathname !== '/rest/v1/rpc/accept_invite' || request.method() !== 'POST') return;
          pendingResponses.push((async () => {
            try {
              const sent: unknown = request.postDataJSON();
              const token = sent && typeof sent === 'object' && 'p_token' in sent ? sent.p_token : null;
              const returned: unknown = await response.json();
              fixture.rpc.push({ ok: response.ok(), tokenA: token === tokens[0], tokenB: token === tokens[1],
                familyA: returned === ownerA.familyId, familyB: returned === ownerB.familyId });
            } catch { responseFailure = true; }
          })());
        });
        await signIn(fixture);
        await showA(fixture);

        if (scenario === 'initial') {
          await acceptAndReadBack(fixture, 0);
        } else if (scenario === 'missing') {
          await changeQuery(fixture, null);
          await expect(page.getByRole('heading', { name: 'Invite problem', exact: true })).toBeVisible();
          await expect(acceptButton(page)).toHaveCount(0);
          expect(fixture.rpc, 'Removing the token never submits the previous invitation').toHaveLength(0);
          expect(await membership(fixture)).toEqual({ a: false, b: false });
        } else {
          if (scenario === 'delayed-preview') {
            let previewReady = false, previewDelivered = false, previewFailed = false;
            const gate = new Promise<void>(resolve => { releasePreview = resolve; });
            await page.route(url => url.origin === app && url.pathname === '/join', async route => {
              if (!isAction(route.request(), app) || !route.request().postData()?.includes(tokens[1])) {
                await route.continue(); return;
              }
              try {
                // The action actually executes against the owned local backend.
                // Only delivery is delayed; its response is never fabricated.
                const response = await route.fetch({ maxRedirects: 0, timeout: 30_000 });
                try {
                  previewReady = response.ok();
                  await gate;
                  await route.fulfill({ response });
                  previewDelivered = true;
                } finally { await response.dispose(); }
              } catch { previewFailed = true; await route.abort().catch(() => {}); }
            });
            await changeQuery(fixture, tokens[1]);
            await expect.poll(() => previewReady || previewFailed, { message: 'The actual B preview action reaches the response gate' }).toBe(true);
            expect(previewFailed, 'The real preview response remains available').toBe(false);
            await expect(acceptButton(page), 'Retired A confirmation cannot accept B while its real preview is delayed').toHaveCount(0);
            expect(fixture.rpc).toHaveLength(0);
            expect(await membership(fixture)).toEqual({ a: false, b: false });
            releasePreview();
            await expect.poll(() => previewDelivered, { message: 'The unchanged server preview is delivered' }).toBe(true);
          } else {
            await changeQuery(fixture, tokens[1]);
          }
          await expect(page.getByText(familyNames[0], { exact: false })).toHaveCount(0);
          await acceptAndReadBack(fixture, 1);
        }
        await Promise.all(pendingResponses);
        expect(responseFailure, 'Only fixed response metadata was collected successfully').toBe(false);
      } catch (error) {
        primaryFailure = { error };
      } finally {
        releasePreview();
        const cleanupFailures: boolean[] = [];
        if (context) { try { await closeWithoutSnapshot(context); } catch { cleanupFailures.push(true); } }
        await Promise.all(pendingResponses);
        for (const account of [...accounts].reverse()) {
          try { await account.dispose(); } catch { cleanupFailures.push(true); }
        }
        try { await admin.auth.dispose(); } catch { cleanupFailures.push(true); }
        if (cleanupFailures.length) {
          const cleanupError = new Error('Invite HTTP fixture could not fully clean up its owned local records and browser.');
          if (primaryFailure) throw new AggregateError([primaryFailure.error, cleanupError],
            'Invite HTTP assertions and owned cleanup both failed.');
          throw cleanupError;
        }
      }
      if (primaryFailure) throw primaryFailure.error;
      console.log(`[owned-invite-http] ${scenario} assertions-and-owned-cleanup-complete`);
    });
  }
});
