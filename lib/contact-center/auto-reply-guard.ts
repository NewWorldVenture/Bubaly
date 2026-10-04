// Whether a Contact Center auto-reply may be sent to an inbound email.
//
// The email route acknowledges every message a family's @bubaly.com address
// receives. An acknowledgement sent to mail that was itself automatic — an
// out-of-office, a bounce, a mailing list, another family's own
// acknowledgement — gets answered by THAT system in turn, and the two can
// trade replies for as long as both stay up: real mail from the family's
// address every pass, and a paid concierge call every pass on our side.
// RFC 3834 §2 is the rule this follows: do not auto-respond to anything that
// says it is automatic or bulk, nor to an address that does not take mail.
//
// Pure: the route passes the provider's fields and the sender, and this says
// why not to reply, or null. Providers hand headers over differently —
// SendGrid Inbound Parse as one raw `headers` block, Mailgun and others as
// top-level fields — so both are read, case-insensitively.

import { BUBALY_DOMAIN } from './address';

export type AutoReplyRefusal =
  | 'auto_submitted'
  | 'bulk_or_list'
  | 'responder_suppressed'
  | 'no_reply_sender'
  | 'bubaly_sender';

/** Senders that do not read mail: replying to them is a bounce or a loop. */
const NO_REPLY_LOCALS = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|donotreply|bounces?([+-].*)?|notifications?-noreply)$/i;

/** The value of one header, from top-level fields or a raw header block. */
export function inboundHeader(fields: Record<string, unknown>, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(fields)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value.trim();
  }
  const raw = Object.entries(fields).find(([key, value]) => key.toLowerCase() === 'headers' && typeof value === 'string')?.[1] as string | undefined;
  if (!raw) return null;
  // Unfold continuation lines first (RFC 5322 §2.2.3), then find the name.
  const lines = raw.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
  for (const line of lines) {
    const at = line.indexOf(':');
    if (at > 0 && line.slice(0, at).trim().toLowerCase() === wanted) return line.slice(at + 1).trim();
  }
  return null;
}

/** The bare address inside a From value ("Name <a@b>" or "a@b"), lowercased. */
export function senderAddress(from: string | null | undefined): string | null {
  if (!from) return null;
  const angled = /<([^<>@\s]+@[^<>@\s]+)>/.exec(from);
  const bare = angled ? angled[1] : /([^\s<>"',;]+@[^\s<>"',;]+)/.exec(from)?.[1];
  return bare ? bare.toLowerCase() : null;
}

/** Why this inbound email must not get an auto-reply, or null when it may. */
export function autoReplyRefusal(fields: Record<string, unknown>, from: string | null | undefined): AutoReplyRefusal | null {
  const autoSubmitted = inboundHeader(fields, 'Auto-Submitted');
  if (autoSubmitted && autoSubmitted.toLowerCase().split(';')[0].trim() !== 'no') return 'auto_submitted';
  if (inboundHeader(fields, 'X-Autoreply') || inboundHeader(fields, 'X-Autorespond')) return 'auto_submitted';

  const precedence = inboundHeader(fields, 'Precedence')?.toLowerCase();
  if (precedence && ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) return 'bulk_or_list';
  if (inboundHeader(fields, 'List-Id') || inboundHeader(fields, 'List-Unsubscribe')) return 'bulk_or_list';

  const suppress = inboundHeader(fields, 'X-Auto-Response-Suppress')?.toLowerCase() ?? '';
  if (/\b(all|oof|autoreply)\b/.test(suppress)) return 'responder_suppressed';

  const address = senderAddress(from);
  if (!address) return 'no_reply_sender';
  const [local, domain] = address.split('@');
  if (NO_REPLY_LOCALS.test(local)) return 'no_reply_sender';
  // Another family's address answering ours is the shortest loop there is:
  // both sides acknowledge, forever. Mail from any @bubaly.com address is
  // filed as usual; it is only not acknowledged automatically.
  if (domain === BUBALY_DOMAIN || domain.endsWith(`.${BUBALY_DOMAIN}`)) return 'bubaly_sender';
  return null;
}

/** Headers every Contact Center auto-reply carries, so the other side's responder stays quiet. */
export const AUTO_REPLY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Auto-Submitted': 'auto-replied',
  'X-Auto-Response-Suppress': 'All',
});
