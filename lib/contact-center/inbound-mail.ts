// Pure decisions about an inbound email: is this mail automatic, did the
// provider say its authentication failed, is there exactly ONE mailbox a
// courteous auto-reply may go back to, and what a message is classified as
// when the concierge is withheld. No I/O, so the webhook can be driven in a
// test and the rules read in one place. Tested in
// tests/an-inbound-auto-reply-does-not-loop-or-reflect.test.ts.
//
// WHY. app/api/contact-center/email/route.ts ran the AI concierge, OCR'd every
// attachment and auto-replied to the raw `From` header of an unauthenticated
// message, once per message, with no mark that the reply was automatic and no
// budget of any kind (audit N1, N2, N6). Four things followed:
//
//   1. UNBOUNDED COST. Every message with a fresh Message-Id was one model
//      call and one attachment-extraction pass; the only budget on the whole
//      path was the urgent SMS lane's (lib/contact-center/urgent-delivery.ts).
//   2. A REFLECTOR. Whatever address the sender wrote in From received mail
//      from the family's verified @bubaly.com identity, under a subject the
//      sender wrote, up to 1,000 characters long and with control characters
//      intact — backscatter from Bubaly's own domain to any third party.
//   3. A LOOP. A sender whose mailbox auto-acknowledges (a helpdesk, a vacation
//      responder, a second family address reached through a forged From)
//      answered the reply, the answer re-entered the webhook under a fresh
//      Message-Id — so the once-per-message reservation never refused it — and
//      every hop cost another model call, inbox row and outbound mail.
//   4. NO BUDGET on replies either: nothing capped how many a family address
//      could emit, or how many one sender could draw.
//
// So the route now budgets the concierge and the extraction per family and per
// sender (the constants below), DECIDES the reply recipient from the headers
// rather than taking it from them, bounds the echoed subject, marks the reply
// `Auto-Submitted: auto-replied` so compliant responders stay quiet (RFC 3834),
// and budgets replies per family and per sender.
import { isChildLoginEmail } from '@/lib/onboarding/child-login';
import type { ConciergeResult } from './concierge';
import { BUBALY_DOMAIN } from './address';
import { autoReplyText, classifyIntent, summarizeInbound } from './routing';
import { safeContactText } from './text';

export type InboundFields = Record<string, unknown>;

/** One day, the window every budget below is counted over. */
export const DAY_MS = 86_400_000;

/**
 * Concierge runs (one model call each) plus attachment extraction one family
 * address may draw in a day, across every sender. Over it, the message is still
 * filed, with the deterministic classification (routing.ts) and without OCR or
 * an auto-reply. Anyone can mail the address, so this is a cost ceiling, not a
 * quota a household is expected to reach.
 */
export const EMAIL_CONCIERGE_PER_FAMILY_PER_DAY = 200;
/** The same, for one sender's inbox at one family: a flood from one address. */
export const EMAIL_CONCIERGE_PER_SENDER_PER_DAY = 40;
/** Auto-replies one family address may send in a day, across every sender. */
export const EMAIL_REPLY_PER_FAMILY_PER_DAY = 20;
/**
 * Auto-replies one sender's inbox may draw from one family in a day. Not one —
 * a teacher who mails twice is answered twice — but small enough that a
 * responder which ignores Auto-Submitted cannot keep a loop going.
 */
export const EMAIL_REPLY_PER_SENDER_PER_DAY = 3;
/**
 * The most of the inbound subject that is echoed into the reply's. The inbound
 * cap is 1,000 (MAX_SUBJECT); a Bubaly-signed subject line carries far less of a
 * stranger's text than that.
 */
export const MAX_REPLY_SUBJECT = 80;

/**
 * Headers sent on every auto-reply, so a compliant remote responder (RFC 3834,
 * Exchange's X-Auto-Response-Suppress, the Precedence convention) does not
 * answer it — the half of the loop guard that lives on OUR side.
 */
export const AUTO_REPLY_HEADERS: Readonly<Record<string, string>> = {
  'Auto-Submitted': 'auto-replied',
  'X-Auto-Response-Suppress': 'All',
  Precedence: 'auto_reply',
};

/**
 * What a message is filed as when the concierge is withheld: the same
 * deterministic verdict `runConcierge` falls back to when no AI is configured.
 */
export function withheldConcierge(text: string, familyLabel: string | undefined): ConciergeResult {
  const label = safeContactText(familyLabel || 'the family', 200);
  const intent = classifyIntent(text);
  return { intent, summary: summarizeInbound(text), reply: safeContactText(autoReplyText(intent, label), 320), aiUsed: false };
}

/** A raw header blob is bounded before it is parsed; a provider never sends more. */
const MAX_HEADER_BLOB = 64 * 1024;

function headerLines(blob: string): [string, string][] {
  const out: [string, string][] = [];
  // Unfold RFC 5322 continuation lines (a line starting with whitespace).
  const unfolded = blob.slice(0, MAX_HEADER_BLOB).replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    out.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return out;
}

/** The [name, value] pairs of a structured header list, whatever shape the provider chose. */
function headerPairs(value: unknown): [string, string][] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      // Mailgun's `message-headers`: a JSON string of [name, value] pairs.
      try { return headerPairs(JSON.parse(trimmed.slice(0, MAX_HEADER_BLOB))); } catch { return []; }
    }
    return headerLines(value);
  }
  if (Array.isArray(value)) {
    const out: [string, string][] = [];
    for (const item of value.slice(0, 500)) {
      if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') out.push([item[0], item[1]]);
      else if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const name = record.Name ?? record.name ?? record.key;
        const content = record.Value ?? record.value;
        if (typeof name === 'string' && typeof content === 'string') out.push([name, content]);
      }
    }
    return out;
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  }
  return [];
}

/**
 * Every value of a header, by case-insensitive name, wherever the provider put
 * it: a top-level field (Mailgun, Cloudflare), a raw `headers` blob (SendGrid
 * Inbound Parse), a structured `Headers` list (Postmark) or Mailgun's
 * `message-headers` JSON. Empty when the header is absent everywhere.
 */
export function inboundHeaderValues(fields: InboundFields, name: string): string[] {
  const wanted = name.toLowerCase();
  const out: string[] = [];
  const take = (key: string, value: string) => {
    if (key.trim().toLowerCase() === wanted && value.trim()) out.push(value.trim());
  };
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') take(key, value);
  }
  for (const key of ['headers', 'Headers', 'message-headers']) {
    for (const [headerName, value] of headerPairs(fields[key])) take(headerName, value);
  }
  return out;
}

/**
 * Mail that announces itself as automatic, or as list traffic, is never
 * answered: `Auto-Submitted` other than `no` (RFC 3834), a bulk/list/junk/
 * auto-reply `Precedence`, Exchange's `X-Auto-Response-Suppress`, the
 * `X-Autoreply`/`X-Autorespond` conventions, and anything carrying a `List-Id`
 * or `List-Unsubscribe`. Answering any of these is how a loop starts.
 */
export function isAutomatedInbound(fields: InboundFields): boolean {
  if (inboundHeaderValues(fields, 'auto-submitted').some((value) => value.toLowerCase() !== 'no')) return true;
  if (inboundHeaderValues(fields, 'precedence').some((value) => /^(bulk|list|junk|auto[-_]reply)$/i.test(value))) return true;
  return ['x-auto-response-suppress', 'x-autoreply', 'x-autorespond', 'list-id', 'list-unsubscribe']
    .some((name) => inboundHeaderValues(fields, name).length > 0);
}

type AuthKind = 'spf' | 'dkim' | 'dmarc' | 'arc';
const RESULT_WORD = /\b(pass|fail|softfail|hardfail|neutral|none|temperror|permerror|policy)\b/i;

function resultOf(value: string): string | null {
  const match = RESULT_WORD.exec(value);
  return match ? match[1].toLowerCase() : null;
}

/**
 * TRUE when the provider stated an authentication result and it was not a pass.
 *
 * Nothing stated is not a failure: a provider that sends no result cannot be
 * judged, and the reply still goes out (having the provider forward its
 * SPF/DKIM/DMARC verdict is the owner action beside this fix). When results are
 * present, DMARC decides if it is there (it already weighs SPF and DKIM against
 * the From domain); otherwise at least one of SPF or DKIM must have passed.
 * Field names cover SendGrid Inbound Parse (`SPF`, `dkim`), Mailgun
 * (`X-Mailgun-Spf`, `X-Mailgun-Dkim-Check-Result`) and the standard
 * `Authentication-Results` header any relay may add (RFC 8601).
 */
export function inboundAuthenticationFailed(fields: InboundFields): boolean {
  const results: { kind: AuthKind; result: string }[] = [];
  const add = (kind: AuthKind, values: string[]) => {
    for (const value of values) {
      // SendGrid's dkim field is `{@domain : pass}`, one entry per signature.
      for (const part of value.split(/[{}]/)) {
        const result = resultOf(part);
        if (result) results.push({ kind, result });
      }
    }
  };
  add('spf', inboundHeaderValues(fields, 'spf'));
  add('spf', inboundHeaderValues(fields, 'x-mailgun-spf'));
  add('dkim', inboundHeaderValues(fields, 'dkim'));
  add('dkim', inboundHeaderValues(fields, 'x-mailgun-dkim-check-result'));
  for (const header of inboundHeaderValues(fields, 'authentication-results')) {
    for (const match of header.matchAll(/\b(spf|dkim|dmarc|arc)\s*=\s*([a-z]+)/gi)) {
      results.push({ kind: match[1].toLowerCase() as AuthKind, result: match[2].toLowerCase() });
    }
  }
  if (results.length === 0) return false;
  const dmarc = results.filter((r) => r.kind === 'dmarc');
  if (dmarc.length) return !dmarc.some((r) => r.result === 'pass');
  const aligned = results.filter((r) => r.kind === 'spf' || r.kind === 'dkim');
  if (aligned.length) return !aligned.some((r) => r.result === 'pass');
  return !results.some((r) => r.result === 'pass');
}

// The same mailbox grammar lib/server/email.ts accepts for a sender domain,
// bounded to RFC 5321's 254-octet address length.
const MAILBOX = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/i;
const MAX_MAILBOX = 254;

/**
 * Exactly one RFC-shaped mailbox from a From/Reply-To header, or null.
 *
 * `Name <a@x>` and `a@x` are one mailbox. A list (`a@x, b@y`, two bracketed
 * addresses, trailing text after the bracket), group syntax, a display name
 * alone, an empty `<>` envelope sender, a control character or anything else
 * the grammar does not recognise is null — and the route then files the
 * message without replying, rather than guessing whom to mail from the
 * family's address.
 */
export function parseSingleMailbox(header: string | null | undefined): string | null {
  if (typeof header !== 'string') return null;
  const value = header.trim();
  if (!value || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) return null;
  const bracketed = [...value.matchAll(/<([^<>]*)>/g)];
  let address: string;
  if (bracketed.length > 1) return null;
  if (bracketed.length === 1) {
    if (value.slice(value.indexOf('>') + 1).trim()) return null;
    address = bracketed[0][1].trim();
  } else {
    if (/[\s,;:<>]/.test(value)) return null;
    address = value;
  }
  return address.length <= MAX_MAILBOX && MAILBOX.test(address) ? address : null;
}

/** Every address-shaped token in a header, for a check that must see them all. */
function everyMailboxIn(header: string): string[] {
  return [...header.matchAll(/[^\s<>,;"']+@[^\s<>,;"']+/g)].map((m) => m[0].replace(/[.)]+$/, ''));
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase().replace(/\.+$/, '');
}

/**
 * The product's own sender mailbox, from the configured `Name <addr>` or bare
 * address. A reply to it would land in Bubaly's own inbox, not a person's.
 */
function productMailbox(configuredSender: string): string | null {
  const configured = configuredSender.trim();
  const inner = /^[^<>\r\n]*<([^<>\s]+)>$/.exec(configured)?.[1] ?? configured;
  return MAILBOX.test(inner) ? inner.toLowerCase() : null;
}

/** An address the product must never auto-reply to: its own domain, or its own sender. */
export function isOwnAddress(address: string, configuredSender: string): boolean {
  if (domainOf(address) === BUBALY_DOMAIN) return true;
  const own = productMailbox(configuredSender);
  return own !== null && address.toLowerCase() === own;
}

/** Mailboxes nobody reads replies at: bounce and no-reply conventions, and a kid login's synthetic address. */
export function isSystemMailbox(address: string): boolean {
  if (isChildLoginEmail(address)) return true;
  const local = address.slice(0, address.lastIndexOf('@')).toLowerCase();
  return /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)(\+.*)?$/.test(local);
}

export type AutoReplyRefusal = 'no_sender' | 'automated' | 'authentication_failed' | 'not_one_mailbox' | 'own_address' | 'system_mailbox';
export type AutoReplyDecision = { ok: true; to: string } | { ok: false; reason: AutoReplyRefusal };

/**
 * Whom the courteous auto-reply may go to, or why it goes to nobody.
 *
 * The message is filed either way; only the reply is withheld. The order is
 * cheapest-first and each refusal names its rule, so the route can log why no
 * acknowledgement went out without logging the sender.
 */
export function decideAutoReplyRecipient(fields: InboundFields, from: string | null, configuredSender: string): AutoReplyDecision {
  if (!from) return { ok: false, reason: 'no_sender' };
  if (isAutomatedInbound(fields)) return { ok: false, reason: 'automated' };
  if (inboundAuthenticationFailed(fields)) return { ok: false, reason: 'authentication_failed' };
  const to = parseSingleMailbox(from);
  if (!to) return { ok: false, reason: 'not_one_mailbox' };
  // A Reply-To on our own domain, or at the product's own sender, is a loop
  // waiting to be closed by the next hop, whatever the From says.
  const replyTo = inboundHeaderValues(fields, 'reply-to').flatMap(everyMailboxIn);
  if ([to, ...replyTo].some((address) => isOwnAddress(address, configuredSender))) return { ok: false, reason: 'own_address' };
  if (isSystemMailbox(to)) return { ok: false, reason: 'system_mailbox' };
  return { ok: true, to };
}
