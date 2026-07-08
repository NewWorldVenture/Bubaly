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
