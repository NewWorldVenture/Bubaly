// POST /api/contact-center/voice (Register B API-97ED864085E2), the Twilio
// inbound-call webhook, driven through the real exported handler over the
// in-memory database seeded with two households.
//
// The caller is Twilio, so member roles are n/a (public webhook): the signature,
// checked by lib/server/twilio-ingress.ts verifyTwilioRequest, is the whole
// boundary, and the dialled number alone decides the household.
// Already proven elsewhere: tests/contact-center-callback-boundary.test.ts →
// an invalid signature through middleware is 401 and a signed call's TwiML
// carries its transcription callback; tests/the-urgent-fallback-number-a-parent-
// types-still-reaches-their-phone.test.ts → forwarding number normalisation.
// Added here: an UNSIGNED request, a signature under another token, a deployment
// without a token (503, even with the fixture opt-out set outside NODE_ENV=test),
// the greeting read back for each household with nothing of the other in it, an
// unknown number that creates no channel, and a failed routing read.
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key, getLocaleContext: async () => ({ locale: { code: 'en-US' } }) }));

const ORIGIN = 'https://bubaly.example';
const PATH = '/api/contact-center/voice';
const TOKEN = 'test-fake-twilio-token';
const A = { family: 'aaaaaaaa-0000-4000-8000-00000000000a', name: 'Household Alpha', number: '+15555550100', greeting: 'Alpha greeting, leave a note.' };
const B = { family: 'bbbbbbbb-0000-4000-8000-00000000000b', name: 'Household Bravo', number: '+15555550110', forward: '+15555550199' };
const CALLER = '+15555550123';
let db: ReturnType<typeof createInMemorySupabase>;

function form(fields: Record<string, string> = {}) {
  return { To: A.number, From: CALLER, CallSid: `CA${'1'.repeat(32)}`, ...fields };
}
function request(params: Record<string, string>, signWith: string | null = TOKEN) {
  const url = `${ORIGIN}${PATH}`;
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (signWith) headers['x-twilio-signature'] = createHmac('sha1', signWith)
    .update(url + Object.keys(params).sort().map(key => key + params[key]).join('')).digest('base64');
  return new NextRequest(url, { method: 'POST', headers, body: new URLSearchParams(params) });
}
async function post(req: NextRequest) {
  const { POST } = await import('@/app/api/contact-center/voice/route');
  return POST(req);
}
const snapshot = () => structuredClone({ channels: db.table('family_contact_channels'), families: db.table('families'), inbox: db.table('family_inbox_messages') });

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  db = createInMemorySupabase({ uniques: { family_contact_channels: [['family_id']] } });
  db.seed('families', [{ id: A.family, name: A.name, timezone: 'UTC' }, { id: B.family, name: B.name, timezone: 'UTC' }]);
  db.seed('family_contact_channels', [
    { id: 'channel-a', family_id: A.family, phone_number: A.number, email_local: 'alpha', ai_concierge_enabled: true, ai_greeting: A.greeting, forward_to_phone: null },
    { id: 'channel-b', family_id: B.family, phone_number: B.number, email_local: 'bravo', ai_concierge_enabled: false, ai_greeting: null, forward_to_phone: B.forward },
  ]);
  db.seed('family_inbox_messages', []);
  mocks.admin.mockReturnValue(db);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('who may call it: only a request Twilio signed (roles n/a, public webhook)', () => {
  it.each([
    ['API-97ED864085E2 an unsigned call is refused with 401 before any household is read', null],
    ['API-97ED864085E2 a call signed with another auth token is refused with 401 before any household is read', 'test-fake-other-token'],
  ])('%s', async (_title, signWith) => {
    const before = snapshot();
    const response = await post(request(form(), signWith));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it('API-97ED864085E2 a production deployment with no auth token refuses an unsigned call with 503 even when the fixture opt-out flag is set', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', '');
    vi.stubEnv('ALLOW_UNSIGNED_TWILIO_WEBHOOKS', '1');
    const response = await post(request(form(), null));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Twilio callbacks are not configured here');
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});

describe('a correctly signed call end to end', () => {
  it('API-97ED864085E2 greets a call to household A with A’s greeting and a transcription callback naming only A, writing nothing', async () => {
    const before = snapshot();
    const response = await post(request(form()));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/xml');
    const xml = await response.text();
    expect(xml).toContain(`<Say voice="Polly.Joanna-Neural">${A.greeting}</Say>`);
    expect(xml).toContain(`transcribeCallback="${ORIGIN}/api/contact-center/voice/transcription?familyId=${A.family}"`);
    expect(xml).not.toContain('<Dial');
    for (const foreign of [B.family, B.name, B.number, B.forward]) expect(xml).not.toContain(foreign);
    expect(snapshot()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('another household’s number', () => {
  it('API-97ED864085E2 a call to household B’s number is routed by that number alone: B’s forward, never A’s greeting or id', async () => {
    const before = snapshot();
    const response = await post(request(form({ To: B.number })));
    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain(`>${B.forward}</Dial>`);
    for (const foreign of [A.family, A.name, A.greeting]) expect(xml).not.toContain(foreign);
    expect(snapshot()).toEqual(before);
  });

  it('API-97ED864085E2 a call to a number no household owns says so and hangs up, creating no channel and naming no household', async () => {
    const before = snapshot();
    const response = await post(request(form({ To: '+15555550177' })));
    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain('voice.thisNumberIsNotIn');
    expect(xml).toContain('<Hangup />');
    for (const foreign of [A.family, B.family, A.name, B.name]) expect(xml).not.toContain(foreign);
    expect(snapshot()).toEqual(before);
  });
});

describe('failure', () => {
  it('API-97ED864085E2 a failed number-routing read answers 503 without its error text and greets no one', async () => {
    mocks.admin.mockReturnValue(withFaults(db, (table, calls) => (
      table === 'family_contact_channels' && calls.some(call => call.method === 'eq' && call.args[0] === 'phone_number')
        ? { message: 'test-fake private routing diagnostic' } : null)));
    const response = await post(request(form()));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Routing temporarily unavailable');
  });
});
