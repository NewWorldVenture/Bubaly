import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import {
  recordConsentEvents, getConsentState, toConsentCategory,
  isValidConsentMap, type ConsentCategory, type ConsentDecision,
} from '@/lib/marketing/consent';
import { carriedVisitorId, namesAnotherVisitor } from '@/lib/marketing/visitor-cookie';
import { rateLimit, clientIp } from '@/lib/server/rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';

export const runtime = 'nodejs';

// Public first-party consent write path for the cookie banner / preference
// center. The visitor sends a map of category → boolean; each is appended as an
// immutable, timestamped, versioned decision against THE VISITOR THIS BROWSER
// IS, and the resolved current state comes back. Service-role — mkt_consent_events
// has RLS on and no policies, so this route is the only door to the table.
//
// Whose ledger is read or written comes from the `bubaly_vid` cookie the request
// already carries, never from a parameter the caller chooses (SEC-006). Both
// handlers used to take the id from the caller — GET from the query string, POST
// from the body — so a request could name any visitor and get that visitor's
// choices back; POST could also append decisions to someone else's ledger, and a
// POST of `{ necessary: true }` read their full state while appending only an
// inert row.
//
// What this does NOT add, stated plainly: the id is a random bearer value, and
// the cookie is the same bytes. Anyone who already holds a visitor's id can
// present it as a cookie. What the binding removes is a caller CHOOSING a record
// other than the one its own browser carries, and the id travelling in a URL
// (access logs, history), which the query-string GET invited.
//
// A request that still names an id (older cached clients send it in the body)
// is accepted only when that id IS the cookie; naming anyone else is refused
// rather than silently re-targeted, so a mismatch is visible, not absorbed.
// The binding lives in lib/marketing/visitor-cookie.ts, shared with
// /api/mkt/track (SEC-007), which had the same caller-chosen-id shape.

type ConsentBody = {
  anonymousId?: string;
  consents?: Record<string, boolean>;
  source?: string | null;
  gpc?: boolean;
};

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  const limited = await enforceRequestRateLimit(createServiceClient(), `consent:post:${clientIp(req.headers)}`, { limit: 30, windowMs: 60_000 });
  if (!limited.ok) return NextResponse.json(
    { error: t('consent.tooManyConsentUpdatesPlease') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const boundedBody = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Bad payload' }, { status: 400 });
  const value = boundedBody.value;
  const body = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as ConsentBody;

  const anonymousId = carriedVisitorId(req);
  if (!anonymousId) return NextResponse.json({ error: t('consent.visitorCookieRequired') }, { status: 400 });
  if (namesAnotherVisitor(body.anonymousId, anonymousId)) {
    return NextResponse.json({ error: t('consent.notThisVisitor') }, { status: 403 });
  }

  if (!isValidConsentMap(body.consents)) {
    return NextResponse.json({ error: t('consent.invalidConsentMap') }, { status: 400 });
  }

  const decisions: Partial<Record<ConsentCategory, ConsentDecision>> = {};
  for (const [rawKey, rawVal] of Object.entries(body.consents)) {
    const category = toConsentCategory(rawKey);
    if (category) decisions[category] = rawVal ? 'granted' : 'denied';
  }
  if (Object.keys(decisions).length === 0) {
    return NextResponse.json({ error: t('consent.noValidConsentCategories') }, { status: 400 });
  }

  const source = typeof body.source === 'string' ? body.source.trim().slice(0, 60) || 'banner' : 'banner';
  const gpc = body.gpc === true;
  const userAgent = req.headers.get('user-agent')?.slice(0, 300) ?? null;

  const supabase = createServiceClient();
  try {
    await recordConsentEvents(supabase, { anonymousId, decisions, source, gpc, userAgent });
    const state = await getConsentState(supabase, anonymousId, { gpc });
    return NextResponse.json({ ok: true, state });
  } catch (error) {
    console.error('[mkt-consent] consent persistence failed', error);
    return NextResponse.json({ error: t('consent.consentIsTemporarilyUnavailablePlease') }, { status: 503 });
  }
}

// Read the current consent state (for hydrating the banner/preference center).
// Nothing in the app calls this today — the banner hydrates from its local cache
// and reconciles from the POST's answer — and it reads the carried cookie only.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  const limited = await enforceRequestRateLimit(createServiceClient(), `consent:get:${clientIp(req.headers)}`, { limit: 60, windowMs: 60_000 });
  if (!limited.ok) return NextResponse.json(
    { error: t('consent.tooManyConsentRequestsPlease') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const params = new URL(req.url).searchParams;
  const anonymousId = carriedVisitorId(req);
  if (!anonymousId) return NextResponse.json({ error: t('consent.visitorCookieRequired') }, { status: 400 });
  if (namesAnotherVisitor(params.get('anonymousId'), anonymousId)) {
    return NextResponse.json({ error: t('consent.notThisVisitor') }, { status: 403 });
  }
  const gpc = params.get('gpc') === '1';
  const supabase = createServiceClient();
  try {
    const state = await getConsentState(supabase, anonymousId, { gpc });
    return NextResponse.json({ ok: true, state });
  } catch (error) {
    console.error('[mkt-consent] consent read failed', error);
    return NextResponse.json({ error: t('consent.consentIsTemporarilyUnavailablePlease') }, { status: 503 });
  }
}
