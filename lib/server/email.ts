// Plain-HTML email delivery via Resend (used where we don't render a React
// template — contact form, onboarding invite). Shares the from-address and
// key handling with lib/email.ts so there's a single Resend configuration.
// No-ops gracefully (logs) when RESEND_API_KEY is unset, so local/dev flows
// never break — production just adds the key.
import { FROM_EMAIL, emailEnabled } from '@/lib/email';
import { readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchExternal } from '@/lib/server/external-fetch';

type SendArgs = {
  to: string; subject: string; html: string; replyTo?: string;
  /**
   * Send AS this address instead of the product's own FROM_EMAIL.
   *
   * Only for mail a family sends from its own @bubaly.com address. Without it
   * the Contact Center's reply to a teacher left as notifications@bubaly.com
   * with the family address in a footer line — so Reply reached the product's
   * inbox, not the family's, and the thread the teacher started simply ended.
   *
   * Optional and defaulted, so every other caller keeps the single product
   * identity. The domain must be verified with the provider either way; this
   * changes the local-part, not the domain.
   */
  from?: string;
};

export async function sendEmail({ to, subject, html, replyTo, from }: SendArgs): Promise<{ ok: boolean; skipped?: boolean }> {
  if (!emailEnabled()) {
    console.info(`[email skipped — no RESEND_API_KEY] to=${to} subject="${subject}"`);
    return { ok: true, skipped: true };
  }
  const res = await fetchExternal('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: from || FROM_EMAIL, to, subject, html, reply_to: replyTo }),
  }, 15_000);
  if (!res.ok) {
    const bounded = await readBoundedResponseText(res, 64 * 1024);
    console.error('[email failed]', res.status, bounded.ok ? bounded.text : '[provider error response exceeded 64 KiB]');
    return { ok: false };
  }
  return { ok: true };
}
