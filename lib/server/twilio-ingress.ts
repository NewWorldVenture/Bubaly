// lib/server/twilio-ingress.ts — the one gate on every Twilio-facing webhook.
//
// These routes are on the middleware PUBLIC allowlist: the caller is Twilio,
// not a signed-in person, so the request signature is the entire authorization
// boundary. Nine routes each carried their own copy of the check, and the nine
// copies shared two defects (F-E07).
//
// 1. Every copy was wrapped in `if (process.env.NODE_ENV === 'production')`.
//    Next.js inlines NODE_ENV at build time, so a `next build` artifact does
//    verify — but any deployment that runs without that (a self-hosted server
//    started with NODE_ENV unset or set to something else) served nine
//    unauthenticated endpoints that write guardian rows, trigger scam
//    detection, notify families and fan out SMS and voice calls. The
//    environment a build happens to run in is not a security decision. So the
//    condition is gone: the question asked here is whether this deployment
//    holds the secret, which is the honest one, and the only way to skip is to
//    set ALLOW_UNSIGNED_TWILIO_WEBHOOKS=1 on purpose — a named, greppable act
//    by an operator rather than a property of the build. With no token and no
//    opt-out the answer is 503, never "come in".
//
// 2. Every copy rebuilt the signed URL from `NEXT_PUBLIC_APP_URL`, a constant
//    an operator has to keep byte-identical to whatever is typed into the
//    Twilio console. Twilio signs the exact absolute URL it requested, so a
//    single trailing slash in that variable yields `https://host//api/...` and
//    a signature that can never match — six of the nine concatenated it with
//    no trailing-slash strip at all, one stripped one slash, one stripped all
//    of them. The symptom is every inbound call and message 401ing for as long
//    as it stays set: Guardian and the Contact Center silently dead, wearing a
//    provider-problem shape. Here the URL is taken from what the platform says
//    it received, with the configured value offered as a second candidate.
import { NextResponse, type NextRequest } from 'next/server';
import { twilioSignatureConfigured, validateTwilioSignature } from '@/lib/guardian/twilio';

export type TwilioIngressVerdict =
  | { ok: true; via: 'signature' | 'unsigned_opt_out' }
  | { ok: false; status: 401 | 503; reason: 'bad_signature' | 'not_configured'; tried: string[] };

function normalizeBase(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

/** First entry of a possibly comma-joined forwarded header. */
function firstHop(value: string | null): string {
  return (value ?? '').split(',')[0].trim();
}

/**
 * The absolute URLs Twilio may have signed, most likely first.
 *
 * Offering two candidates widens nothing. Each is still checked by a full
 * HMAC-SHA1 under TWILIO_AUTH_TOKEN, so a forger who could satisfy either
 * already holds the token — at which point the host name is the least of it.
 * What it buys is that a deployment reached through a proxy, or one whose
 * NEXT_PUBLIC_APP_URL drifted from the Twilio console by a slash or a `www.`,
 * keeps working instead of rejecting every real call.
 *
 * Path AND query: Twilio signs the full URL, and `/api/guardian/screen` and
 * the voicemail status callback both carry query parameters that the ingress
 * routes' hand-built strings used to include or omit inconsistently.
 */
export function twilioSignedUrlCandidates(req: NextRequest): string[] {
  const pathAndQuery = `${req.nextUrl.pathname}${req.nextUrl.search}`;
  const out: string[] = [];
  const add = (base: string | undefined) => {
    const b = normalizeBase(base);
    if (!b) return;
    const url = `${b}${pathAndQuery}`;
    if (!out.includes(url)) out.push(url);
  };

  const host = firstHop(req.headers.get('x-forwarded-host')) || firstHop(req.headers.get('host'));
  if (host) add(`${firstHop(req.headers.get('x-forwarded-proto')) || 'https'}://${host}`);
  add(process.env.NEXT_PUBLIC_APP_URL);
  return out;
}

/**
 * Decide whether a Twilio-facing request may proceed.
 *
 * `label` names the route in the log line, because the two failures need
 * telling apart by whoever is paged: a signature that does not match any
 * candidate URL is a configuration mismatch and says which URLs were tried, so
 * it stops looking like a bad signature and starts looking like the hostname
 * problem it usually is.
 */
export function verifyTwilioRequest(
  req: NextRequest,
  params: Record<string, string>,
  label: string,
): TwilioIngressVerdict {
  if (!twilioSignatureConfigured()) {
    if (process.env.ALLOW_UNSIGNED_TWILIO_WEBHOOKS === '1') return { ok: true, via: 'unsigned_opt_out' };
    console.error(`[twilio ingress] ${label}: TWILIO_AUTH_TOKEN is not set, so no callback can be verified. Refusing.`);
    return { ok: false, status: 503, reason: 'not_configured', tried: [] };
  }

  const signature = req.headers.get('x-twilio-signature') ?? '';
  const tried = twilioSignedUrlCandidates(req);
  for (const url of tried) {
    if (validateTwilioSignature(signature, url, params)) return { ok: true, via: 'signature' };
  }
  console.warn(
    `[twilio ingress] ${label}: signature matched none of the URLs this deployment believes it was called at` +
    ` — ${tried.length ? tried.join(' , ') : '(no forwarded host and NEXT_PUBLIC_APP_URL unset)'}.` +
    ' If Twilio is configured with a different hostname, that is the mismatch.',
  );
  return { ok: false, status: 401, reason: 'bad_signature', tried };
}

/**
 * The response a refused Twilio request gets.
 *
 * One body, here, rather than eight hand-written ones across the routes: the
 * consumer is Twilio, which reads the status and ignores the text, and the
 * route that refused is already named in the log line above. Keeping the
 * strings out of `app/` also keeps them off the ungated i18n surface, where
 * they would be counted as untranslated copy that no person will ever read.
 */
export function twilioRefusal(verdict: Extract<TwilioIngressVerdict, { ok: false }>): NextResponse {
  return new NextResponse(
    verdict.reason === 'not_configured' ? 'Twilio callbacks are not configured here' : 'Unauthorized',
    { status: verdict.status },
  );
}
