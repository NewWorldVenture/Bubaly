import { expect, test, type BrowserContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../lib/database.types';
import {
  authCookieName, closeWithoutSnapshot, createOwnedAccount, readSession, requireLocalOrigin, type OwnedAccount,
} from './helpers/durable-session';

const TOKEN = 'ci-only-guardian-signed-ingress-fixture';
const ACCOUNT = `AC${'a'.repeat(32)}`;
async function signedPost(url: string, fields: Record<string, string>, valid = true) {
  const signed = url + Object.keys(fields).sort().map(key => key + fields[key]).join('');
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': valid ? createHmac('sha1', TOKEN).update(signed).digest('base64') : 'invalid' },
    body: new URLSearchParams(fields),
  });
  return { status: response.status, xml: await response.text() };
}
function statusTarget(xml: string, origin: string) {
  const action = /<Message\s[^>]*action="([^"]+)"/.exec(xml)?.[1]?.replaceAll('&amp;', '&');
  const callback = /<Message\s[^>]*statusCallback="([^"]+)"/.exec(xml)?.[1]?.replaceAll('&amp;', '&');
  if (!action || action !== callback || !xml.includes('method="POST"')) throw new Error('Expected one consistent SMS status callback.');
  const target = new URL(action);
  if (target.origin !== origin || target.pathname !== '/api/contact-center/sms/status'
    || !target.searchParams.get('receipt') || !target.searchParams.get('token')) throw new Error('Unexpected SMS status callback binding.');
  return target;
}

test.use({ trace: 'off', screenshot: 'off', video: 'off', locale: 'en-US' });
test.describe('Contact Center delivery status through signed HTTP, PostgreSQL and the real inbox', () => {
  test.skip(process.env.E2E_DURABLE_SESSION !== '1', 'Requires disposable local Supabase.');
  test.setTimeout(180_000);

  test('shows only verified provider progress, preserves terminal status and refuses forged delivery', async ({ browser, baseURL }) => {
    const appOrigin = requireLocalOrigin(baseURL), origin = requireLocalOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
    if (process.env.TWILIO_AUTH_TOKEN !== TOKEN || process.env.TWILIO_ACCOUNT_SID
      || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
      throw new Error('SMS delivery E2E requires isolated synthetic configuration.');
    }
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    if (!serviceKey) throw new Error('SMS delivery E2E needs disposable backend configuration.');
    const admin = createClient<Database>(origin, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(5000), ...(init?.signal ? [init.signal] : [])]),
      }) },
    });
    let account: OwnedAccount | undefined, context: BrowserContext | undefined;
    try {
      account = await createOwnedAccount(origin, serviceKey);
      const familyId = account.familyId;
      // The real Contact Center requires Family+. This local-only entitlement
      // belongs to the fixture and performs no payment or provider operation.
      const entitlement = await admin.from('subscriptions').insert({ family_id: familyId, plan: 'plus', status: 'active' }).select('id');
      expect(!entitlement.error && entitlement.data?.length === 1).toBe(true);
      const suffix = BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`) % 10_000_000_000n;
      const phone = `+1${suffix.toString().padStart(10, '0')}`;
      const channel = await admin.from('family_contact_channels').insert({
        family_id: familyId, phone_number: phone, ai_concierge_enabled: true,
      }).select('family_id');
      expect(!channel.error && channel.data?.length === 1, 'Create only the owned synthetic channel').toBe(true);
      const fields = { AccountSid: ACCOUNT, MessageSid: `SM${randomUUID().replaceAll('-', '')}`,
        From: '+12025550197', To: phone, Body: 'A special offer is available this week.' };
      const inbound = await signedPost(`${appOrigin}/api/contact-center/sms`, fields);
      expect(inbound.status).toBe(200);
      const target = statusTarget(inbound.xml, appOrigin);
      const receiptId = target.searchParams.get('receipt')!;
      const receipts = () => admin.from('ai_tool_calls').select('*').eq('family_id', familyId)
        .eq('tool_name', 'contact_center.sms_reply').eq('id', receiptId).single();
      const inbox = () => admin.from('family_inbox_messages').select('*').eq('family_id', familyId).eq('channel', 'sms').order('id');
      const firstReceipt = await receipts(), firstInbox = await inbox();
      expect(!firstReceipt.error && !firstInbox.error).toBe(true);
      expect(firstReceipt.data?.outputs).toMatchObject({ phase: 'emission_reserved', emissionAccountSid: ACCOUNT });
      const outboundId = firstInbox.data?.find(row => row.direction === 'outbound')?.id;
      expect(!!outboundId, 'One reply projection must exist').toBe(true);

      context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      let runtimeErrors = 0, consoleErrors = 0, failedAppResponses = 0;
      page.on('pageerror', () => { runtimeErrors++; });
      page.on('console', message => { if (message.type() === 'error') consoleErrors++; });
      page.on('response', response => { if (response.url().startsWith(appOrigin + '/') && response.status() >= 400) failedAppResponses++; });
      await page.goto(`${appOrigin}/login?redirect=/dashboard/contact-center`, { waitUntil: 'domcontentloaded' });
      try {
        await page.locator('input[name="email"]').fill(account.email);
        await page.locator('input[name="password"]').fill(account.password);
      } catch { throw new Error('SMS delivery E2E could not fill its owned sign-in form.'); }
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page).toHaveURL(`${appOrigin}/dashboard/contact-center`, { timeout: 60_000 });
      expect(readSession(await context.cookies(), authCookieName(origin)).user.id === account.userId, 'The inbox browser belongs to its owned fixture').toBe(true);
      const card = page.locator(`#inbox-message-${outboundId}`);
      await expect(card.getByText('Reply confirmation unknown', { exact: true })).toBeVisible();
      const providerFields = { AccountSid: ACCOUNT, MessageSid: `SM${randomUUID().replaceAll('-', '')}`, From: phone, To: fields.From };
      for (const [status, label] of [['queued', 'Reply queued by provider'], ['sent', 'Reply sent to carrier'], ['delivered', 'Reply delivery reported']] as const) {
        const result = await signedPost(target.toString(), { ...providerFields, MessageStatus: status });
        expect(result.status).toBe(200);
        expect(/<Message(?:\s|>)/.test(result.xml)).toBe(false);
        const saved = await receipts();
        expect(saved.error).toBeNull();
        expect(saved.data?.outputs).toMatchObject({ phase: 'emission_reserved', delivery: { providerSid: providerFields.MessageSid, status } });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(card.getByText(label, { exact: true })).toBeVisible();
      }
      const terminal = await receipts();
      expect(terminal.error).toBeNull();
      for (const status of ['delivered', 'sending', 'queued', 'failed']) {
        expect((await signedPost(target.toString(), { ...providerFields, MessageStatus: status })).status).toBe(200);
        expect((await receipts()).data).toEqual(terminal.data);
      }
      const wrongToken = new URL(target);
      wrongToken.searchParams.set('token', randomUUID());
      expect((await signedPost(wrongToken.toString(), { ...providerFields, MessageStatus: 'delivered' })).status).toBe(403);
      expect((await signedPost(target.toString(), { ...providerFields, MessageSid: `SM${randomUUID().replaceAll('-', '')}`, MessageStatus: 'delivered' })).status).toBe(403);
      expect((await signedPost(target.toString(), { ...providerFields, AccountSid: `AC${'b'.repeat(32)}`, MessageStatus: 'delivered' })).status).toBe(403);
      expect((await signedPost(target.toString(), { ...providerFields, MessageStatus: 'delivered' }, false)).status).toBe(403);
      expect((await receipts()).data).toEqual(terminal.data);
      expect((await inbox()).data).toEqual(firstInbox.data);
      const replay = await signedPost(`${appOrigin}/api/contact-center/sms`, fields);
      expect(replay.status).toBe(200);
      expect(/<Message(?:\s|>)/.test(replay.xml)).toBe(false);
      expect((await receipts()).data).toEqual(terminal.data);
      const second = await signedPost(`${appOrigin}/api/contact-center/sms`, { ...fields, MessageSid: `SM${randomUUID().replaceAll('-', '')}` });
      expect(second.status).toBe(200);
      const secondTarget = statusTarget(second.xml, appOrigin);
      const secondProvider = { ...providerFields, MessageSid: `SM${randomUUID().replaceAll('-', '')}` };
      const concurrent = await Promise.all(['sent', 'failed'].map(MessageStatus => signedPost(secondTarget.toString(), { ...secondProvider, MessageStatus })));
      expect(concurrent.map(result => result.status)).toEqual([200, 200]);
      expect(concurrent.some(result => /<Message(?:\s|>)/.test(result.xml))).toBe(false);
      const secondReceipt = await admin.from('ai_tool_calls').select('outputs').eq('family_id', familyId)
        .eq('tool_name', 'contact_center.sms_reply').eq('id', secondTarget.searchParams.get('receipt')!).single();
      expect(secondReceipt.error).toBeNull();
      expect(secondReceipt.data?.outputs).toMatchObject({ phase: 'emission_reserved', delivery: { providerSid: secondProvider.MessageSid, status: 'failed' } });
      const afterSecond = await inbox();
      expect(afterSecond.error).toBeNull();
      const failedOutbound = afterSecond.data?.find(row => row.direction === 'outbound' && row.id !== outboundId);
      expect(!!failedOutbound, 'The failed reply retains its own projection').toBe(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator(`#inbox-message-${failedOutbound!.id}`).getByText('Reply failed to send', { exact: true })).toBeVisible();
      await expect(card.getByText('Reply delivery reported', { exact: true })).toBeVisible();
      const html = await page.content();
      const privateValues = [receiptId, target.searchParams.get('token')!, providerFields.MessageSid,
        secondTarget.searchParams.get('receipt')!, secondTarget.searchParams.get('token')!, secondProvider.MessageSid, ACCOUNT];
      expect(privateValues.some(value => html.includes(value)), 'The inbox must not expose private receipt credentials or provider identifiers').toBe(false);
      expect(runtimeErrors).toBe(0);
      expect(consoleErrors).toBe(0);
      expect(failedAppResponses).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'The phone inbox must not overflow horizontally').toBe(true);
    } finally {
      try { if (context) await closeWithoutSnapshot(context); }
      finally { if (account) await account.dispose(); }
    }
  });
});
