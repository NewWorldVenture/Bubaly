import { NextResponse } from 'next/server';
import { contactSchema, fieldErrors } from '@/lib/validation';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { sendEmail } from '@/lib/server/email';
import { createServiceClient } from '@/lib/supabase/server';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';
const MAX_CONTACT_REQUEST_BYTES = 16_384;

export async function POST(req: Request) {
  const ip = clientIp(req.headers);
  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `contact:${ip}`, { limit: 5 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'Too many messages. Please try again shortly.' },
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
    return NextResponse.json({ error: 'Validation failed', fields: fieldErrors(parsed.error) }, { status: 422 });
  }

  const { name, email, message } = parsed.data;
  const to = process.env.CONTACT_INBOX ?? 'support@bubaly.com';

  // Persist as a support ticket so it surfaces in the admin console even if
  // email delivery is unavailable. Best-effort: never block the user on it.
  const ticketNumber = `WEB-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  try {
    await supabase
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
    subject: `New Bubaly contact from ${name}`,
    html: `<p><strong>${name}</strong> (${email}) wrote:</p><p>${message.replace(/</g, '&lt;')}</p>`,
  });

  if (!result.ok) {
    return NextResponse.json({ error: 'We couldn’t send your message. Please try again.' }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
