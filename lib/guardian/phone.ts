// lib/guardian/phone.ts — pure, client-safe phone formatting. Kept separate from
// lib/guardian/twilio.ts (which pulls in node crypto + the Twilio REST client and
// must never enter the browser bundle) so client components can format numbers.

/** Format a phone number for display, e.g. "+15551234567" → "(555) 123-4567". */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return 'Unknown';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    const d = digits.slice(1);
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

/**
 * A number in E.164 (`+` and 8–15 digits), or null when it is not one.
 *
 * Used where a stored number is DIALLED rather than displayed. The 10- and
 * 11-digit NANP assumptions mirror `formatPhone` above rather than inventing a
 * second convention; anything else must already carry its country code.
 *
 * Returning null for junk is the point: `forward_to_phone` was written to the
 * database with no trim, no cap and no shape, and it ends up inside a `<Dial>`
 * verb. Audit C1-S7-05.
 */
export function toE164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}
