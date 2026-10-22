// lib/server/canonical-mailbox.ts — the INBOX an address delivers to, for
// per-recipient throttles only. Pure, so it is unit-testable in isolation.
//
// A throttle keyed on the address as typed counts `victim+1@gmail.com`,
// `victim+2@gmail.com` and `v.ictim@gmail.com` as three recipients, and every
// one of them lands in the same inbox. That is how the blog subscribe form's
// per-address mail limit was walked around one `+tag` at a time (it says
// "rotating IPs does not lift it" — rotating sub-addresses did), and how the
// public contact and form endpoints would have been, had they had one.
//
// So the key folds what a mail provider folds: case, a `+suffix` on the local
// part, and — for Gmail, which ignores them — dots and the googlemail alias. A
// trailing dot on the domain (an FQDN spelling the same host) is dropped too.
//
// It is a KEY, never an address to store or to send to: the row keeps what the
// person typed, and mail goes to that.

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** The canonical inbox of an address, for keying a per-recipient limit. */
export function canonicalMailbox(email: string): string {
  const lowered = email.trim().toLowerCase();
  const at = lowered.lastIndexOf('@');
  if (at <= 0 || at === lowered.length - 1) return lowered;
  let local = lowered.slice(0, at);
  let domain = lowered.slice(at + 1).replace(/\.+$/, '');
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com';
    local = local.replace(/\./g, '') || local;
  }
  return `${local}@${domain}`;
}
