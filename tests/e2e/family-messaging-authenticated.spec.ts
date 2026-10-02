import { randomUUID } from 'node:crypto';
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { Database } from '../../lib/database.types';
import {
  authCookieName, closeWithoutSnapshot, createOwnedAccount, readSession, requireLocalOrigin, type OwnedAccount,
} from './helpers/durable-session';

type Client = SupabaseClient<Database>;
const composer = (page: Page) => page.getByRole('textbox', { name: 'Type a message...', exact: true });

function localClient(origin: string, key: string): Client {
  requireLocalOrigin(origin);
  if (!key) throw new Error('Messenger E2E requires disposable local Supabase credentials.');
  return createClient<Database>(origin, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]),
    }) },
  });
}

/** A timeout is not proof of an authorization refusal; keep those distinct. */
function join(channel: RealtimeChannel): Promise<string> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve('TEST_TIMEOUT'), 15_000);
    channel.subscribe(status => {
      if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        clearTimeout(timer); resolve(status);
      }
    });
  });
}

async function signIn(context: BrowserContext, appOrigin: string, provider: string, account: OwnedAccount, conversationId: string) {
  const page = await context.newPage();
  const target = `${appOrigin}/dashboard/messages?conversation=${conversationId}`;
  await page.goto(`${appOrigin}/login?redirect=${encodeURIComponent(`/dashboard/messages?conversation=${conversationId}`)}`, { waitUntil: 'domcontentloaded' });
  // Never put credential-bearing call failures or session contents in reports.
  try {
    await page.locator('input[name="email"]').fill(account.email);
    await page.locator('input[name="password"]').fill(account.password);
  } catch { throw new Error('Messenger E2E could not fill its owned sign-in form.'); }
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(target, { timeout: 60_000 });
  expect(readSession(await context.cookies(), authCookieName(provider)).user.id === account.userId, 'Browser session belongs to this fixture').toBe(true);
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Connecting to live messages…', { exact: true })).toHaveCount(0, { timeout: 20_000 });
  return page;
}

async function send(page: Page, content: string) {
  await composer(page).fill(content);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(composer(page)).toHaveValue('');
}

// Uses real auth, PostgREST, storage, realtime and two real Next.js pages. No
// synthetic component transport, service-role application actions or provider
// sends. Service credentials are limited to disposable setup/inspection/cleanup.
test.use({ trace: 'off', screenshot: 'off', video: 'off', locale: 'en-US' });
test.describe('authenticated private family messenger', () => {
  test.skip(process.env.E2E_DURABLE_SESSION !== '1', 'Requires the disposable local Supabase E2E stack.');
  test.setTimeout(240_000);

  test('two participants chat, recover, react and share privately while a same-family outsider is excluded', async ({ browser, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'The independent multi-user desktop contexts run once; responsive coverage is in family-messages-state.');
    // These guards deliberately ignore E2E_ALLOW_REMOTE_SUPABASE. They run
    // before reading credentials, creating accounts or making any HTTP request.
    const appOrigin = requireLocalOrigin(baseURL);
    const provider = requireLocalOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    const publicKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
    if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.RESEND_API_KEY
      || process.env.SENDGRID_API_KEY || process.env.TWILIO_ACCOUNT_SID) {
      throw new Error('Messenger E2E refuses external provider credentials.');
    }
    const admin = localClient(provider, serviceKey);
    const accounts: OwnedAccount[] = [], clients: Client[] = [], contexts: BrowserContext[] = [];
    let conversationId: string | undefined;
    try {
      for (let index = 0; index < 3; index++) accounts.push(await createOwnedAccount(provider, serviceKey));
      const [alice, bob, outsider] = accounts;
      const names = ['Alice Messenger', 'Bob Messenger', 'Casey Outsider'];
      const memberIds: string[] = [];
      for (const [index, account] of accounts.entries()) {
        const membership = await admin.from('family_members').upsert({ family_id: alice.familyId,
          user_id: account.userId, role: 'parent', display_name: names[index], is_active: true,
        }, { onConflict: 'family_id,user_id' }).select('id').single();
        expect(!membership.error && !!membership.data, 'Own fixture membership exists').toBe(true);
        memberIds.push(membership.data!.id);
        const prefs = await admin.from('user_preferences').upsert({ user_id: account.userId,
          active_family_id: alice.familyId, notification_prefs: { onboardingComplete: true },
        }, { onConflict: 'user_id' });
        expect(!prefs.error, 'Fixture opens the shared household').toBe(true);
        const client = localClient(provider, publicKey);
        clients.push(client);
        const signedIn = await client.auth.signInWithPassword({ email: account.email, password: account.password });
        expect(!signedIn.error && signedIn.data.user?.id === account.userId, 'Member client authenticates as its own fixture').toBe(true);
      }
      const [a, b, c] = clients;
      const created = await a.rpc('create_family_conversation', {
        p_family_id: alice.familyId, p_participant_ids: memberIds.slice(0, 2), p_kind: 'direct',
      });
      expect(!created.error && !!created.data?.id, 'Participant creates a private DM through the authenticated RPC').toBe(true);
      conversationId = created.data!.id;
      const dm = conversationId;
      const outsiderEvents: Array<{ id: string; conversation_id: string }> = [];
      const outsiderChanges = c.channel(`messaging-e2e-family:${randomUUID()}`).on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'family_messages', filter: `family_id=eq.${alice.familyId}`,
      }, payload => { outsiderEvents.push(payload.new as { id: string; conversation_id: string }); });
      expect(await join(outsiderChanges), 'Outsider has a working authenticated Postgres Changes subscription').toBe('SUBSCRIBED');
      const memberTopic = b.channel(`messages:${dm}`, { config: { private: true } }).on('broadcast', { event: 'typing' }, () => {});
      expect(await join(memberTopic), 'Participant may join the private typing topic').toBe('SUBSCRIBED');
      const outsiderTopic = c.channel(`messages:${dm}`, { config: { private: true } }).on('broadcast', { event: 'typing' }, () => {});
      expect(await join(outsiderTopic), 'Same-family manager outside the DM is refused by private-channel authorization').toBe('CHANNEL_ERROR');
      await c.removeChannel(outsiderTopic);

      for (let index = 0; index < 2; index++) {
        const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
        contexts.push(context);
        // The fixture cannot navigate or fetch an external service even if a
        // stale application build contains a remote public provider URL.
        await context.route('**/*', route => {
          const target = new URL(route.request().url());
          return [appOrigin, provider].includes(target.origin) ? route.continue() : route.abort('blockedbyclient');
        });
        await context.routeWebSocket('**/*', route => {
          const target = new URL(route.url());
          target.protocol = target.protocol === 'ws:' ? 'http:' : 'https:';
          if ([appOrigin, provider].includes(target.origin)) route.connectToServer();
          else void route.close();
        });
      }
      const pageA = await signIn(contexts[0], appOrigin, provider, alice, dm);
      const pageB = await signIn(contexts[1], appOrigin, provider, bob, dm);
      const findMessage = async (content: string) => {
        const result = await a.from('family_messages').select('*').eq('family_id', alice.familyId).eq('conversation_id', dm).eq('content', content).single();
        expect(!result.error && !!result.data, 'Confirmed message is readable by its participant').toBe(true);
        return result.data!;
      };

      await test.step('UI send, realtime delivery, reply, reaction and read receipt share one saved row', async () => {
        await send(pageA, 'Private local message from Alice');
        const first = await findMessage('Private local message from Alice');
        expect(first.sender_id).toBe(alice.userId);
        await expect(pageB.locator(`#message-${first.id}`)).toBeVisible({ timeout: 20_000 });
        await expect.poll(async () => (await findMessage('Private local message from Alice')).read_by).toContain(bob.userId);
        await expect(pageA.locator(`#message-${first.id}`).getByLabel('Read', { exact: true })).toBeVisible();

        await pageB.locator(`#message-${first.id}`).getByRole('button', { name: 'Reply', exact: true }).click();
        await send(pageB, 'Private local reply from Bob');
        const reply = await findMessage('Private local reply from Bob');
        expect(reply.reply_to_id).toBe(first.id);
        await expect(pageA.locator(`#message-${reply.id}`)).toBeVisible({ timeout: 20_000 });
        await pageB.locator(`#message-${first.id}`).getByRole('button', { name: 'React 👍', exact: true }).click();
        await expect.poll(async () => (await findMessage('Private local message from Alice')).reactions).toMatchObject({ '👍': [bob.userId] });
        await expect(pageA.locator(`#message-${first.id}`).getByRole('button', { name: '👍, 1 reactions', exact: true })).toBeVisible();

        const notices = await admin.from('notifications').select('user_id, title, body, is_read')
          .eq('family_id', alice.familyId).eq('related_type', 'family_message').eq('related_id', `${dm}:${first.id}`);
        expect(!notices.error, 'Message notice query succeeds').toBe(true);
        expect(notices.data).toEqual([{ user_id: bob.userId, title: 'New message', body: 'Open your conversation in Bubaly.', is_read: true }]);
      });

      await test.step('real browser reconnect recovers a missed confirmed row and mute suppresses its notice', async () => {
        await pageB.getByRole('button', { name: 'Mute notifications', exact: true }).click();
        await expect(pageB.getByRole('button', { name: 'Unmute notifications', exact: true })).toBeVisible();
        await contexts[1].setOffline(true);
        await send(pageA, 'Saved while Bob was offline');
        const offline = await findMessage('Saved while Bob was offline');
        const notices = await admin.from('notifications').select('id').eq('family_id', alice.familyId)
          .eq('related_type', 'family_message').eq('related_id', `${dm}:${offline.id}`);
        expect(!notices.error && notices.data?.length === 0, 'Muted recipient creates no in-app message notice').toBe(true);
        await contexts[1].setOffline(false);
        await expect(pageB.locator(`#message-${offline.id}`)).toBeVisible({ timeout: 30_000 });
        await expect.poll(async () => (await findMessage('Saved while Bob was offline')).read_by).toContain(bob.userId);
      });

      await test.step('UI attachment uses private storage and cannot be signed or downloaded by the outsider', async () => {
        const bytes = Buffer.from('Local-only private attachment fixture.');
        await pageA.locator('form').filter({ has: composer(pageA) }).locator('input[type="file"]').first()
          .setInputFiles({ name: 'private-fixture.txt', mimeType: 'text/plain', buffer: bytes });
        await expect.poll(async () => {
          const result = await a.from('family_messages').select('id').eq('conversation_id', dm).eq('attachment_name', 'private-fixture.txt');
          return result.data?.length ?? 0;
        }).toBe(1);
        const attachment = await a.from('family_messages').select('id, attachment_url').eq('conversation_id', dm).eq('attachment_name', 'private-fixture.txt').single();
        expect(!attachment.error && !!attachment.data?.attachment_url, 'Uploaded attachment has a confirmed message').toBe(true);
        const objectPath = attachment.data!.attachment_url!;
        expect(objectPath.startsWith(`${alice.familyId}/messages/${dm}/${alice.userId}/`)).toBe(true);
        await expect(pageB.locator(`#message-${attachment.data!.id}`).getByRole('link')).toHaveAttribute('href', /\/storage\/v1\/object\/sign\/family-media\//, { timeout: 20_000 });
        const read = await b.storage.from('family-media').download(objectPath);
        expect(!read.error && await read.data?.text() === bytes.toString(), 'Participant reads the actual private object').toBe(true);
        const denied = await c.storage.from('family-media').createSignedUrl(objectPath, 30);
        expect(!!denied.error && !denied.data, 'Outsider cannot mint a signed URL').toBe(true);
        const deniedRead = await c.storage.from('family-media').download(objectPath);
        expect(!!deniedRead.error && !deniedRead.data, 'Outsider cannot download the object').toBe(true);
      });

      await test.step('same-family outsider sees neither private rows nor private realtime payloads', async () => {
        const forbidden = await c.from('family_messages').select('id').eq('family_id', alice.familyId).eq('conversation_id', dm);
        expect(!forbidden.error && forbidden.data?.length === 0, 'RLS hides DM history even from a same-family parent').toBe(true);
        const overview = await c.rpc('family_conversation_overview', { p_family_id: alice.familyId });
        expect(!overview.error && !overview.data?.some(row => row.conversation_id === dm), 'Overview does not leak private chat existence').toBe(true);
        const canonical = await a.rpc('ensure_family_conversation', { p_family_id: alice.familyId });
        expect(!canonical.error && !!canonical.data, 'Canonical family conversation exists').toBe(true);
        const sentinelId = randomUUID();
        const sentinel = await a.from('family_messages').insert({ id: sentinelId, family_id: alice.familyId,
          conversation_id: canonical.data!, sender_id: alice.userId, sender_name: names[0], content: 'Local realtime visibility control', kind: 'text',
        }).select('id').single();
        expect(!sentinel.error, 'Authenticated participant writes the later family-visible control').toBe(true);
        // Positive control AFTER the private writes: absence is not explained
        // by a broken socket or missing publication. No arbitrary sleep window.
        await expect.poll(() => outsiderEvents.some(row => row.id === sentinelId), { timeout: 20_000 }).toBe(true);
        expect(outsiderEvents.some(row => row.conversation_id === dm), 'RLS-filtered realtime did not deliver any DM row').toBe(false);
      });
    } finally {
      const cleanupFailures: boolean[] = [];
      for (const context of contexts) {
        try { await context.setOffline(false); } catch { cleanupFailures.push(true); }
        try { await closeWithoutSnapshot(context); } catch { cleanupFailures.push(true); }
      }
      for (const client of clients) {
        try { await client.removeAllChannels(); await client.auth.signOut({ scope: 'local' }); } catch { cleanupFailures.push(true); }
      }
      if (accounts[0] && conversationId) {
        // Also finds an upload whose message insert failed: cleanup never relies
        // on a database attachment row existing. This prefix is wholly owned.
        const prefix = `${accounts[0].familyId}/messages/${conversationId}/${accounts[0].userId}`;
        try {
          const listed = await admin.storage.from('family-media').list(prefix, { limit: 100 });
          if (listed.error) cleanupFailures.push(true);
          else if (listed.data?.length) {
            const paths = listed.data.map(object => `${prefix}/${object.name}`);
            if (paths.some(value => !value.startsWith(`${prefix}/`) || value.includes('..'))) throw new Error('Unsafe fixture cleanup path');
            const removed = await admin.storage.from('family-media').remove(paths);
            if (removed.error || removed.data?.length !== paths.length) cleanupFailures.push(true);
          }
        } catch { cleanupFailures.push(true); }
      }
      // Shared-family owner first: its deletion removes B/C memberships before
      // their separate, helper-owned households and auth accounts are deleted.
      for (const account of accounts) { try { await account.dispose(); } catch { cleanupFailures.push(true); } }
      if (cleanupFailures.length) throw new Error('Messenger E2E could not fully clean up its owned local fixture.');
    }
  });
});
