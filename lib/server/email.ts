// Plain-HTML email delivery via Resend (used where we don't render a React
// template — contact form, onboarding invite). Shares the from-address and
// key handling with lib/email.ts so there's a single Resend configuration.
// No-ops gracefully (logs) when RESEND_API_KEY is unset, so local/dev flows
// never break — production just adds the key.
import { FROM_EMAIL, emailEnabled } from '@/lib/email';
import { readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchWithDeadline } from '@/lib/server/fetch-with-deadline';

function mailboxDomain(address: string): string | null {
  if (/\s/.test(address)) return null;
  const match = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/i.exec(address);
  return match?.[1].toLowerCase() ?? null;
}

/** Use the family's mailbox only within the deployment's configured sender domain. */
export function familyReplySender(familyLabel: string, familyAddress: string): string {
  const configured = FROM_EMAIL.trim();
  const sender = /^[^<>\r\n]*<([^<>\s]+)>$/.exec(configured)?.[1] ?? configured;
  const familyDomain = mailboxDomain(familyAddress);
  if (!familyDomain || familyDomain !== mailboxDomain(sender)) return FROM_EMAIL;
  // Omit an unsafe label rather than letting it change mailbox/header syntax.
  if (/[\u0000-\u001f\u007f-\u009f<>\u2028\u2029]/.test(familyLabel)) return familyAddress;
  const label = familyLabel.trim();
  if (!label) return familyAddress;
  const quoted = label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${quoted}" <${familyAddress}>`;
}

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
  /**
   * Optional, caller-supplied idempotency key, sent unchanged as Resend's
   * `Idempotency-Key` header. A caller that may retry the SAME message passes the
   * SAME key and the same payload on every attempt, and Resend answers the repeat
   * with the original result instead of sending again — for 24 hours, and only
   * while the payload is identical (a different payload under a used key is a 409,
   * which this helper reports as `{ ok: false }`, not as sent).
   * https://resend.com/docs/dashboard/emails/idempotency-keys
   *
   * This helper never generates a key and never retries. A durable record of what
   * was sent is still the caller's job; the key alone is not exactly-once.
   */
  idempotencyKey?: string;
};

/**
 * Resend accepts 1–256 characters. It must also survive as an HTTP header value
 * UNCHANGED, which rules out control characters (CR/LF would be header
 * injection), non-ASCII (fetch rejects it) and leading or trailing spaces (fetch
 * trims them, so the provider would see a different key from the one recorded).
 */
const IDEMPOTENCY_KEY = /^[\x21-\x7e](?:[\x20-\x7e]{0,254}[\x21-\x7e])?$/;

function assertIdempotencyKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) {
    throw new TypeError('sendEmail: idempotencyKey must be 1–256 printable ASCII characters, without leading or trailing spaces');
  }
}

export async function sendEmail({ to, subject, html, replyTo, from, idempotencyKey }: SendArgs): Promise<{ ok: boolean; skipped?: boolean }> {
  // Before anything else, so a malformed key is a visible bug in every
  // environment, and never becomes a provider 400 or a silently changed header.
  if (idempotencyKey !== undefined) assertIdempotencyKey(idempotencyKey);
  if (!emailEnabled()) {
    console.info(`[email skipped — no RESEND_API_KEY] to=${to} subject="${subject}"`);
    return { ok: true, skipped: true };
  }
  const res = await fetchWithDeadline('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'content-type': 'application/json',
      ...(idempotencyKey !== undefined ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify({ from: from || FROM_EMAIL, to, subject, html, reply_to: replyTo }),
  }, 15_000);
  if (!res.ok) {
    const bounded = await readBoundedResponseText(res, 64 * 1024);
    console.error('[email failed]', res.status, bounded.ok ? bounded.text : '[provider error response exceeded 64 KiB]');
    return { ok: false };
  }
  return { ok: true };
}
