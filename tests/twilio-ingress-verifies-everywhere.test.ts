import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// F-E07. Nine Twilio-facing webhooks are on the middleware PUBLIC allowlist, so
// the request signature is the whole authorization boundary — and each of them
// wrapped its check in `if (process.env.NODE_ENV === 'production')`, which is
// not a security decision but a fact about how the bundle was built. This file
// tests the gate that replaced all nine.
//
// Two properties, and the second is the one a source grep cannot see:
//   1. an unverifiable callback is REFUSED, never waved through;
//   2. the only way to skip is to say so out loud.
//
// `lib/guardian/twilio.ts` captures TWILIO_AUTH_TOKEN at module load, so every
// case resets modules and imports fresh — stubbing the env after the import
// would test the previous case's token.

const TOKEN = 'twilio-test-auth-token';
const PATH = '/api/guardian/inbound/sms';

async function ingress() {
  return import('@/lib/server/twilio-ingress');
}

/** What Twilio puts in x-twilio-signature: base64 HMAC-SHA1 over url + sorted params. */
function sign(url: string, params: Record<string, string>, token = TOKEN): string {
  const body = Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha1', token).update(url + body).digest('base64');
}

function request(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://internal.invalid${path}`, { headers });
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('the URL a Twilio signature is checked against', () => {
  it('is the one the platform says it received, with the configured one behind it', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://configured.test');
    const { twilioSignedUrlCandidates } = await ingress();
    const urls = twilioSignedUrlCandidates(request(PATH, {
      'x-forwarded-proto': 'https', 'x-forwarded-host': 'www.bubaly.test',
    }));
    expect(urls).toEqual([`https://www.bubaly.test${PATH}`, `https://configured.test${PATH}`]);
  });

  it('strips a trailing slash — the single character that 401s every inbound call', async () => {
    // Six of the nine routes built `${NEXT_PUBLIC_APP_URL}/api/...` with no
    // strip at all, so one slash in that variable produced `https://host//api/…`
    // and a signature that can never match: Guardian silently dead, wearing a
    // provider-problem shape.
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://configured.test///');
    const { twilioSignedUrlCandidates } = await ingress();
    const urls = twilioSignedUrlCandidates(request(PATH));
    expect(urls).toContain(`https://configured.test${PATH}`);
    expect(urls.some((u) => u.includes('//api/'))).toBe(false);
  });

  it('keeps the query string, which Twilio signs too', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://configured.test');
    const { twilioSignedUrlCandidates } = await ingress();
    expect(twilioSignedUrlCandidates(request('/api/guardian/screen?sessionId=CA1&turn=2')))
      .toEqual(['https://configured.test/api/guardian/screen?sessionId=CA1&turn=2']);
  });

  it('falls back to Host, takes the first forwarded hop, and never repeats a candidate', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://one.test');
    const { twilioSignedUrlCandidates } = await ingress();
    expect(twilioSignedUrlCandidates(request(PATH, { host: 'one.test' })))
      .toEqual([`https://one.test${PATH}`]);
    expect(twilioSignedUrlCandidates(request(PATH, {
      'x-forwarded-proto': 'https,http', 'x-forwarded-host': 'first.test,second.test',
    }))).toEqual([`https://first.test${PATH}`, `https://one.test${PATH}`]);
  });

  it('offers nothing rather than a half-built URL when neither source is present', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    const { twilioSignedUrlCandidates } = await ingress();
    expect(twilioSignedUrlCandidates(request(PATH))).toEqual([]);
  });
});

describe('verifying a Twilio-facing request', () => {
  it('accepts a signature computed for the forwarded host', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://configured.test');
    const { verifyTwilioRequest } = await ingress();
    const params = { From: '+15555550100', Body: 'hello' };
    const req = request(PATH, {
      'x-forwarded-proto': 'https', 'x-forwarded-host': 'www.bubaly.test',
      'x-twilio-signature': sign(`https://www.bubaly.test${PATH}`, params),
    });
    expect(verifyTwilioRequest(req, params, 'test')).toEqual({ ok: true, via: 'signature' });
  });

  it('accepts a signature computed for the configured URL when the proxy says otherwise', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://configured.test');
    const { verifyTwilioRequest } = await ingress();
    const params = { From: '+15555550100' };
    const req = request(PATH, {
      'x-forwarded-host': 'something.else.test',
      'x-twilio-signature': sign(`https://configured.test${PATH}`, params),
    });
    expect(verifyTwilioRequest(req, params, 'test').ok).toBe(true);
  });

  it('refuses a signature for a host nobody claims, and says which URLs it tried', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://configured.test');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { verifyTwilioRequest } = await ingress();
    const params = { From: '+15555550100' };
    const req = request(PATH, { 'x-twilio-signature': sign(`https://attacker.test${PATH}`, params) });
    const verdict = verifyTwilioRequest(req, params, 'guardian/inbound/sms');
    expect(verdict).toMatchObject({ ok: false, status: 401, reason: 'bad_signature' });
    // A hostname mismatch must not read as a bad signature to whoever is paged.
    expect(warn.mock.calls[0]?.[0]).toContain(`https://configured.test${PATH}`);
  });

  it('refuses a body altered after signing', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://configured.test');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { verifyTwilioRequest } = await ingress();
    const signature = sign(`https://configured.test${PATH}`, { From: '+15555550100', Body: 'hello' });
    const req = request(PATH, { 'x-twilio-signature': signature });
    expect(verifyTwilioRequest(req, { From: '+15555550100', Body: 'transfer everything' }, 'test').ok).toBe(false);
  });

  it('refuses a missing signature rather than treating absence as agreement', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://configured.test');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { verifyTwilioRequest } = await ingress();
    expect(verifyTwilioRequest(request(PATH), { From: '+1' }, 'test')).toMatchObject({ ok: false, status: 401 });
  });
});

describe('an unverifiable callback', () => {
  it('is refused, not admitted, when no auth token is configured', async () => {
    // The SEC-009 shape: a signature check that passes because there is nothing
    // to check against. 503 says "this deployment cannot verify you" — which is
    // true, and is not an invitation.
    vi.stubEnv('TWILIO_AUTH_TOKEN', '');
    vi.stubEnv('ALLOW_UNSIGNED_TWILIO_WEBHOOKS', '');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { verifyTwilioRequest } = await ingress();
    expect(verifyTwilioRequest(request(PATH), {}, 'guardian/inbound/sms'))
      .toEqual({ ok: false, status: 503, reason: 'not_configured', tried: [] });
    expect(error).toHaveBeenCalled();
  });

  it('is admitted only when a deliberate, named opt-out says so', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', '');
    vi.stubEnv('ALLOW_UNSIGNED_TWILIO_WEBHOOKS', '1');
    const { verifyTwilioRequest } = await ingress();
    expect(verifyTwilioRequest(request(PATH), {}, 'test')).toEqual({ ok: true, via: 'unsigned_opt_out' });
  });

  it('is not admitted by the opt-out once a token exists — the opt-out cannot disable a real check', async () => {
    // Otherwise the bypass would be a way to turn verification OFF in a
    // deployment that can verify, which is the defect in a new costume.
    vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
    vi.stubEnv('ALLOW_UNSIGNED_TWILIO_WEBHOOKS', '1');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://configured.test');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { verifyTwilioRequest } = await ingress();
    expect(verifyTwilioRequest(request(PATH), { From: '+1' }, 'test')).toMatchObject({ ok: false, status: 401 });
  });

  it('does not consult NODE_ENV at all', async () => {
    // The whole point: what the gate decides must not depend on how the bundle
    // was built. Same inputs, both build modes, same answer.
    vi.stubEnv('TWILIO_AUTH_TOKEN', '');
    vi.stubEnv('ALLOW_UNSIGNED_TWILIO_WEBHOOKS', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const mode of ['production', 'development', 'test'] as const) {
      vi.resetModules();
      vi.stubEnv('NODE_ENV', mode);
      const { verifyTwilioRequest } = await ingress();
      expect(verifyTwilioRequest(request(PATH), {}, 'test'), mode)
        .toMatchObject({ ok: false, status: 503, reason: 'not_configured' });
    }
  });
});
