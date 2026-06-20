// Plain-HTML email delivery via Resend (used where we don't render a React
// template — contact form, onboarding invite). Shares the from-address and
// key handling with lib/email.ts so there's a single Resend configuration.
// No-ops gracefully (logs) when RESEND_API_KEY is unset, so local/dev flows
// never break — production just adds the key.
import { FROM_EMAIL, emailEnabled } from '@/lib/email';

type SendArgs = { to: string; subject: string; html: string; replyTo?: string };

export async function sendEmail({ to, subject, html, replyTo }: SendArgs): Promise<{ ok: boolean; skipped?: boolean }> {
  if (!emailEnabled()) {
    console.info(`[email skipped — no RESEND_API_KEY] to=${to} subject="${subject}"`);
    return { ok: true, skipped: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html, reply_to: replyTo }),
  });
  if (!res.ok) {
    console.error('[email failed]', res.status, await res.text());
    return { ok: false };
  }
  return { ok: true };
}
