import { NextResponse } from 'next/server';
import { contactSchema, fieldErrors } from '@/lib/validation';
import { rateLimit, clientIp } from '@/lib/server/rate-limit';
import { sendEmail } from '@/lib/server/email';
import { createServiceClient } from '@/lib/supabase/server';

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
  const to = process.env.CONTACT_INBOX ?? 'hello@bubaly.com';

  // Persist as a support ticket so it surfaces in the admin console even if
  // email delivery is unavailable. Best-effort: never block the user on it.
  try {
    await createServiceClient()
      .from('support_tickets')
      .insert({
        ticket_number: `WEB-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
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
