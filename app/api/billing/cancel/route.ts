import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { getStripe } from '@/lib/stripe';
import { isAdmin } from '@/lib/constants/roles';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';

const MAX_BILLING_REQUEST_BYTES = 4_096;

export const runtime = 'nodejs';

/**
 * Schedule a downgrade to Free at period end (cancel_at_period_end = true), or
 * undo it (`{ resume: true }`). The family keeps their paid features until the
 * period ends. Family admins (parents) only. The webhook keeps Supabase in sync;
 * we also write the flag optimistically so the UI updates instantly.
 */
export async function POST(req: NextRequest) {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    if (!isAdmin(ctx.active.role)) {
      return NextResponse.json({ error: t('cancel.onlyAParentCanChange') }, { status: 403 });
    }
    const familyId = ctx.active.familyId;
    const body = await readBoundedRequestJson(req, MAX_BILLING_REQUEST_BYTES);
    if (!body.ok) {
      return NextResponse.json(
        { error: body.reason === 'too_large' ? 'Request body too large.' : 'Invalid request body.' },
        { status: body.reason === 'too_large' ? 413 : 400 },
      );
    }
    const { resume } = (body.value && typeof body.value === 'object' ? body.value : {}) as { resume?: boolean };
    if (typeof resume !== 'boolean') return NextResponse.json({ error: t('cancel.invalidCancellationRequest') }, { status: 400 });

    const supabase = await createServer();
    const { data: sub, error: subError } = await supabase
      .from('subscriptions')
      .select('provider_ref, status')
      .eq('family_id', familyId)
      .maybeSingle();
    if (subError) {
      console.error('[billing-cancel] Subscription read failed', subError);
      return NextResponse.json({ error: t('cancel.subscriptionStatusIsTemporarilyUnavailable') }, { status: 503 });
    }

    if (!sub?.provider_ref) {
      return NextResponse.json({ error: t('cancel.noActiveSubscriptionToChange') }, { status: 404 });
    }

    const cancelAtPeriodEnd = !resume;
    const limited = await enforceRequestRateLimit(supabase, `billing:cancel:${familyId}:${ctx.user.id}`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: t('cancel.tooManyBillingRequestsPlease') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
    await getStripe().subscriptions.update(sub.provider_ref, { cancel_at_period_end: cancelAtPeriodEnd });

    const { error: syncError } = await createServiceClient()
      .from('subscriptions')
      .update({ cancel_at_period_end: cancelAtPeriodEnd })
      .eq('family_id', familyId);
    if (syncError) {
      console.error('[billing-cancel] Subscription sync write failed', syncError);
      return NextResponse.json({ error: t('cancel.stripeUpdatedTheSubscriptionBut'), providerUpdated: true }, { status: 503 });
    }

    return NextResponse.json({ ok: true, cancel_at_period_end: cancelAtPeriodEnd });
  } catch (err) {
    console.error('cancel error:', err);
    return NextResponse.json({ error: t('cancel.couldNotUpdateTheSubscription') }, { status: 500 });
  }
}
