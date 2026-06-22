import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase/server';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey, isEventTrigger } from '@/lib/marketing/automation-triggers';

export const runtime = 'nodejs';

// Resend event type → our event-driven automation trigger.
const EVENT_TRIGGER: Record<string, 'email_opened' | 'email_clicked'> = {
  'email.opened': 'email_opened',
  'email.clicked': 'email_clicked',
};

// Verify a Svix-signed webhook (Resend uses Svix). Returns true only on a valid
// signature against RESEND_WEBHOOK_SECRET (whsec_...).
function verify(body: string, headers: Headers): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;
  const id = headers.get('svix-id');
  const ts = headers.get('svix-timestamp');
  const sigHeader = headers.get('svix-signature');
  if (!id || !ts || !sigHeader) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signed = `${id}.${ts}.${body}`;
  const expected = createHmac('sha256', key).update(signed).digest('base64');
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
  const body = await req.text();
  if (!verify(body, req.headers)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let event: { type: string; data?: { tags?: { name: string; value: string }[]; to?: string | string[] } };
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'Bad payload' }, { status: 400 });
  }

  const field = FIELD[event.type];
  if (!field) return NextResponse.json({ received: true });

  const supabase = createServiceClient();
  const campaignId = event.data?.tags?.find((t) => t.name === 'campaign')?.value;

  if (campaignId) {
    const { data: row } = await supabase.from('marketing_email_campaigns').select(field).eq('id', campaignId).maybeSingle();
    if (row) {
      const current = (row as Record<string, number>)[field] ?? 0;
      await supabase.from('marketing_email_campaigns').update({ [field]: current + 1 } as never).eq('id', campaignId);
    }
  }

  // Bounces and complaints suppress the address from future sends.
  if (event.type === 'email.bounced' || event.type === 'email.complained') {
    const tos = Array.isArray(event.data?.to) ? event.data!.to : event.data?.to ? [event.data.to] : [];
    const reason = event.type === 'email.bounced' ? 'bounce' : 'complaint';
    for (const to of tos) {
      await supabase.from('marketing_suppressions').upsert({ email: String(to).toLowerCase(), reason, campaign_id: campaignId ?? null });
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

  return NextResponse.json({ received: true });
}
