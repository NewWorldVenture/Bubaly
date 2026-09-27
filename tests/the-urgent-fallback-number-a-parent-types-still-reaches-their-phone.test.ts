// m13 · Dashboard → Contact Center → AI concierge → "Urgent fallback number".
//
// That field is the family's answer to "if something is urgent, reach me HERE".
// Its placeholder is "+1 555 123 4567" — with spaces — and the value was stored
// exactly as typed. Everything downstream needs E.164 and none of it can say so:
// the urgent text is refused by the provider before it leaves the server
// (sendSmsWithReceipt's /^\+[1-9]\d{7,14}$/), and the refusal is rendered on no
// screen in the app, so the parent believes an urgent message at the family line
// will text their phone when it only ever becomes an in-app notification. The
// same string is also interpolated into the `<Dial>` element of the TwiML for a
// forwarded call, where an '&' or a '<' costs the caller the whole call.
//
// These tests assert the three things a family would notice: the urgent text
// actually arrives at the number the parent typed; a number whose country the
// app could only GUESS is asked for again in a sentence, not stored as a guess
// (ten bare digits read as +1 can be a real number in another city — and the
// urgent text would reach a stranger); and a caller to the family line is
// actually put through.

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), ctx: vi.fn(), plan: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin, createServer: async () => ({}) }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.ctx }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: mocks.plan }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

// The action translates through the REAL en-US catalogue, with production's
// behaviour for a missing key: the key itself is what comes back — and
// components/modules/contact-center-module.tsx renders `res.error` verbatim in
// the role="alert" banner, so a missing entry is a parent reading a camelCase
// key in a red box.
const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const t = (key: string, params?: Record<string, string | number>) => translate(EN_US, key, params);
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => t }));

// The refusal copy, typed out here — never looked up — so a missing catalogue
// entry fails the cases that read it instead of matching the key it fell back
// to. `actions.enterTheFallbackNumberIn` is new with this fix and reaches
// en-US.json through the catalogue merge that lands in the same commit; UNTIL
// THAT MERGE LANDS the refusal cases below are red, which is the point: without
// it the banner says `actions.enterTheFallbackNumberIn` and nothing else.
const ASK_FOR_INTERNATIONAL_FORM = 'Enter the fallback number in international form, for example +15551234567.';

const ORIGIN = 'https://contact.example';
const FAMILY = '11111111-1111-4111-8111-111111111111';
const LINE = '+15555550100';        // the number the family published
const NEIGHBOUR = '+15555551212';
const SID = `SM${'1'.repeat(32)}`;
const network = vi.fn<typeof fetch>();
let db: ReturnType<typeof createInMemorySupabase>;

/** A document Twilio can parse: every '&' opens an entity, every '<' opens a tag.
 *  An unparseable TwiML is not read loosely — the caller hears "an application
 *  error has occurred" and the call drops. */
function parseableXml(xml: string): boolean {
  return !/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(xml) && !/<(?![?/a-zA-Z])/.test(xml);
}

/** Telephony must be configured BEFORE the provider module is evaluated: it reads
 *  its credentials once, at import. */
function stubTelephonyEnv() {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('TWILIO_ACCOUNT_SID', `AC${'a'.repeat(32)}`);
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'test-only-contact-token');
  vi.stubEnv('TWILIO_PHONE_NUMBER', '+15555550999');
}

// Evaluate the graph under test once, with the credentials in place, so no
// individual case pays the first-import cost inside its own timeout.
beforeAll(async () => {
  stubTelephonyEnv();
  await import('@/lib/guardian/twilio');
  await import('@/lib/contact-center/urgent-delivery');
  await import('@/app/(app)/dashboard/contact-center/actions');
  await import('@/app/api/contact-center/voice/route');
}, 180_000);

beforeEach(() => {
  vi.clearAllMocks(); network.mockReset();
  stubTelephonyEnv();
  vi.stubGlobal('fetch', network);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  db = createInMemorySupabase({
    uniques: { ai_tool_calls: [['id'], ['family_id', 'idempotency_key']], notifications: [['id']], family_inbox_messages: [['channel', 'provider_ref']], app_settings: [['key']] },
    defaults: { family_inbox_messages: { ai_handled: false, direction: 'inbound', status: 'new' }, notifications: { is_read: false, sent_at: null, pushed_at: null } },
  });
  db.seed('families', [{ id: FAMILY, name: 'Synthetic family', timezone: 'UTC' }]);
  db.seed('family_contact_channels', [{ family_id: FAMILY, phone_number: LINE, forward_to_phone: null, ai_concierge_enabled: true, provisioning_status: 'active' }]);
  mocks.admin.mockReturnValue(db);
  mocks.ctx.mockResolvedValue({ active: { role: 'parent', familyId: FAMILY } });
  mocks.plan.mockResolvedValue(2);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** What the parent does: type it into the field and press Save. */
async function saveFallback(typed: string | null) {
  const { updateConciergeAction } = await import('@/app/(app)/dashboard/contact-center/actions');
  return updateConciergeAction({ forwardTo: typed });
}
const stored = () => db.table('family_contact_channels')[0].forward_to_phone;

/** An urgent text arrives at the family line; run the real escalation. */
async function urgentEscalation(providerRef = 'urgent-1') {
  const worker = await import('@/lib/contact-center/urgent-delivery');
  const captured = await worker.captureInboundWithUrgency(db as never, {
    familyId: FAMILY, channel: 'sms', providerRef, from: NEIGHBOUR, to: LINE,
    body: 'The school called about Ivy, please ring me', aiSummary: 'The school called about Ivy', aiIntent: 'urgent',
  });
  return worker.attemptUrgentDelivery(db as never, captured.urgentReceiptId!, FAMILY);
}

describe('the urgent fallback number a parent types', () => {
  it('is the number the urgent text is actually sent to, typed the way the field shows it', async () => {
    network.mockImplementation(async () => Response.json({ sid: SID, status: 'queued' }, { status: 201 }));
    expect(await saveFallback('+1 555 123 4567')).toEqual({ ok: true });

    expect(await urgentEscalation()).toBe('accepted');
    expect(network).toHaveBeenCalledOnce();
    const sent = new URLSearchParams(String(network.mock.calls[0][1]?.body));
    expect(sent.get('To')).toBe('+15551234567');
    expect(db.table('ai_tool_calls')[0]).toMatchObject({ state: 'succeeded', error: null, outputs: { phase: 'accepted', providerSid: SID } });
  });

  it('is the number the urgent text is actually sent to when it is typed with local punctuation around the country code', async () => {
    network.mockImplementation(async () => Response.json({ sid: SID, status: 'queued' }, { status: 201 }));
    expect(await saveFallback('+1 (555) 123-4567')).toEqual({ ok: true });
    expect(stored()).toBe('+15551234567');

    expect(await urgentEscalation()).toBe('accepted');
    expect(new URLSearchParams(String(network.mock.calls[0][1]?.body)).get('To')).toBe('+15551234567');
  });

  it('is asked for with its country code rather than guessed, so a local number is never texted to a stranger', async () => {
    // The parent's real phone is on the row; what they type now is an Italian
    // mobile the local way — ten digits, no leading zero. Read as +1 that is
    // "+13123456789", a real Chicago number the provider would deliver to.
    db.table('family_contact_channels')[0].forward_to_phone = '+15555550300';
    network.mockImplementation(async () => Response.json({ sid: SID, status: 'queued' }, { status: 201 }));

    expect(await saveFallback('312 345 6789')).toEqual({ ok: false, error: ASK_FOR_INTERNATIONAL_FORM });
    // The same for a US number typed the local way: the app cannot tell the two apart.
    expect(await saveFallback('(555) 123-4567')).toEqual({ ok: false, error: ASK_FOR_INTERNATIONAL_FORM });
    expect(stored()).toBe('+15555550300');
    expect(await urgentEscalation()).toBe('accepted');
    expect(new URLSearchParams(String(network.mock.calls[0][1]?.body)).get('To')).toBe('+15555550300');
  });

  it('is refused when it is not a number at all, instead of silently ending the escalation', async () => {
    db.table('family_contact_channels')[0].forward_to_phone = '+15555550300';
    network.mockImplementation(async () => Response.json({ sid: SID, status: 'queued' }, { status: 201 }));

    expect(await saveFallback('Mom & Dad')).toEqual({ ok: false, error: ASK_FOR_INTERNATIONAL_FORM });
    // Letters after a plus are not a number either; dropping them would store one the parent never typed.
    expect(await saveFallback('+1 555 CALL MOM')).toEqual({ ok: false, error: ASK_FOR_INTERNATIONAL_FORM });
    // The number that worked is still the number that works.
    expect(stored()).toBe('+15555550300');
    expect(await urgentEscalation()).toBe('accepted');
    expect(new URLSearchParams(String(network.mock.calls[0][1]?.body)).get('To')).toBe('+15555550300');
  });

  it('is cleared, not corrupted, when the parent empties the field', async () => {
    db.table('family_contact_channels')[0].forward_to_phone = '+15555550300';
    expect(await saveFallback('   ')).toEqual({ ok: true });
    expect(stored()).toBeNull();
    // No fallback is a stated choice, so the escalation stays in-app and says so.
    expect(await urgentEscalation()).toBe('in_app_only');
    expect(network).not.toHaveBeenCalled();
  });
});

describe('a call to the family line with a legacy fallback value on the row', () => {
  // A value an earlier build accepted is still sitting in rows today, and the
  // forwarding branch reads the column, not the form.
  it('is put through rather than dropped on a document Twilio cannot parse', async () => {
    Object.assign(db.table('family_contact_channels')[0], { ai_concierge_enabled: false, forward_to_phone: 'Mom & Dad <555-0200>' });
    const { POST } = await import('@/app/api/contact-center/voice/route');
    // Signed as Twilio signs it, with the token stubbed above: the voice route
    // verifies every request now, not only in production (SEC-015's ingress).
    const url = `${ORIGIN}/api/contact-center/voice`;
    const params: Record<string, string> = { To: LINE, From: NEIGHBOUR, CallSid: `CA${'1'.repeat(32)}` };
    const signed = url + Object.keys(params).sort().map((key) => key + params[key]).join('');
    const req = new NextRequest(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': createHmac('sha1', 'test-only-contact-token').update(signed).digest('base64'),
      },
      body: new URLSearchParams(params),
    });
    const xml = await (await POST(req)).text();
    expect(xml).toContain('<Dial');
    expect(parseableXml(xml)).toBe(true);
    expect(xml).toContain('Mom &amp; Dad &lt;555-0200&gt;');
  });

  it('proves that check has teeth: the pre-fix document is not parseable', () => {
    expect(parseableXml('<?xml version="1.0"?><Response><Dial>Mom & Dad <555-0200></Dial></Response>')).toBe(false);
    expect(parseableXml('<?xml version="1.0"?><Response><Dial>+15555550200</Dial></Response>')).toBe(true);
  });
});
