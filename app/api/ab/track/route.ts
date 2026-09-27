import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { hasConfiguredVariant } from '@/lib/marketing/ab';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { carriedVisitorId, namesAnotherVisitor } from '@/lib/marketing/visitor-cookie';

export const runtime = 'nodejs';
const MAX_AB_REQUEST_BYTES = 4_096;

/**
 * Public A/B event ingestion. Records an exposure or conversion for a running
 * experiment. Writes via the service-role client (ab_events has no client
 * policies). Deduped per visitor by a unique index, so double-fires are no-ops.
 *
 * WHICH visitor the event is recorded against comes from the `bubaly_vid`
 * cookie the request carries, never from the body (SEC-008). It used to take
 * `visitorId` from the body, so a caller could write an event under any id it
 * named — and because the unique index keeps the FIRST exposure/conversion per
 * (experiment, visitor), a planted row for another visitor silently dropped
 * that visitor's real one. A non-string `visitorId` (or `experiment`/`variant`)
 * also reached `.trim()` and threw, a 500 instead of a refusal.
 *
 * Same binding and stated limit as /api/mkt/consent (SEC-006) and
 * /api/mkt/track (SEC-007): the cookie is the same bearer bytes, so this stops
 * a caller naming a visitor other than the one its browser is, not a holder of
 * the id presenting it. No cookie records a visitor-less event, which the
 * partial unique index (WHERE visitor_id IS NOT NULL) has always allowed. A body
 * that still names an id is accepted only when it IS the cookie; any other is
 * refused, 403, before any experiment or event is read or written. (The per-IP
 * rate limit runs first, as on the sibling routes, so the refusal is throttled
 * too; that touches only the rate-limit counter, never ab_events.)
 */
export async function POST(req: NextRequest) {
  const t = await getTranslations();
  const ip = clientIp(req.headers);
  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `ab:${ip}`, { limit: 60 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: t('track.tooManyRequests') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
  }

  const parsedBody = await readBoundedRequestJson(req, MAX_AB_REQUEST_BYTES);
  if (!parsedBody.ok) {
    return NextResponse.json(
      { error: parsedBody.reason === 'too_large' ? 'Request body too large.' : 'Invalid body' },
      { status: parsedBody.reason === 'too_large' ? 413 : 400 },
    );
  }
  const body = (parsedBody.value && typeof parsedBody.value === 'object' ? parsedBody.value : {}) as {
    experiment?: unknown; variant?: unknown; kind?: unknown; visitorId?: unknown;
  };

  const carried = carriedVisitorId(req);
  if (namesAnotherVisitor(body.visitorId, carried)) {
    return NextResponse.json({ error: t('track.notThisVisitor') }, { status: 403 });
  }
  // Already trimmed and bounded to MAX_VISITOR_ID by the helper — the same key
  // /api/mkt/consent and /api/mkt/track store for this browser, so an A/B event
  // joins to the visitor's mkt_* profile. Deliberately NOT the blog's
  // normalizeVisitorId (8–100 chars, narrower charset): that would turn some
  // cookies the marketing layer accepts into visitor-less, un-deduped events.
  const visitorId = carried || null;

  const experiment = typeof body.experiment === 'string' ? body.experiment.trim() : '';
  const variant = typeof body.variant === 'string' ? body.variant.trim() : '';
  const kind = body.kind === 'conversion' ? 'conversion' : 'exposure';
  if (!experiment || !variant) return NextResponse.json({ error: t('track.experimentAndVariantAreRequired') }, { status: 422 });
  if (experiment.length > 100 || variant.length > 100) {
    return NextResponse.json({ error: t('track.identifierIsTooLong') }, { status: 422 });
  }

  // Only record for experiments that are actually running.
  const { data: exp } = await supabase
    .from('ab_experiments')
    .select('status, variants')
    .eq('key', experiment)
    .is('deleted_at', null)
    .maybeSingle();
  if (!exp || exp.status !== 'running') return NextResponse.json({ ok: true, recorded: false });
  if (!hasConfiguredVariant(exp.variants, variant)) {
    return NextResponse.json({ error: t('track.unknownExperimentVariant') }, { status: 422 });
  }

  // Insert; ignore unique-violation dupes (one exposure/conversion per visitor).
  const { error } = await supabase.from('ab_events').insert({ experiment_key: experiment, variant_key: variant, kind, visitor_id: visitorId });
  if (error && error.code !== '23505') {
    console.error('A/B event recording failed:', error);
    return NextResponse.json({ error: t('track.couldNotRecordTheExperiment') }, { status: 500 });
  }

  return NextResponse.json({ ok: true, recorded: true });
}
