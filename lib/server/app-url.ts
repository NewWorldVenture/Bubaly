// lib/server/app-url.ts — ONE spelling of "this app's public base URL".
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// There were five, and two of them faced each other across an HMAC.
//
//   lib/contact-center/server.ts  (NEXT_PUBLIC_APP_URL || 'https://www.bubaly.com').replace(/\/$/, '')
//   app/api/contact-center/*      (NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '')
//   app/api/guardian/*   (×7)      NEXT_PUBLIC_APP_URL ?? ''
//   lib/email.ts                   NEXT_PUBLIC_APP_URL ?? NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com'
//   lib/google.ts                  override ?? validated NEXT_PUBLIC_APP_URL ?? request origin, /\/+$/
//
// For an email link or an OAuth redirect, a malformed base URL produces a bad
// link: visible, and someone files a bug. For a Twilio webhook it produces
// something quieter. Twilio signs the EXACT URL it called, HMAC-SHA1 over
// `url + sortedParams`; `validateTwilioSignature` recomputes that HMAC from a
// URL we build ourselves. One character of difference and the digests diverge,
// the route answers 401, and the inbound call or message is rejected — for
// every family, with nothing in the product saying so.
//
// Measured, not asserted. Both of these produce different digests for the same
// request:
//
//   NEXT_PUBLIC_APP_URL unset
//     registered with Twilio  https://www.bubaly.com/api/contact-center/voice   (the || fallback)
//     verified against        /api/contact-center/voice                          (the ?? '' spelling)
//
//   NEXT_PUBLIC_APP_URL = "https://www.bubaly.com/"   (one trailing slash)
//     guardian builds         https://www.bubaly.com//api/guardian/inbound/sms
//     Twilio called + signed   https://www.bubaly.com/api/guardian/inbound/sms
//
// The first is the sharper of the two, because the two expressions disagree
// ONLY in their fallback: the side that tells Twilio where to call has one and
// the side that checks what Twilio signed does not. The registration silently
// succeeds against a real URL and the verification silently rejects it.
//
// A trailing slash is not exotic either. lib/supabase/server.ts already carries
// a note that a credential pasted into a dashboard "picks up a trailing newline
// or a wrapping pair of quotes more often than anyone admits" — the same hazard,
// one field over, and the same treatment is applied here.
//
// ── The contract ────────────────────────────────────────────────────────────
//
// Returns an absolute `http(s)://…` origin with NO trailing slash, so that
// `${appBaseUrl()}/api/whatever` is well-formed for both signing and
// registering. Anything that is not a usable absolute URL — empty, unset,
// whitespace, quoted, `https://` alone — becomes the fallback rather than a
// relative fragment, because a relative fragment is what silently fails an HMAC
// comparison instead of failing loudly.

/** Used when the environment does not name a usable absolute URL. */
export const APP_URL_FALLBACK = 'https://www.bubaly.com';

/**
 * This app's public base URL: absolute, and never ending in `/`.
 *
 * `raw` is a parameter so callers with their own precedence chain keep it —
 * lib/email.ts falls back to NEXT_PUBLIC_SITE_URL before the default, and that
 * is its contract, not a bug to normalise away. What every caller shares is
 * what happens to the value ONCE CHOSEN, and that is what lives here.
 */
export function appBaseUrl(raw: string | undefined = process.env.NEXT_PUBLIC_APP_URL): string {
  const trimmed = (raw ?? '').trim();
  // Same unquoting as cleanEnv in lib/supabase/server.ts, for the same reason.
  const unquoted = /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
  // `/+$` rather than `/$`: "https://host//" is one paste away and one strip
  // would leave "https://host/", which is still wrong for concatenation.
  const stripped = unquoted.replace(/\/+$/, '');
  return /^https?:\/\/\S+$/.test(stripped) ? stripped : APP_URL_FALLBACK;
}
