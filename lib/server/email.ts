// Email delivery via Resend. No-ops gracefully (logs) when RESEND_API_KEY is unset,
// so local/dev flows never break — production just adds the key.
type SendArgs = { to: string; subject: string; html: string; replyTo?: string };

const FROM = process.env.EMAIL_FROM ?? 'FamilyOS <notifications@familyos.app>';

export async function sendEmail({ to, subject, html, replyTo }: SendArgs): Promise<{ ok: boolean; skipped?: boolean }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.info(`[email skipped — no RESEND_API_KEY] to=${to} subject="${subject}"`);
    return { ok: true, skipped: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html, reply_to: replyTo }),
  });
  if (!res.ok) {
    console.error('[email failed]', res.status, await res.text());
    return { ok: false };
  }
  return { ok: true };
}
