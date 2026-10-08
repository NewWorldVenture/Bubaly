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
  // Legacy-equivalent rows are seeded after migration installation. The separate
  // SQL fixture proves pre-0475 upgrade preservation; this proves real JWT APIs.
  test('legacy audiences survive reactivation and future membership beside a separate empty Family Chat', async ({ baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Owned multi-user SDK acceptance runs once.');
    requireLocalOrigin(baseURL);
    const provider = requireLocalOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
    if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.RESEND_API_KEY
      || process.env.SENDGRID_API_KEY || process.env.TWILIO_ACCOUNT_SID) {
      throw new Error('Messenger history E2E refuses external provider credentials.');
    }
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    const publicKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
    const admin = localClient(provider, serviceKey);
    const accounts: OwnedAccount[] = [], clients: Client[] = [];
    const uploadedPaths: string[] = [];
    try {
      for (let index = 0; index < 4; index++) accounts.push(await createOwnedAccount(provider, serviceKey));
      const [alice, bob, reactivated, future] = accounts;
      const familyId = alice.familyId;
      const memberIds: string[] = [];
      for (const [index, account] of accounts.entries()) {
        if (index < 3) {
          const member = await admin.from('family_members').upsert({ family_id: familyId, user_id: account.userId,
            display_name: `History member ${index}`, role: 'parent', is_active: index !== 2,
          }, { onConflict: 'family_id,user_id' }).select('id').single();
          expect(!member.error && !!member.data, 'Owned history membership is installed').toBe(true);
          memberIds.push(member.data!.id);
        }
        const client = localClient(provider, publicKey);
        clients.push(client);
        const auth = await client.auth.signInWithPassword({ email: account.email, password: account.password });
        expect(!auth.error && auth.data.user?.id === account.userId, 'History client owns its authenticated identity').toBe(true);
      }
      const [a, b, c, d] = clients;
      const ids: string[] = Array.from({ length: 5 }, () => randomUUID());
      const [ab, abc, named, creatorOnly, union] = ids;
      const legacy = [
        { id: ab, name: 'Private AB', participant_ids: memberIds.slice(0, 2), member_ids: [alice.userId, bob.userId], is_archived: false },
        { id: abc, name: 'Explicitly invited ABC', participant_ids: memberIds, member_ids: [alice.userId, bob.userId, reactivated.userId], is_archived: false },
        { id: named, name: 'Family Chat', participant_ids: memberIds.slice(0, 2), member_ids: [alice.userId, bob.userId], is_archived: false },
        { id: creatorOnly, name: 'Family Chat', participant_ids: [], member_ids: [], is_archived: false },
        { id: union, name: 'Recorded audience union', participant_ids: memberIds.slice(0, 2), member_ids: [alice.userId, reactivated.userId], is_archived: false },
      ];
      const seeded = await admin.from('family_conversations').insert(legacy.map(row => ({ ...row,
        family_id: familyId, created_by: alice.userId, kind: 'group',
      })));
      expect(!seeded.error, 'Legacy-equivalent conversations are fixture setup only').toBe(true);
      // Full local replay installs 0459's private bucket. These byte controls
      // do not claim confidentiality for production's retained public bucket.
      const attachmentPath = `${familyId}/messages/${abc}/${alice.userId}/${randomUUID()}.txt`;
      uploadedPaths.push(attachmentPath);
      const attachmentBytes = 'Owned explicitly invited legacy attachment';
      const uploaded = await a.storage.from('family-media').upload(attachmentPath, Buffer.from(attachmentBytes), { contentType: 'text/plain' });
      expect(!uploaded.error && uploaded.data?.path === attachmentPath, 'Original participant uploads genuine owned attachment bytes').toBe(true);
      const messages = ids.map((id, index) => ({ id: randomUUID(), family_id: familyId, conversation_id: id,
        sender_id: alice.userId, sender_name: 'History owner', content: `Owned legacy history ${index}`, kind: 'text',
        attachment_url: id === abc ? attachmentPath : null,
      }));
      expect(!(await admin.from('family_messages').insert(messages)).error, 'Owned legacy history is seeded').toBe(true);
      expect(!(await admin.from('family_conversations').update({ is_archived: true }).eq('id', named).eq('family_id', familyId)).error,
        'Fixture archives its named legacy group after seeding its history').toBe(true);
      const snapshot = async () => {
        const conversations = await admin.from('family_conversations').select('*').in('id', ids).order('id');
        const history = await admin.from('family_messages').select('*').in('id', messages.map(row => row.id)).order('id');
        expect(!conversations.error && !history.error, 'Owned immutable snapshot succeeds').toBe(true);
        expect(conversations.data).toHaveLength(ids.length);
        expect(history.data).toHaveLength(messages.length);
        return { conversations: conversations.data!, history: history.data };
      };
      const original = await snapshot();
      expect(original.conversations.every(row => row.is_family_chat === false), 'Every seeded legacy group retains the noncanonical database default').toBe(true);
      const assertHistory = async (client: Client, allowed: string[]) => {
        const rows = await client.from('family_messages').select('id,conversation_id,content,sender_id')
          .eq('family_id', familyId).in('conversation_id', ids).order('id');
        expect(!rows.error, 'Authenticated legacy history query succeeds').toBe(true);
        const expected = messages.filter(row => allowed.includes(row.conversation_id)).map(row => ({
          id: row.id, conversation_id: row.conversation_id, content: row.content, sender_id: row.sender_id,
        })).sort((left, right) => left.id.localeCompare(right.id));
        expect(rows.data, 'Exact original messages are visible only to their recorded audience').toEqual(expected);
        const overview = await client.rpc('family_conversation_overview', { p_family_id: familyId });
        // An inactive/non-household caller can be explicitly refused. Active
        // callers must have a healthy overview, not an error mistaken for denial.
        if (allowed.length) {
          expect(!overview.error, 'Authorized history overview succeeds').toBe(true);
          expect(overview.data!.filter(row => ids.includes(row.conversation_id)).map(row => row.conversation_id).sort()).toEqual([...allowed].sort());
        } else if (!overview.error) {
          expect(overview.data!.filter(row => ids.includes(row.conversation_id))).toEqual([]);
        }
      };
      await assertHistory(a, ids);
      await assertHistory(b, [ab, abc, named, union]);
      await assertHistory(c, []);
      await assertHistory(d, []);
      const assertAttachmentDenied = async (client: Client) => {
        const signed = await client.storage.from('family-media').createSignedUrl(attachmentPath, 30);
        expect(!!signed.error && !signed.data, 'Uninvited or inactive member cannot sign old private media').toBe(true);
        const downloaded = await client.storage.from('family-media').download(attachmentPath);
        expect(!!downloaded.error && !downloaded.data, 'Uninvited or inactive member cannot download old private bytes').toBe(true);
      };
      await assertAttachmentDenied(c);
      await assertAttachmentDenied(d);
      const ownFamily = await d.from('family_members').select('id').eq('family_id', future.familyId).eq('user_id', future.userId);
      expect(!ownFamily.error && ownFamily.data?.length === 1, 'Future member already has healthy real Auth and its own household').toBe(true);

      const canonical = await a.rpc('ensure_family_conversation', { p_family_id: familyId });
      expect(!canonical.error && !!canonical.data && !ids.includes(canonical.data), 'Canonical RPC creates a separate identity').toBe(true);
      const canonicalId = canonical.data!;
      const canonicalRow = await a.from('family_conversations').select('id,is_family_chat').eq('id', canonicalId).single();
      expect(!canonicalRow.error && canonicalRow.data?.is_family_chat === true, 'Fresh canonical identity is explicitly family-wide').toBe(true);
      for (const client of [a, b]) {
        const empty = await client.from('family_messages').select('id').eq('conversation_id', canonicalId);
        expect(!empty.error && empty.data?.length === 0, 'New canonical history is empty before any family-wide write').toBe(true);
      }
      const initialSentinelId = randomUUID();
      const initialSentinel = { id: initialSentinelId, content: 'Owned canonical history before new memberships' };
      const initialWrite = await a.from('family_messages').insert({ ...initialSentinel, family_id: familyId,
        conversation_id: canonicalId, sender_id: alice.userId, kind: 'text',
      }).select('id').single();
      expect(!initialWrite.error && initialWrite.data?.id === initialSentinelId, 'Canonical history is intentionally family-wide before membership changes').toBe(true);

      expect(!(await admin.from('family_members').update({ is_active: true }).eq('id', memberIds[2]).eq('family_id', familyId)).error,
        'Fixture reactivates the original inactive household member').toBe(true);
      await assertHistory(c, [abc, union]);
      const invitedAttachment = await c.storage.from('family-media').download(attachmentPath);
      expect(!invitedAttachment.error && await invitedAttachment.data?.text() === attachmentBytes,
        'Reactivated explicitly invited member regains actual old attachment bytes').toBe(true);
      const added = await admin.from('family_members').insert({ family_id: familyId, user_id: future.userId,
        display_name: 'Future history member', role: 'parent', is_active: true,
      }).select('id').single();
      expect(!added.error && !!added.data, 'Fixture adds the first future household membership').toBe(true);
      await assertHistory(d, []);
      await assertAttachmentDenied(d);
      const futureOverview = await d.rpc('family_conversation_overview', { p_family_id: familyId });
      expect(!futureOverview.error && !futureOverview.data?.some(row => ids.includes(row.conversation_id)),
        'Active same-family parent has a healthy overview without legacy groups').toBe(true);
      expect(await snapshot(), 'Reactivation and future membership do not rewrite legacy rows').toEqual(original);

      const invitedTopic = c.channel(`messages:${abc}`, { config: { private: true } }).on('broadcast', { event: 'typing' }, () => {});
      expect(await join(invitedTopic), 'Reactivated explicitly invited participant can join its old private topic').toBe('SUBSCRIBED');
      for (const client of [c, d]) {
        const deniedTopic = client.channel(`messages:${ab}`, { config: { private: true } }).on('broadcast', { event: 'typing' }, () => {});
        expect(await join(deniedTopic), 'Active household membership cannot grant the old private AB topic').toBe('CHANNEL_ERROR');
        await client.removeChannel(deniedTopic);
      }
      const delivered: Array<{ id: string; conversation_id: string }> = [];
      const changes = d.channel(`history-family:${randomUUID()}`).on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'family_messages', filter: `family_id=eq.${familyId}`,
      }, payload => { delivered.push(payload.new as { id: string; conversation_id: string }); });
      expect(await join(changes), 'Future member has a subscribed authenticated history stream').toBe('SUBSCRIBED');
      for (const client of clients) {
        const repeated = await client.rpc('ensure_family_conversation', { p_family_id: familyId });
        expect(!repeated.error && repeated.data === canonicalId, 'Every active member gets the same canonical identity').toBe(true);
        const canonicalHistory = await client.from('family_messages').select('id,content').eq('conversation_id', canonicalId);
        expect(!canonicalHistory.error, 'Active members can read intentional canonical history').toBe(true);
        expect(canonicalHistory.data, 'Reactivated and future members inherit canonical history only').toEqual([initialSentinel]);
      }
      const privateId = randomUUID(), sentinelId = randomUUID();
      const privateWrite = await a.from('family_messages').insert({ id: privateId, family_id: familyId,
        conversation_id: ab, sender_id: alice.userId, content: 'Owned later private AB message', kind: 'text',
      }).select('id').single();
      expect(!privateWrite.error && privateWrite.data?.id === privateId, 'Original participant can still write its private group').toBe(true);
      const privateRead = await b.from('family_messages').select('id').eq('id', privateId).single();
      expect(!privateRead.error && privateRead.data?.id === privateId, 'Original invited participant retains healthy private access').toBe(true);
      const familyWrite = await a.from('family_messages').insert({ id: sentinelId, family_id: familyId,
        conversation_id: canonicalId, sender_id: alice.userId, content: 'Owned new family-wide sentinel', kind: 'text',
      }).select('id').single();
      expect(!familyWrite.error && familyWrite.data?.id === sentinelId, 'Authenticated owner writes the new family-wide message').toBe(true);
      await expect.poll(() => delivered.some(row => row.id === sentinelId), { timeout: 20_000 }).toBe(true);
      expect(delivered.some(row => row.id === privateId || ids.includes(row.conversation_id)),
        'A later same-socket family delivery does not disclose earlier private history').toBe(false);
      for (const client of clients) {
        const visible = await client.from('family_messages').select('id,content').eq('conversation_id', canonicalId).order('id');
        expect(!visible.error, 'Active household member reads new canonical history').toBe(true);
        expect(visible.data).toEqual([initialSentinel, { id: sentinelId, content: 'Owned new family-wide sentinel' }]
          .sort((left, right) => left.id.localeCompare(right.id)));
      }
      for (const client of [c, d]) {
        const forbidden = await client.from('family_messages').select('id').eq('id', privateId);
        expect(!forbidden.error && forbidden.data?.length === 0, 'Canonical access does not widen private history').toBe(true);
      }
      for (const patch of [{ participant_ids: [...memberIds, added.data!.id] }, { member_ids: [alice.userId, bob.userId, future.userId] },
        { created_by: bob.userId }, { family_id: bob.familyId }, { is_family_chat: true }]) {
        // Deliberately exercise forbidden wire fields beyond the application's
        // permitted Update DTO; the real server must reject the actual request.
        const changed = await a.from('family_conversations')
          .update(patch as Database['public']['Tables']['family_conversations']['Update']).eq('id', ab).select('id');
        expect(!!changed.error, 'Authenticated caller cannot rewrite an existing conversation audience or identity').toBe(true);
      }
      const finalSnapshot = await snapshot();
      const originalAB = original.conversations.find(row => row.id === ab)!;
      const finalAB = finalSnapshot.conversations.find(row => row.id === ab)!;
      for (const field of ['last_message_at', 'updated_at'] as const) {
        expect(Number.isFinite(Date.parse(finalAB[field]!)), 'Authorized send has a valid activity timestamp').toBe(true);
        expect(Date.parse(finalAB[field]!)).toBeGreaterThanOrEqual(Date.parse(originalAB[field]!));
      }
      // Only AB received the deliberate later private write. Every other row,
      // including its activity timestamps, must remain byte-for-byte unchanged.
      expect({ ...finalSnapshot, conversations: finalSnapshot.conversations.map(row => row.id === ab
        ? { ...row, last_message_at: originalAB.last_message_at, updated_at: originalAB.updated_at } : row) },
      'Legacy identity, audience, archived state and every original message remain unchanged').toEqual(original);
      const finalCanonical = await a.rpc('ensure_family_conversation', { p_family_id: familyId });
      expect(!finalCanonical.error && finalCanonical.data === canonicalId, 'Canonical identity remains stable after messaging').toBe(true);
    } finally {
      const cleanupFailures: boolean[] = [];
      for (const client of clients) {
        try { await client.removeAllChannels(); await client.auth.signOut({ scope: 'local' }); } catch { cleanupFailures.push(true); }
      }
      if (uploadedPaths.length) {
        try {
          const removed = await admin.storage.from('family-media').remove(uploadedPaths);
          if (removed.error || removed.data?.length !== uploadedPaths.length) cleanupFailures.push(true);
        } catch { cleanupFailures.push(true); }
      }
      for (const account of accounts) { try { await account.dispose(); } catch { cleanupFailures.push(true); } }
      if (cleanupFailures.length) throw new Error('Messenger history E2E could not fully clean up its owned local fixture.');
    }
  });
});
