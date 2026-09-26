import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { contactSchema, contactTopicLabel, fieldErrors } from '@/lib/validation';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { sendEmail } from '@/lib/server/email';
import { createServiceClient } from '@/lib/supabase/server';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';

/** Escape every HTML-significant character, not just `<`. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export const runtime = 'nodejs';
const MAX_CONTACT_REQUEST_BYTES = 16_384;

export async function POST(req: Request) {
  const t = await getTranslations();
  const ip = clientIp(req.headers);
  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `contact:${ip}`, { limit: 5 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: t('contact.tooManyMessagesPleaseTry') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
  }

  const body = await readBoundedRequestJson(req, MAX_CONTACT_REQUEST_BYTES);
  if (!body.ok) {
    return NextResponse.json(
      { error: body.reason === 'too_large' ? 'Request body too large.' : 'Invalid request body' },
      { status: body.reason === 'too_large' ? 413 : 400 },
    );
  }

  const parsed = contactSchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json({ error: t('contact.validationFailed'), fields: fieldErrors(parsed.error) }, { status: 422 });
  }

  const { name, email, topic, message } = parsed.data;
  const topicLabel = contactTopicLabel(topic);
  // Bug reports + feature requests deserve faster triage.
  const priority = topic === 'bug' ? 'high' : topic === 'billing' || topic === 'account' ? 'medium' : 'medium';
  const to = process.env.CONTACT_INBOX ?? 'support@bubaly.com';

  // Persist as a support ticket so it surfaces in the admin console even if
  // email delivery is unavailable. Best-effort for the USER — it never blocks
  // the response on its own — but whether it landed is remembered, because it
  // is the other half of the promise this endpoint makes. A PostgREST call
  // resolves with { error } rather than throwing, so the catch below cannot
  // see a refused insert; the error is read. Audit C3-S5-05.
  let ticketFiled = false;
  const ticketNumber = `WEB-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  try {
    const { error: ticketError } = await supabase
      .from('support_tickets')
      .insert({
        ticket_number: ticketNumber,
        subject: `[${topicLabel}] Contact from ${name}`,
        description: message,
        category: topic,
        priority,
        status: 'open',
        requester_name: name,
        requester_email: email,
        tags: ['contact-form', `topic:${topic}`],
      });
    if (ticketError) console.error('[contact] support ticket insert failed', ticketError);
    else ticketFiled = true;
    // Surface it in the Super Admin Notification Center.
    const { recordAdminNotification } = await import('@/lib/admin/notify');
    await recordAdminNotification(supabase, {
      kind: 'support_ticket',
      title: `${topicLabel} — ${name}`,
      body: message.slice(0, 200),
      url: '/admin/support-tickets?tab=open',
      relatedType: 'support_ticket',
    });
  } catch {
    /* non-fatal: the email below is the primary path */
  }

  // Fire any event-driven "form_submitted" automation workflows in real time.
  // Best-effort: never block the contact response on marketing automation.
  try {
    await fireAutomationEvent(supabase, {
      trigger: 'form_submitted',
      email,
      name,
      subjectKey: eventSubjectKey('form_submitted', [ticketNumber]),
      context: { source: 'contact-form' },
    });
  } catch {
    /* non-fatal */
  }

  const result = await sendEmail({
    to,
    replyTo: email,
    subject: `[${topicLabel}] New Bubaly contact from ${name}`,
    // Every interpolated value is escaped, not just the message body. `name` was
    // dropped in raw while `message` was escaped ON THE SAME LINE, so the intent
    // was clearly there — and `contactSchema` bounds `name` only by length
    // (2–120), not by character. An anonymous visitor could put arbitrary markup
    // into a mail the support team trusts: a tracking pixel, or an anchor whose
    // text and href disagree. Audit C1-S9-24.
    html: `<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}) — <em>${escapeHtml(topicLabel)}</em> — wrote:</p><p>${escapeHtml(message)}</p>`,
  });

  if (!result.ok) {
    return NextResponse.json({ error: t('contact.weCouldnTSendYour') }, { status: 502 });
  }
  // `skipped` means no mail provider is configured, and sendEmail reports that
  // as ok: nothing was sent. Answering "sent" is only honest while the ticket
  // exists for a human to find. With neither, the message reached nobody, and
  // the form used to say it had. Audit C3-S5-05.
  if (result.skipped && !ticketFiled) {
    console.error('[contact] no mail provider and no ticket — the message reached nobody');
    return NextResponse.json({ error: t('contact.weCouldnTSendYour') }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
