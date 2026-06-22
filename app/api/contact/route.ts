import { NextResponse } from 'next/server';
import { contactSchema, fieldErrors } from '@/lib/validation';
import { rateLimit, clientIp } from '@/lib/server/rate-limit';
import { sendEmail } from '@/lib/server/email';
import { createServiceClient } from '@/lib/supabase/server';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const ip = clientIp(req.headers);
  const limit = rateLimit(`contact:${ip}`, { limit: 5, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many messages. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = contactSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', fields: fieldErrors(parsed.error) }, { status: 422 });
  }

  const { name, email, message } = parsed.data;
  const to = process.env.CONTACT_INBOX ?? 'support@bubaly.com';

  // Persist as a support ticket so it surfaces in the admin console even if
  // email delivery is unavailable. Best-effort: never block the user on it.
  const ticketNumber = `WEB-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  try {
    await createServiceClient()
      .from('support_tickets')
      .insert({
        ticket_number: ticketNumber,
        subject: `Contact from ${name}`,
        description: message,
        category: 'general',
        priority: 'medium',
        status: 'open',
        requester_name: name,
        requester_email: email,
        tags: ['contact-form'],
      });
  } catch {
    /* non-fatal: the email below is the primary path */
  }

  // Fire any event-driven "form_submitted" automation workflows in real time.
  // Best-effort: never block the contact response on marketing automation.
  try {
    await fireAutomationEvent(createServiceClient(), {
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
    subject: `New Bubaly contact from ${name}`,
    html: `<p><strong>${name}</strong> (${email}) wrote:</p><p>${message.replace(/</g, '&lt;')}</p>`,
  });

  if (!result.ok) {
    return NextResponse.json({ error: 'We couldn’t send your message. Please try again.' }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
