import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireMarketingAdmin, logMarketingAudit, isMarketingAuthError, marketingRefusalBody } from '@/lib/marketing/admin';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { sendEmailCampaign, campaignAudience, CampaignSendError, finishesCampaign, MAX_RECIPIENTS } from '@/lib/marketing/send';

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
    const { remaining, alreadySent, prior } = await campaignAudience(supabase, c);
    // Past the cap a send reaches the first MAX_RECIPIENTS and the next Send
    // the rest, so the preview answers both: what this send mails
    // (`recipients`) and everyone still to be reached (`audience`). It used to
    // answer the capped 1,000 as if that were the whole audience. `finishes`
    // marks a campaign that was capped or stopped partway and whose every
    // address not yet reached has left the audience: Send records it sent,
    // mailing no one (finishesCampaign).
    return NextResponse.json({
      recipients: Math.min(remaining.length, MAX_RECIPIENTS), audience: remaining.length, alreadySent,
      ...(finishesCampaign(prior, remaining) ? { finishes: true } : {}),
    });
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

    const { sent, remaining } = await sendEmailCampaign(supabase, id);
    await logMarketingAudit(supabase, {
      actorId, actorEmail, action: 'send', resource: 'marketing_email_campaign', resourceId: id,
      metadata: { sent, remaining, outcome: remaining > 0 ? 'capped' : 'complete' },
    });
    return NextResponse.json({ sent, remaining });
  } catch (err) {
    if (isMarketingAuthError(err)) return NextResponse.json({ error: marketingRefusalBody(err) }, { status: err.status });
    console.error('Marketing email send failed:', err);
    if (err instanceof CampaignSendError) {
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
      // The provider took the mail, and its record did not land: the row is
      // left `sending` on purpose (or `failed` with the stop recorded), and it
      // was reported as a provider rejection — the one answer that invites
      // sending it again.
      if (err.code === 'state_unrecorded') {
        return NextResponse.json({ error: t('send.sentButNotRecorded'), sent: err.sent }, { status: 502 });
      }
      if (err.total > 0) {
        const audience = err.total - err.sent + err.audience;
        return NextResponse.json({ error: t('send.stoppedPartway', { sent: err.total, total: audience }), sent: err.sent }, { status: 502 });
      }
      return NextResponse.json({ error: t('send.providerRejectedCampaign') }, { status: 502 });
    }
    // The provider branch still reads the message for the errors that are not
    // a CampaignSendError (no provider key configured): it decides a status and
    // never crosses into the response, and it decides no authorization outcome.
    const message = err instanceof Error ? err.message : '';
    const providerFailure = message.includes('Provider') || message.includes('provider') || message.includes('delivery state');
    return NextResponse.json({
      error: providerFailure ? t('send.providerRejectedCampaign') : t('send.couldNotSendCampaign'),
    }, { status: providerFailure ? 502 : 400 });
  }
}
