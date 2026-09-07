import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import {
  recordConsentEvents, getConsentState, toConsentCategory,
  isValidConsentMap, type ConsentCategory, type ConsentDecision,
} from '@/lib/marketing/consent';
import { rateLimit, clientIp } from '@/lib/server/rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';

// Public first-party consent write path for the cookie banner / preference
// center. The visitor supplies their anonymous id and a map of category →
// boolean; each is appended as an immutable, timestamped, versioned decision.
// Returns the resolved current state. Service-role — only writes consent rows
// keyed by the anonymous id.
type ConsentBody = {
  anonymousId?: string;
  consents?: Record<string, boolean>;
  source?: string | null;
  gpc?: boolean;
};

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  const limited = rateLimit(`consent:post:${clientIp(req.headers)}`, { limit: 30, windowMs: 60_000 });
  if (!limited.ok) return NextResponse.json(
    { error: t('consent.tooManyConsentUpdatesPlease') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const boundedBody = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Bad payload' }, { status: 400 });
  const body = boundedBody.value as ConsentBody;

  const anonymousId = typeof body.anonymousId === 'string' ? body.anonymousId.trim().slice(0, 200) : '';
  if (!anonymousId) return NextResponse.json({ error: t('consent.anonymousidRequired') }, { status: 400 });

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
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  const limited = rateLimit(`consent:get:${clientIp(req.headers)}`, { limit: 60, windowMs: 60_000 });
  if (!limited.ok) return NextResponse.json(
    { error: t('consent.tooManyConsentRequestsPlease') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const anonymousId = new URL(req.url).searchParams.get('anonymousId')?.trim().slice(0, 200) ?? '';
  if (!anonymousId) return NextResponse.json({ error: t('consent.anonymousidRequired') }, { status: 400 });
  const gpc = new URL(req.url).searchParams.get('gpc') === '1';
  const supabase = createServiceClient();
  try {
    const state = await getConsentState(supabase, anonymousId, { gpc });
    return NextResponse.json({ ok: true, state });
  } catch (error) {
    console.error('[mkt-consent] consent read failed', error);
    return NextResponse.json({ error: t('consent.consentIsTemporarilyUnavailablePlease') }, { status: 503 });
  }
}
