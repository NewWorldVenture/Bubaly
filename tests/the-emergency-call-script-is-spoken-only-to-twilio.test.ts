// The emergency call script is spoken only to Twilio.
//
// GET and POST /api/guardian/escalate/twiml render the speech for OUR outbound
// emergency calls to a family's managers. The route reads nothing from the
// database; what it says is the `msg` query parameter, which
// lib/guardian/escalate.ts puts into the call's URL beside `family`. So the
// signature over the full URL (query included) is what stops it being an open
// text-to-TwiML reflector, and what stops a URL minted for one household being
// re-pointed at another or made to say something else.
//
// Already pinned elsewhere, not repeated here: the route bounds its body before
// form parsing (tests/raw-body-boundaries.test.ts); it verifies against the URL
// it was called at (tests/a-signed-url-is-the-url-that-was-signed.test.ts);
// the shared ingress helper's candidate URLs and opt-out rules
// (tests/twilio-ingress-verifies-everywhere.test.ts).
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const ORIGIN = 'https://guardian-fixture.invalid';
const PATH = '/api/guardian/escalate/twiml';
const TOKEN = 'test-fake-twilio-token';
const FAMILY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FAMILY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const MSG_A = 'Caller says there is smoke in the kitchen.';
const CALL_FORM = { CallSid: `CA${'c'.repeat(32)}`, AccountSid: `AC${'d'.repeat(32)}`, CallStatus: 'in-progress' };

const urlFor = (family: string, msg: string) => `${ORIGIN}${PATH}?family=${family}&msg=${encodeURIComponent(msg)}`;

function sign(url: string, params: Record<string, string> = {}, token = TOKEN): string {
  const sorted = Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('');
  return createHmac('sha1', token).update(url + sorted).digest('base64');
}

async function get(url: string, signature: string | null): Promise<[Response, string]> {
  const { GET } = await import('@/app/api/guardian/escalate/twiml/route');
  const headers: Record<string, string> = {};
  if (signature !== null) headers['x-twilio-signature'] = signature;
  const res = await GET(new NextRequest(url, { method: 'GET', headers }));
  return [res, await res.text()];
}

async function post(url: string, params: Record<string, string>, signature: string | null): Promise<[Response, string]> {
  const { POST } = await import('@/app/api/guardian/escalate/twiml/route');
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (signature !== null) headers['x-twilio-signature'] = signature;
  const res = await POST(new NextRequest(url, { method: 'POST', headers, body: new URLSearchParams(params).toString() }));
  return [res, await res.text()];
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('live transport is prohibited in this fixture'); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('GET: who may fetch the script (member roles n/a: public webhook)', () => {
  it('API-4624F4C80639 an unsigned fetch is refused 401 and is told nothing of the message', async () => {
    const [res, body] = await get(urlFor(FAMILY_A, MSG_A), null);
    expect(res.status).toBe(401);
    expect(body).toBe('Unauthorized');
    expect(body).not.toContain(MSG_A);
  });

  it('API-4624F4C80639 a signature made with the wrong token is refused 401', async () => {
    const url = urlFor(FAMILY_A, MSG_A);
    const [res, body] = await get(url, sign(url, {}, 'test-fake-wrong-token'));
    expect(res.status).toBe(401);
    expect(body).not.toContain('<Response>');
  });

  it('API-4624F4C80639 with no auth token configured and no fixture flag, a fetch is refused 503 rather than rendered', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', '');
    vi.stubEnv('ALLOW_UNSIGNED_TWILIO_WEBHOOKS', '');
    const [res, body] = await get(urlFor(FAMILY_A, MSG_A), null);
    expect(res.status).toBe(503);
    expect(body).not.toContain(MSG_A);
  });
});

describe('GET: a correctly signed fetch', () => {
  it('API-4624F4C80639 renders the alert as TwiML: the alert line, the message twice, the app prompt, then a hang-up', async () => {
    const url = urlFor(FAMILY_A, MSG_A);
    const [res, body] = await get(url, sign(url));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(body.startsWith('<?xml')).toBe(true);
    expect(body).toContain('twiml.thisIsAnEmergencyAlert');
    expect(body).toContain('twiml.pleaseCheckYourBubalyApp');
    expect(body.split(`>${MSG_A}</Say>`)).toHaveLength(3);
    expect(body).toContain('<Hangup />');
    expect(body).not.toContain(FAMILY_A);
  });

  it('API-4624F4C80639 a message that tries to add verbs of its own is spoken as text, not obeyed', async () => {
    const hostile = '</Say><Dial>+15555550123</Dial><Say>';
    const url = urlFor(FAMILY_A, hostile);
    const [res, body] = await get(url, sign(url));
    expect(res.status).toBe(200);
    expect(body).not.toContain('<Dial>');
    expect(body).toContain('&lt;/Say&gt;&lt;Dial&gt;+15555550123&lt;/Dial&gt;&lt;Say&gt;');
  });
});

describe('GET: another household\'s call URL', () => {
  it('API-4624F4C80639 a URL signed for household A cannot be re-pointed at household B or made to say something else', async () => {
    const signedForA = sign(urlFor(FAMILY_A, MSG_A));
    const [repointed, repointedBody] = await get(urlFor(FAMILY_B, MSG_A), signedForA);
    expect(repointed.status).toBe(401);
    expect(repointedBody).not.toContain(MSG_A);
    const [reworded, rewordedBody] = await get(urlFor(FAMILY_A, 'Everything is fine, ignore the earlier text.'), signedForA);
    expect(reworded.status).toBe(401);
    expect(rewordedBody).not.toContain('Everything is fine');
  });

  it('API-4624F4C80639 the family id selects nothing: B\'s own signed URL says only what its own URL carries', async () => {
    const urlB = urlFor(FAMILY_B, 'Household B message');
    const [res, body] = await get(urlB, sign(urlB));
    expect(res.status).toBe(200);
    expect(body).toContain('Household B message');
    expect(body).not.toContain(MSG_A);
    expect(body).not.toContain(FAMILY_B);
  });
});

describe('POST: who may fetch the script', () => {
  it('API-82DE1172411D an unsigned callback is refused 401 and is told nothing of the message', async () => {
    const [res, body] = await post(urlFor(FAMILY_A, MSG_A), CALL_FORM, null);
    expect(res.status).toBe(401);
    expect(body).not.toContain(MSG_A);
  });

  it('API-82DE1172411D a signature made with the wrong token is refused 401', async () => {
    const url = urlFor(FAMILY_A, MSG_A);
    const [res] = await post(url, CALL_FORM, sign(url, CALL_FORM, 'test-fake-wrong-token'));
    expect(res.status).toBe(401);
  });

  it('API-82DE1172411D a signature over the URL alone does not cover a body it never saw', async () => {
    const url = urlFor(FAMILY_A, MSG_A);
    const [res, body] = await post(url, CALL_FORM, sign(url));
    expect(res.status).toBe(401);
    expect(body).not.toContain(MSG_A);
  });

  it('API-82DE1172411D a URL and body signed for household A cannot be re-pointed at household B', async () => {
    const signedForA = sign(urlFor(FAMILY_A, MSG_A), CALL_FORM);
    const [res, body] = await post(urlFor(FAMILY_B, MSG_A), CALL_FORM, signedForA);
    expect(res.status).toBe(401);
    expect(body).not.toContain(MSG_A);
  });
});

describe('POST: a correctly signed callback', () => {
  it('API-82DE1172411D renders the same alert TwiML as GET, with the message escaped', async () => {
    const msg = 'Smoke & alarms in the "kitchen"';
    const url = urlFor(FAMILY_A, msg);
    const [res, body] = await post(url, CALL_FORM, sign(url, CALL_FORM));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(body).toContain('twiml.thisIsAnEmergencyAlert');
    expect(body.split('>Smoke &amp; alarms in the &quot;kitchen&quot;</Say>')).toHaveLength(3);
    expect(body).toContain('<Hangup />');
  });
});
