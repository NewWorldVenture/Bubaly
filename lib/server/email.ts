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
   * while the payload is identical (a different payload under a used key is a 409
   * `invalid_idempotent_request`, which this helper reports as
   * `{ ok: false, reason: 'payload_conflict' }`, not as sent).
   * https://resend.com/docs/dashboard/emails/idempotency-keys
   *
   * This helper never generates a key, and never re-sends on its own account.
   * The one thing it does repeat is the QUESTION: a 409
   * `concurrent_idempotent_requests` means another request under this very key
   * is in flight at the provider — the mirrored cron tick a minute apart, two
   * workers of one job — and its answer is not known yet. Reporting that as a
   * failure made the recipient's delivery depend on the OTHER request: if that
   * one then failed, nobody sent, and nothing retried until the next tick. So the
   * helper waits and asks again with the same key and bytes (`CONCURRENT_KEY_RETRY_DELAYS_MS`,
   * bounded): once the other request has settled, the provider either folds this
   * one onto it (accepted: `{ ok: true }`, nothing sent twice) or, if the other
   * failed and the key is free, sends it. Still in flight when the budget is
   * spent is `{ ok: false, reason: 'in_progress' }`, for the caller's own retry
   * to settle.
   *
   * A durable record of what was sent is still the caller's job; the key alone
   * is not exactly-once.
   */
  idempotencyKey?: string;
  /**
   * Extra message headers, passed to the provider as given. The Contact
   * Center's auto-reply marks itself `Auto-Submitted: auto-replied` (RFC 3834)
   * so the other side's responder does not answer it. Absent, the request body
   * is byte-for-byte what it was, so existing idempotency keys keep matching.
   */
  headers?: Readonly<Record<string, string>>;
};

/** Each ask's own deadline, as it always was. */
const SEND_DEADLINE_MS = 15_000;

/**
 * The wait between asks while another request under the same key is in flight:
 * backing off to two seconds and staying there. The schedule does not bound the
 * waiting; `CONCURRENT_KEY_WAIT_BUDGET_MS` does.
 */
export const CONCURRENT_KEY_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000];

/**
 * The whole of the waiting, counted from the moment the provider first said
 * another request under this key was in flight: no further ask starts once the
 * next wait plus a minimum ask would pass it, and every later ask's own deadline
 * is clipped to what is left of it. So a keyed call lasts at most its first ask
 * (15 s, as before) plus this budget — bounded in wall time, not in asks. A
 * provider answer takes well under a second; a request still in flight after
 * eight seconds is for the caller's own retry, not for this helper to sit on
 * inside a scheduler's deadline.
 */
export const CONCURRENT_KEY_WAIT_BUDGET_MS = 8_000;

/** An ask is not started with less than this of the budget left for its answer. */
const MIN_ASK_MS = 1_000;

/** Why a send was not accepted, where the provider said. */
export type SendFailureReason =
  /** 409 `invalid_idempotent_request`: this key was used for different bytes. Nothing was sent; re-keying is not the answer. */
  | 'payload_conflict'
  /** 409 `concurrent_idempotent_requests` on every ask: another request under this key never settled while we waited. */
  | 'in_progress'
  /** Any other non-2xx. */
  | 'rejected';

export type SendEmailResult = { ok: true; skipped?: boolean } | { ok: false; reason: SendFailureReason };

/** The `name` Resend puts in an error body, or null for a body of any other shape. */
function providerErrorName(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && typeof (parsed as { name?: unknown }).name === 'string' ? (parsed as { name: string }).name : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

export async function sendEmail({ to, subject, html, replyTo, from, idempotencyKey, headers: extraHeaders }: SendArgs): Promise<SendEmailResult> {
  // Before anything else, so a malformed key is a visible bug in every
  // environment, and never becomes a provider 400 or a silently changed header.
  if (idempotencyKey !== undefined) assertIdempotencyKey(idempotencyKey);
  if (!emailEnabled()) {
    console.info(`[email skipped — no RESEND_API_KEY] to=${to} subject="${subject}"`);
    return { ok: true, skipped: true };
  }
  // The same bytes on every ask: the key's promise holds only while they are identical.
  const body = JSON.stringify({ from: from || FROM_EMAIL, to, subject, html, reply_to: replyTo, ...(extraHeaders ? { headers: extraHeaders } : {}) });
  const headers = {
    authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    'content-type': 'application/json',
    ...(idempotencyKey !== undefined ? { 'idempotency-key': idempotencyKey } : {}),
  };
  /** When the provider first said another request under this key was in flight; null until then. */
  let waitingSince: number | null = null;
  for (let ask = 0; ; ask += 1) {
    const budgetLeft = waitingSince === null ? Infinity : waitingSince + CONCURRENT_KEY_WAIT_BUDGET_MS - Date.now();
    const res = await fetchWithDeadline(
      'https://api.resend.com/emails', { method: 'POST', headers, body }, Math.max(1, Math.min(SEND_DEADLINE_MS, budgetLeft)),
    );
    if (res.ok) return { ok: true };
    const bounded = await readBoundedResponseText(res, 64 * 1024);
    const text = bounded.ok ? bounded.text : '[provider error response exceeded 64 KiB]';
    const name = res.status === 409 && idempotencyKey !== undefined ? providerErrorName(text) : null;
    if (name === 'concurrent_idempotent_requests') {
      // Another request under this key is in flight; its outcome decides ours.
      waitingSince ??= Date.now();
      const wait = CONCURRENT_KEY_RETRY_DELAYS_MS[Math.min(ask, CONCURRENT_KEY_RETRY_DELAYS_MS.length - 1)];
      const left = waitingSince + CONCURRENT_KEY_WAIT_BUDGET_MS - Date.now();
      if (wait + MIN_ASK_MS <= left) {
        console.warn(`[email] another request under this idempotency key is in flight; asking again in ${wait} ms`);
        await sleep(wait);
        continue;
      }
      console.error('[email failed]', res.status, text, `(still in flight after ${ask + 1} asks over ${CONCURRENT_KEY_WAIT_BUDGET_MS} ms)`);
      return { ok: false, reason: 'in_progress' };
    }
    console.error('[email failed]', res.status, text);
    return { ok: false, reason: name === 'invalid_idempotent_request' ? 'payload_conflict' : 'rejected' };
  }
}
