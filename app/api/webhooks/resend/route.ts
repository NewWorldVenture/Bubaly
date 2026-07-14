import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase/server';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey, isEventTrigger } from '@/lib/marketing/automation-triggers';
import { readBoundedRequestText } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';

// Resend event type → our event-driven automation trigger.
const EVENT_TRIGGER: Record<string, 'email_opened' | 'email_clicked'> = {
  'email.opened': 'email_opened',
  'email.clicked': 'email_clicked',
};

// Verify a Svix-signed webhook (Resend uses Svix). Returns true only on a valid
// signature against RESEND_WEBHOOK_SECRET (whsec_...).
function verify(body: string, headers: Headers, nowMs = Date.now()): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;
  const id = headers.get('svix-id');
  const ts = headers.get('svix-timestamp');
  const sigHeader = headers.get('svix-signature');
  if (!id || !ts || !sigHeader) return false;

  const timestampSeconds = Number(ts);
  if (!Number.isFinite(timestampSeconds) || Math.abs(nowMs / 1000 - timestampSeconds) > 300) return false;

  let expected: string;
  try {
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const signed = `${id}.${ts}.${body}`;
    expected = createHmac('sha256', key).update(signed).digest('base64');
  } catch {
    return false;
  }
  // Header is space-separated "v1,<sig>" pairs.
  return sigHeader.split(' ').some((part) => {
    const sig = part.split(',')[1];
    if (!sig) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

const FIELD: Record<string, 'opens' | 'clicks' | 'bounces' | 'unsubscribes'> = {
  'email.opened': 'opens',
  'email.clicked': 'clicks',
  'email.bounced': 'bounces',
  'email.complained': 'unsubscribes',
};

export async function POST(req: NextRequest) {
  const boundedBody = await readBoundedRequestText(req, 256_000);
  if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Payload too large' : 'Unable to read payload' }, { status: boundedBody.reason === 'too_large' ? 413 : 400 });
  const body = boundedBody.text;
  if (!verify(body, req.headers)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const svixId = req.headers.get('svix-id')!;

  let event: { type: string; data?: { tags?: { name: string; value: string }[]; to?: string | string[] } };
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'Bad payload' }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data: prior, error: priorError } = await supabase
    .from('resend_webhook_events')
    .select('status, received_at')
    .eq('svix_id', svixId)
    .maybeSingle();
  if (priorError) return NextResponse.json({ error: 'Webhook storage unavailable' }, { status: 503 });

  const priorAge = prior?.received_at ? Date.now() - new Date(prior.received_at).getTime() : 0;
  if (prior?.status === 'processed' || (prior?.status === 'processing' && priorAge < 10 * 60_000)) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  if (prior) {
    const { error: claimError } = await supabase
      .from('resend_webhook_events')
      .update({ status: 'processing', received_at: new Date().toISOString(), processed_at: null, error: null })
      .eq('svix_id', svixId);
    if (claimError) return NextResponse.json({ error: 'Webhook storage unavailable' }, { status: 503 });
  } else {
    const { error: insertError } = await supabase.from('resend_webhook_events').insert({
      svix_id: svixId,
      event_type: event.type,
      status: 'processing',
    });
    if (insertError) {
      if (insertError.code === '23505') return NextResponse.json({ received: true, duplicate: true });
      return NextResponse.json({ error: 'Webhook storage unavailable' }, { status: 503 });
    }
  }

  const field = FIELD[event.type];
  if (!field) {
    const { data: processed, error: processedError } = await supabase.from('resend_webhook_events')
      .update({ status: 'processed', processed_at: new Date().toISOString() })
      .eq('svix_id', svixId).select('svix_id').maybeSingle();
    if (processedError || !processed) return NextResponse.json({ error: 'Webhook storage unavailable' }, { status: 503 });
    return NextResponse.json({ received: true });
  }

  const campaignId = event.data?.tags?.find((t) => t.name === 'campaign')?.value;

  if (campaignId) {
    const { data: row, error: campaignReadError } = await supabase.from('marketing_email_campaigns').select(field).eq('id', campaignId).maybeSingle();
    if (campaignReadError) return NextResponse.json({ error: 'Webhook storage unavailable' }, { status: 503 });
    if (row) {
      const current = (row as Record<string, number>)[field] ?? 0;
      const { data: updated, error: counterError } = await supabase.from('marketing_email_campaigns')
        .update({ [field]: current + 1 } as never).eq('id', campaignId).select('id').maybeSingle();
      if (counterError || !updated) return NextResponse.json({ error: 'Webhook storage unavailable' }, { status: 503 });
    }
  }

  // Bounces and complaints suppress the address from future sends.
  if (event.type === 'email.bounced' || event.type === 'email.complained') {
    const tos = Array.isArray(event.data?.to) ? event.data!.to : event.data?.to ? [event.data.to] : [];
    const reason = event.type === 'email.bounced' ? 'bounce' : 'complaint';
    for (const to of tos) {
      const { error: suppressionError } = await supabase.from('marketing_suppressions')
        .upsert({ email: String(to).toLowerCase(), reason, campaign_id: campaignId ?? null });
      if (suppressionError) return NextResponse.json({ error: 'Webhook storage unavailable' }, { status: 503 });
    }
  }

  // Fire event-driven engagement workflows (email_opened / email_clicked). Dedup
  // is per recipient per campaign per trigger, so repeated opens fire only once.
  const trigger = EVENT_TRIGGER[event.type];
  if (trigger && isEventTrigger(trigger)) {
    const recipient = Array.isArray(event.data?.to) ? event.data?.to[0] : event.data?.to;
    if (recipient) {
      try {
        await fireAutomationEvent(supabase, {
          trigger,
          email: String(recipient).toLowerCase(),
          subjectKey: eventSubjectKey(trigger, [campaignId ?? 'none', String(recipient)]),
          context: { campaignId: campaignId ?? null },
        });
      } catch {
        /* non-fatal */
      }
    }
  }

  const { data: processed, error: processedError } = await supabase.from('resend_webhook_events')
    .update({ status: 'processed', processed_at: new Date().toISOString(), error: null })
    .eq('svix_id', svixId).select('svix_id').maybeSingle();
  if (processedError || !processed) return NextResponse.json({ error: 'Webhook storage unavailable' }, { status: 503 });

  return NextResponse.json({ received: true });
}
