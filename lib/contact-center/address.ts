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

/** A local-part is valid when it fits the length + shape rules. */
export function isValidEmailLocal(local: string): boolean {
  return local.length >= LOCAL_MIN && local.length <= LOCAL_MAX && LOCAL_RE.test(local);
}

/** Suggest a local-part from a family name, e.g. "The Smith Family" → "smith". */
export function suggestEmailLocal(familyName: string | null | undefined): string {
  const base = normalizeEmailLocal(
    (familyName ?? '')
      .replace(/\bthe\b/gi, '')
      .replace(/\bfamily\b/gi, '')
      .trim(),
  );
  if (isValidEmailLocal(base)) return base;
  // Pad short/empty names so the suggestion is always usable.
  return normalizeEmailLocal((base + 'family').padEnd(LOCAL_MIN, 'x')).slice(0, LOCAL_MAX);
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
