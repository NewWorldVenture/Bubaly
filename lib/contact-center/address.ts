// Pure helpers for a family's central @bubaly.com contact address. Client-safe
// (no server-only imports) so the Contact Center controls can validate inline.
// Tested in tests/contact-center-address.test.ts.

export const BUBALY_DOMAIN = 'bubaly.com';

const LOCAL_MIN = 3;
const LOCAL_MAX = 30;
// Allowed local-part: lowercase letters, digits, dot/dash/underscore; must start
// and end with an alphanumeric (no leading/trailing/doubled separators).
const LOCAL_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** Normalize free text toward a valid local-part (lowercase, strip junk). */
export function normalizeEmailLocal(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '')      // drop disallowed chars
    .replace(/[._-]{2,}/g, '.')          // collapse runs of separators
    .replace(/^[._-]+|[._-]+$/g, '')     // trim leading/trailing separators
    .slice(0, LOCAL_MAX);
}

/**
 * Local-parts a family must never be able to claim.
 *
 * The address space is ONE namespace shared with the company: every family
 * address is `<local>@bubaly.com`, the same domain the product itself sends and
 * receives on. So claiming the wrong local-part does not just look official —
 * it REDIRECTS real mail. Three kinds have to be held back:
 *
 *   1. Role addresses the operator reads (support, billing, security, admin).
 *      A family holding these receives mail customers and vendors intended for
 *      Bubaly — including account-recovery links for services registered to the
 *      domain.
 *   2. RFC 2142 / RFC 2821 addresses the domain is REQUIRED to answer
 *      (postmaster, abuse, hostmaster, webmaster). Losing these breaks
 *      deliverability and the ability to receive abuse reports.
 *   3. The product's own sending identities (noreply, notifications, alerts…).
 *      EMAIL_FROM is an address on this domain, so a family claiming its
 *      local-part would receive the bounces and replies to Bubaly's own
 *      transactional mail.
 *
 * Held back rather than merely discouraged: uniqueness alone does not help,
 * because the FIRST family to ask would get it.
 */
export const RESERVED_EMAIL_LOCALS: ReadonlySet<string> = new Set([
  // 1 — operator role addresses
  'admin', 'administrator', 'support', 'help', 'helpdesk', 'contact', 'info',
  'billing', 'invoices', 'accounts', 'payments', 'sales', 'security', 'legal',
  'privacy', 'press', 'careers', 'jobs', 'team', 'staff', 'office',
  // 2 — RFC 2142 / RFC 2821 required and conventional
  'postmaster', 'abuse', 'hostmaster', 'webmaster', 'usenet', 'news', 'uucp',
  'ftp', 'www', 'mail', 'mailer', 'mailer-daemon', 'daemon', 'root',
  // 3 — the product's own sending identities and reserved surface
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'notifications',
  'notification', 'alerts', 'alert', 'system', 'bot', 'robot', 'auto',
  'bubaly', 'bubalyteam', 'bubalysupport', 'api', 'dev', 'test', 'staging',
  'onboarding', 'welcome', 'verify', 'verification', 'confirm', 'password',
  'reset', 'account', 'accounts-noreply', 'concierge', 'assistant', 'ai',
]);

/**
 * Is this local-part reserved? Compared after normalisation, and with
 * separators stripped, so `s-u-p-p-o-r-t` and `s.upport` cannot walk around the
 * list — the delivered mailbox is what matters, not the spelling used to ask.
 */
export function isReservedEmailLocal(local: string): boolean {
  const normalized = normalizeEmailLocal(local);
  if (RESERVED_EMAIL_LOCALS.has(normalized)) return true;
  return RESERVED_EMAIL_LOCALS.has(normalized.replace(/[._-]/g, ''));
}

/** A local-part is valid when it fits the length + shape rules. */
export function isValidEmailLocal(local: string): boolean {
  return local.length >= LOCAL_MIN && local.length <= LOCAL_MAX && LOCAL_RE.test(local);
}

/**
 * May a family CLAIM this local-part? Shape plus the reserved namespace.
 *
 * Separate from `isValidEmailLocal`, which answers a different question: whether
 * a string is a well-formed local-part at all. Inbound routing still has to
 * recognise a reserved address as valid so mail to `support@` resolves and can
 * be handled — it simply must never resolve to a FAMILY.
 */
export function isClaimableEmailLocal(local: string): boolean {
  return isValidEmailLocal(local) && !isReservedEmailLocal(local);
}

/** Suggest a local-part from a family name, e.g. "The Smith Family" → "smith". */
export function suggestEmailLocal(familyName: string | null | undefined): string {
  const base = normalizeEmailLocal(
    (familyName ?? '')
      .replace(/\bthe\b/gi, '')
      .replace(/\bfamily\b/gi, '')
      .trim(),
  );
  // A family literally called "Support" must not be HANDED support@bubaly.com.
  // Suffixing keeps the suggestion recognisable while leaving the namespace.
  if (isValidEmailLocal(base) && !isReservedEmailLocal(base)) return base;
  const padded = normalizeEmailLocal((base + 'family').padEnd(LOCAL_MIN, 'x')).slice(0, LOCAL_MAX);
  if (isValidEmailLocal(padded) && !isReservedEmailLocal(padded)) return padded;
  return normalizeEmailLocal(`${padded}home`).slice(0, LOCAL_MAX);
}

/** The full address for a local-part, e.g. "smith" → "smith@bubaly.com". */
export function buildBubalyAddress(local: string): string {
  return `${local}@${BUBALY_DOMAIN}`;
}

/** The full address for a channel row, or null when unassigned. */
export function channelAddress(local: string | null | undefined): string | null {
  return local ? buildBubalyAddress(local) : null;
}

/**
 * Extract the bubaly.com local-part from a raw inbound "To" header, which may be
 * a bare address, a "Name <addr>" form, or a comma-separated list. Returns the
 * first bubaly.com recipient's local-part (lowercased), or null if none.
 */
export function parseRecipientLocal(toHeader: string | null | undefined): string | null {
  if (!toHeader) return null;
  const re = new RegExp(`([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)@${BUBALY_DOMAIN.replace('.', '\\.')}`, 'i');
  const match = toHeader.match(re);
  return match ? match[1].toLowerCase() : null;
}
