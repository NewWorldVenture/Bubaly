import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appBaseUrl, APP_URL_FALLBACK } from '@/lib/server/app-url';

/**
 * Twilio signs the URL it called. We verify by rebuilding that URL ourselves.
 * So the only thing that matters is whether the two strings are identical — and
 * until now they were built by five different expressions, two of which faced
 * each other across the HMAC.
 *
 *   lib/contact-center/server.ts  told Twilio where to call, with a fallback
 *   app/api/contact-center/*      checked what Twilio signed, with no fallback
 *
 * Those two disagree ONLY when NEXT_PUBLIC_APP_URL is unset — and then the
 * registration names a real URL while the verification computes its digest over
 * a relative path. Twilio calls, the digests differ, the route answers 401, and
 * the call is rejected. Nothing logs a configuration problem, because from each
 * side's point of view nothing is wrong.
 *
 * The seven guardian routes had the third spelling, `NEXT_PUBLIC_APP_URL ?? ''`,
 * with no fallback AND no trailing-slash strip — the least defended of the five,
 * on the child-safety surface.
 *
 * tests/public-webhook-signature-boundary.test.ts already asserts every one of
 * those routes CALLS validateTwilioSignature and rejects. It is a good guard and
 * it cannot see this: presence of the check says nothing about whether the URL
 * handed to it is the one that was signed.
 */

// How Twilio signs: HMAC-SHA1 over the full URL followed by the POST parameters
// sorted by key and concatenated. Recomputed here rather than imported so this
// test proves the arithmetic without depending on module-load-time env.
function twilioSignature(token: string, url: string, params: Record<string, string>): string {
  const body = Object.keys(params).sort().map((k) => `${k}${params[k] ?? ''}`).join('');
  return createHmac('sha1', token).update(url + body).digest('base64');
}

const TOKEN = 'an-auth-token-only-this-test-knows';
const PARAMS = { From: '+15551234567', To: '+15559876543', Body: 'hello' };

// The three superseded expressions, written as functions of the environment
// variable so this file can demonstrate that they disagree. Taking a parameter
// is not cosmetic: spelled inline against a literal, TypeScript folds
// `'' || fallback` and `value ?? ''` at compile time and reports the dead
// branch (TS2873/TS2869), which is the compiler making exactly this file's
// point one level up.
const wasRegisteredAs = (env: string | undefined) => (env || APP_URL_FALLBACK).replace(/\/$/, '');
const wasVerifiedAs = (env: string | undefined) => (env ?? '').replace(/\/$/, '');
const wasGuardianSpelling = (env: string | undefined) => env ?? '';

describe('appBaseUrl', () => {
  it('never returns a value that ends in a slash', () => {
    for (const raw of [
      'https://www.bubaly.com/',
      'https://www.bubaly.com//',
      'https://www.bubaly.com///',
      '  https://www.bubaly.com/  ',
      '"https://www.bubaly.com/"',
    ]) {
      expect(appBaseUrl(raw), `raw: ${JSON.stringify(raw)}`).toBe('https://www.bubaly.com');
    }
  });

  it('leaves a well-formed value alone', () => {
    expect(appBaseUrl('https://www.bubaly.com')).toBe('https://www.bubaly.com');
    expect(appBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
    // A base URL with a path is legitimate and must keep its path.
    expect(appBaseUrl('https://example.test/app/')).toBe('https://example.test/app');
  });

  it('falls back rather than returning something relative', () => {
    // This is the property that matters. A relative fragment does not fail
    // loudly — it fails an HMAC comparison, which looks like a forged request.
    for (const raw of [undefined, '', '   ', '/', '//', 'https://', 'not-a-url', '""']) {
      expect(appBaseUrl(raw), `raw: ${JSON.stringify(raw)}`).toBe(APP_URL_FALLBACK);
    }
  });
});

describe('a signed URL is the URL that was signed', () => {
  it('the registration side and the verification side agree when the env is unset', () => {
    // Both sides now derive from the same function, so "unset" resolves to the
    // same absolute URL on both. Calibration: with the old pair of expressions
    // — `(x || fallback).replace(...)` registering and `(x ?? '').replace(...)`
    // verifying — these two digests differ, which is the defect.
    const registered = `${appBaseUrl(undefined)}/api/contact-center/voice`;
    const verified = `${appBaseUrl(undefined)}/api/contact-center/voice`;

    const unset: string | undefined = undefined;
    const old_registered = `${wasRegisteredAs(unset)}/api/contact-center/voice`;
    const old_verified = `${wasVerifiedAs(unset)}/api/contact-center/voice`;

    expect(twilioSignature(TOKEN, registered, PARAMS)).toBe(twilioSignature(TOKEN, verified, PARAMS));
    expect(
      twilioSignature(TOKEN, old_registered, PARAMS),
      'the old pair of expressions agreed, so this test would prove nothing',
    ).not.toBe(twilioSignature(TOKEN, old_verified, PARAMS));
  });

  it('a trailing slash in the environment does not change the digest', () => {
    // What Twilio actually called and signed.
    const called = 'https://www.bubaly.com/api/guardian/inbound/sms';
    const signed = twilioSignature(TOKEN, called, PARAMS);

    for (const raw of ['https://www.bubaly.com', 'https://www.bubaly.com/', 'https://www.bubaly.com//']) {
      const rebuilt = `${appBaseUrl(raw)}/api/guardian/inbound/sms`;
      expect(twilioSignature(TOKEN, rebuilt, PARAMS), `raw: ${raw}`).toBe(signed);
    }

    // Calibration: the guardian routes' old spelling, `NEXT_PUBLIC_APP_URL ?? ''`,
    // fails this for the same input — which is the whole finding.
    const withSlash: string | undefined = 'https://www.bubaly.com/';
    const old_rebuilt = `${wasGuardianSpelling(withSlash)}/api/guardian/inbound/sms`;
    expect(
      twilioSignature(TOKEN, old_rebuilt, PARAMS),
      'the old guardian spelling already matched, so this test would prove nothing',
    ).not.toBe(signed);
  });
});

/**
 * The ratchet. Every file that either REGISTERS a webhook URL with a provider or
 * VERIFIES a provider signature against one must take its base from appBaseUrl(),
 * because those two strings are compared by HMAC and a private spelling is how
 * they drift apart.
 *
 * Scoped to the signature path on purpose rather than to every reader of
 * NEXT_PUBLIC_APP_URL. Elsewhere — a Stripe return URL, an email link — a
 * malformed base produces a visibly bad link, and a guard that swept those too
 * would be making a security assertion about things that are not security.
 * lib/google.ts is deliberately excluded and stays as it is: it has its own
 * GOOGLE_CALENDAR_REDIRECT_URI override and falls back to the REQUEST origin,
 * which is correct for OAuth and is not what this helper does.
 */
const SIGNATURE_PATH = [
  'app/api/guardian/escalate/route.ts',
  'app/api/guardian/escalate/twiml/route.ts',
  'app/api/guardian/inbound/voice/route.ts',
  'app/api/guardian/inbound/sms/route.ts',
  'app/api/guardian/inbound/whatsapp/route.ts',
  'app/api/guardian/screen/route.ts',
  'app/api/guardian/status/voicemail/route.ts',
  'app/api/contact-center/voice/route.ts',
  'app/api/contact-center/voice/transcription/route.ts',
  'app/api/contact-center/sms/route.ts',
  'lib/contact-center/server.ts',
];

describe('the signature path has one spelling of the base URL', () => {
  it('covers both sides: the routes that verify and the module that registers', () => {
    // Non-vacuity for the list itself. If a refactor moved registration out of
    // lib/contact-center/server.ts, this list would be asserting over verifiers
    // only and would no longer be checking that the two sides agree.
    expect(SIGNATURE_PATH).toContain('lib/contact-center/server.ts');
    expect(SIGNATURE_PATH.filter((f) => f.includes('/api/'))).toHaveLength(10);
  });

  it('no file on it derives the base URL for itself', () => {
    const offenders: string[] = [];
    for (const file of SIGNATURE_PATH) {
      const source = readFileSync(file, 'utf8');
      // Reading the variable outside a comment is the offence; the fix is to
      // call appBaseUrl() instead.
      const code = source
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      if (code.includes('NEXT_PUBLIC_APP_URL')) offenders.push(file);
    }
    expect(
      offenders,
      'these build a webhook URL from the environment themselves. Twilio signs the '
      + 'URL it called and these strings are compared by HMAC, so a private spelling '
      + 'is a 401 on every inbound call. Use appBaseUrl() from lib/server/app-url.ts:\n'
      + offenders.map((f) => `  ${f}`).join('\n'),
    ).toEqual([]);
  });

  it('each of them actually calls appBaseUrl', () => {
    // The other half: absence of NEXT_PUBLIC_APP_URL is not the same as using
    // the shared helper. A file could hardcode a host and pass this otherwise.
    const missing = SIGNATURE_PATH.filter((f) => !readFileSync(f, 'utf8').includes('appBaseUrl('));
    expect(missing, `no appBaseUrl() call in: ${missing.join(', ')}`).toEqual([]);
  });
});
