import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireMarketingAdmin, logMarketingAudit, isMarketingAuthError, marketingRefusalBody } from '@/lib/marketing/admin';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { sendEmailCampaign, campaignAudience, CampaignSendError, MAX_RECIPIENTS } from '@/lib/marketing/send';

export const runtime = 'nodejs';

// GET ?id= → recipient preview count (no send). POST { id } → real send.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  try {
    const { supabase } = await requireMarketingAdmin();
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: t('send.missingId') }, { status: 400 });
    const { data: c, error: campaignError } = await supabase.from('marketing_email_campaigns')
      .select('segment_id, metadata').eq('id', id).is('deleted_at', null).maybeSingle();
    if (campaignError) {
      console.error('[admin-marketing-email] recipient preview read failed', campaignError);
      return NextResponse.json({ error: t('send.couldNotLoadCampaignRecipients') }, { status: 500 });
    }
    if (!c) return NextResponse.json({ error: t('send.notFound') }, { status: 404 });
    // The count a send would mail NOW: the audience less whoever an earlier,
    // stopped attempt already reached — the number the confirm dialog asks about.
    const { remaining, alreadySent } = await campaignAudience(supabase, c);
    // Past the cap the send refuses, so the preview says so instead of a count:
    // it used to answer the capped 1,000 as if that were the whole audience.
    if (remaining.length > MAX_RECIPIENTS) {
      return NextResponse.json({ error: t('send.audienceOverCap', { n: remaining.length, cap: MAX_RECIPIENTS }), recipients: remaining.length }, { status: 409 });
    }
    return NextResponse.json({ recipients: remaining.length, alreadySent });
  } catch (err) {
    // The status rides on the error now, rather than being recovered by reading
    // the refusal's own sentence back — reword the sentence and this kept
    // compiling while answering 502 to a non-admin.
    if (isMarketingAuthError(err)) return NextResponse.json({ error: marketingRefusalBody(err) }, { status: err.status });
    console.error('[admin-marketing-email] recipient preview failed', err);
    return NextResponse.json({ error: t('send.couldNotLoadCampaignRecipients') }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  let admin: Awaited<ReturnType<typeof requireMarketingAdmin>> | null = null;
  let id: string | undefined;
  try {
    admin = await requireMarketingAdmin();
    const { supabase, actorId, actorEmail } = admin;
    const boundedBody = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Invalid request body' }, { status: 400 });
    ({ id } = (boundedBody.value ?? {}) as { id?: string });
    if (!id) return NextResponse.json({ error: t('send.missingId') }, { status: 400 });

    const { sent } = await sendEmailCampaign(supabase, id);
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'send', resource: 'marketing_email_campaign', resourceId: id, metadata: { sent, outcome: 'complete' } });
    return NextResponse.json({ sent });
  } catch (err) {
    if (isMarketingAuthError(err)) return NextResponse.json({ error: marketingRefusalBody(err) }, { status: err.status });
    console.error('Marketing email send failed:', err);
    if (err instanceof CampaignSendError) {
      if (err.code === 'over_cap') {
        return NextResponse.json({ error: t('send.audienceOverCap', { n: err.audience, cap: MAX_RECIPIENTS }) }, { status: 409 });
      }
      // A send that stopped after it began is on the audit log too, with what
      // went out: it used to reach the log only when every batch was accepted.
      if (admin && id) {
        await logMarketingAudit(admin.supabase, {
          actorId: admin.actorId, actorEmail: admin.actorEmail, action: 'send', resource: 'marketing_email_campaign', resourceId: id,
          metadata: { sent: err.sent, delivered: err.total, outcome: err.code },
        });
      }
      // Part of the audience has it: say how much, and that sending again
      // resumes (sendEmailCampaign skips every address already delivered).
      if (err.total > 0 && err.code !== 'state_unrecorded') {
        const audience = err.total - err.sent + err.audience;
        return NextResponse.json({ error: t('send.stoppedPartway', { sent: err.total, total: audience }), sent: err.sent }, { status: 502 });
      }
      return NextResponse.json({ error: 'The email provider rejected the campaign.' }, { status: 502 });
    }
    // The provider branch still reads the message for the errors that are not
    // a CampaignSendError (no provider key configured): it decides a status and
    // never crosses into the response, and it decides no authorization outcome.
    const message = err instanceof Error ? err.message : '';
    const providerFailure = message.includes('Provider') || message.includes('provider') || message.includes('delivery state');
    return NextResponse.json({
      error: providerFailure ? 'The email provider rejected the campaign.' : 'Could not send campaign.',
    }, { status: providerFailure ? 502 : 400 });
  }
}
