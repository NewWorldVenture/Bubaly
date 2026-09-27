import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireMarketingAdmin, logMarketingAudit, isMarketingAuthorizationError } from '@/lib/marketing/admin';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { sendEmailCampaign, resolveRecipients } from '@/lib/marketing/send';

export const runtime = 'nodejs';

// GET ?id= → recipient preview count (no send). POST { id } → real send.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  try {
    const { supabase } = await requireMarketingAdmin();
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: t('send.missingId') }, { status: 400 });
    const { data: c, error: campaignError } = await supabase.from('marketing_email_campaigns')
      .select('segment_id').eq('id', id).is('deleted_at', null).maybeSingle();
    if (campaignError) {
      console.error('[admin-marketing-email] recipient preview read failed', campaignError);
      return NextResponse.json({ error: t('send.couldNotLoadCampaignRecipients') }, { status: 500 });
    }
    if (!c) return NextResponse.json({ error: t('send.notFound') }, { status: 404 });
    const recipients = await resolveRecipients(supabase, c);
    return NextResponse.json({ recipients: recipients.length });
  } catch (err) {
    if (isMarketingAuthorizationError(err)) {
      const refused = 'Forbidden';
      return NextResponse.json({ error: refused }, { status: err.reason === 'unauthenticated' ? 401 : 403 });
    }
    console.error('[admin-marketing-email] recipient preview failed', err);
    return NextResponse.json({ error: t('send.couldNotLoadCampaignRecipients') }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  try {
    const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
    const boundedBody = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Invalid request body' }, { status: 400 });
    const { id } = (boundedBody.value ?? {}) as { id?: string };
    if (!id) return NextResponse.json({ error: t('send.missingId') }, { status: 400 });

    const { sent } = await sendEmailCampaign(supabase, id);
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'send', resource: 'marketing_email_campaign', resourceId: id, metadata: { sent } });
    return NextResponse.json({ sent });
  } catch (err) {
    if (isMarketingAuthorizationError(err)) {
      const refused = 'Forbidden';
      return NextResponse.json({ error: refused }, { status: err.reason === 'unauthenticated' ? 401 : 403 });
    }
    console.error('Marketing email send failed:', err);
    // The provider branch still reads the message, because a provider failure
    // arrives as whatever the SDK threw and has no type of ours to carry.
    const message = err instanceof Error ? err.message : '';
    const providerFailure = message.includes('Provider') || message.includes('provider') || message.includes('delivery state');
    const failureMessage = providerFailure ? 'The email provider rejected the campaign.' : 'Could not send campaign.';
    return NextResponse.json({ error: failureMessage }, { status: providerFailure ? 502 : 400 });
  }
}
