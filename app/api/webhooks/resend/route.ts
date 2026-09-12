import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
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

const eventSchema = z.object({
  type: z.string().min(1),
  data: z.object({
    // Resend webhooks use a record; retain the array shape accepted by older
    // callbacks/fixtures, which matches the outbound email API's tag format.
    tags: z.union([z.record(z.string()), z.array(z.object({ name: z.string(), value: z.string() }))]).optional(),
    to: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1))]).optional(),
  }).passthrough().optional(),
}).passthrough().refine((event) => {
  if (event.type !== 'email.bounced' && event.type !== 'email.complained') return true;
  const recipients = event.data?.to;
  return typeof recipients === 'string' || (Array.isArray(recipients) && recipients.length > 0);
}, 'A suppression event must identify at least one recipient.');

export async function POST(req: NextRequest) {
  const tr = await getTranslations();
  const boundedBody = await readBoundedRequestText(req, 256_000);
  if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Payload too large' : 'Unable to read payload' }, { status: boundedBody.reason === 'too_large' ? 413 : 400 });
  const body = boundedBody.text;
  if (!verify(body, req.headers)) {
    return NextResponse.json({ error: tr('resend.invalidSignature') }, { status: 401 });
  }

  const svixId = req.headers.get('svix-id')!;

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: tr('resend.badPayload') }, { status: 400 });
  }
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: tr('resend.badPayload') }, { status: 400 });
  const event = parsed.data;

  const supabase = createServiceClient();
  const retry = () => NextResponse.json(
    { error: tr('resend.webhookStorageUnavailable') },
    { status: 503, headers: { 'Retry-After': '30' } },
  );
  const { data: prior, error: priorError } = await supabase
    .from('resend_webhook_events')
    .select('status, received_at')
    .eq('svix_id', svixId)
    .maybeSingle();
  if (priorError) return retry();

  const priorAge = prior?.received_at ? Date.now() - new Date(prior.received_at).getTime() : 0;
  if (prior?.status === 'processed') {
    return NextResponse.json({ received: true, duplicate: true });
  }
  // A second delivery cannot know whether an active worker will finish. A 200
  // here makes the provider abandon retries even if that worker has failed.
  if (prior?.status === 'processing' && priorAge < 10 * 60_000) return retry();

  // The existing receipt timestamp also identifies the claim owner. Advance it
  // even for a retry in the same millisecond, so an older worker cannot release
  // or finalize a newer claim. No additional database columns are required.
  const previousReceivedAt = prior ? new Date(prior.received_at).getTime() : 0;
  const receivedAt = new Date(Math.max(Date.now(), previousReceivedAt + 1)).toISOString();

  if (prior) {
    const { data: claimed, error: claimError } = await supabase
      .from('resend_webhook_events')
      .update({ status: 'processing', received_at: receivedAt, processed_at: null, error: null })
      .eq('svix_id', svixId)
      .eq('status', prior.status)
      .eq('received_at', prior.received_at)
      .select('svix_id').maybeSingle();
    if (claimError || !claimed) return retry();
  } else {
    const { error: insertError } = await supabase.from('resend_webhook_events').insert({
      svix_id: svixId,
      event_type: event.type,
      status: 'processing',
      received_at: receivedAt,
    });
    // A unique conflict is another worker's claim, not proof of completion.
    if (insertError) return retry();
  }

  try {
    const field = FIELD[event.type];
    const tags = event.data?.tags;
    const campaignId = Array.isArray(tags) ? tags.find((t) => t.name === 'campaign')?.value : tags?.campaign;

    // Suppress first. This upsert is safe to repeat if a later counter or receipt
    // write fails; a metrics failure must never prevent the safety-critical
    // bounce/complaint suppression from being attempted.
    if (event.type === 'email.bounced' || event.type === 'email.complained') {
      const tos = Array.isArray(event.data?.to) ? event.data!.to : event.data?.to ? [event.data.to] : [];
      const reason = event.type === 'email.bounced' ? 'bounce' : 'complaint';
      for (const to of tos) {
        const { error: suppressionError } = await supabase.from('marketing_suppressions')
          .upsert({ email: String(to).toLowerCase(), reason, campaign_id: campaignId ?? null });
        if (suppressionError) throw new Error('Suppression persistence failed');
      }
    }

    if (field && campaignId) {
      const { data: row, error: campaignReadError } = await supabase.from('marketing_email_campaigns').select(field).eq('id', campaignId).maybeSingle();
      if (campaignReadError) throw new Error('Campaign lookup failed');
      if (row) {
        const current = (row as Record<string, number>)[field] ?? 0;
        const { data: updated, error: counterError } = await supabase.from('marketing_email_campaigns')
          .update({ [field]: current + 1 } as never).eq('id', campaignId).select('id').maybeSingle();
        if (counterError || !updated) throw new Error('Counter persistence failed');
      }
    }

    // Engagement workflows retain their existing best-effort contract. Their
    // own durable workflow/subject key prevents repeated completed runs.
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
          console.error('[resend webhook] engagement automation failed');
        }
      }
    }

    const { data: processed, error: processedError } = await supabase.from('resend_webhook_events')
      .update({ status: 'processed', processed_at: new Date().toISOString(), error: null })
      .eq('svix_id', svixId).eq('status', 'processing').eq('received_at', receivedAt)
      .select('svix_id').maybeSingle();
    if (processedError || !processed) throw new Error('Webhook finalization failed');
    return NextResponse.json({ received: true });
  } catch {
    // Release only our own unfinished claim. If this write also fails, a retry
    // still receives 503 while the claim is active and can reclaim it when stale.
    try {
      const { data: released, error: releaseError } = await supabase.from('resend_webhook_events')
        .update({ status: 'error', processed_at: null, error: 'Webhook processing failed' })
        .eq('svix_id', svixId).eq('status', 'processing').eq('received_at', receivedAt)
        .select('svix_id').maybeSingle();
      if (releaseError || !released) console.error('[resend webhook] failed claim was not released');
    } catch {
      console.error('[resend webhook] failed claim was not released');
    }
    return retry();
  }
}
