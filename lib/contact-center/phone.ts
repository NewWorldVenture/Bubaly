// Pure phone helpers for the Contact Center. Client-safe. Reuses the display
// formatter from the Guardian layer and adds E.164 normalization/validation for
// the dedicated family number. Tested in tests/contact-center-phone.test.ts.

export { formatPhone } from '@/lib/guardian/phone';

/** Normalize loose input to E.164, assuming a default country calling code
 *  (US "1") for bare 10-digit numbers. Returns null when it can't. */
export function toE164(input: string | null | undefined, defaultCc = '1'): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  if (hadPlus) return isE164(`+${digits}`) ? `+${digits}` : null;
  if (digits.length === 10) return isE164(`+${defaultCc}${digits}`) ? `+${defaultCc}${digits}` : null;
  if (digits.length === 11 && digits.startsWith(defaultCc)) return `+${digits}`;
  // Already includes a country code (11–15 digits) → assume E.164 without the +.
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** True for a well-formed E.164 number (+ then 8–15 digits, no leading zero). */
export function isE164(value: string | null | undefined): boolean {
  return !!value && /^\+[1-9]\d{7,14}$/.test(value);
}

/**
 * The family's urgent fallback number as it must be STORED.
 *
 * Everything downstream of that column requires E.164 and has no way to say so:
 * the urgent-SMS escalation hands the stored string to the provider, which
 * refuses anything else outright (and the refusal surfaces nowhere in the app),
 * and the value is also interpolated into the TwiML `<Dial>` for a forwarded
 * call. A parent typing the field's own placeholder — "+1 555 123 4567" — was
 * therefore saved successfully and silently never called.
 *
 * So: strip the spacing and punctuation a person types around a number, and
 * REFUSE what cannot be read as an international number rather than storing it
 * and failing later.
 *
 * The country code is REQUIRED, deliberately — this does NOT use `toE164`'s
 * "ten digits means +1" default. For this field that guess is not a harmless
 * convenience: Bubaly ships it-IT, es-MX and nine other catalogues; an Italian
 * mobile typed the local way ("312 345 6789") is ten digits with no leading
 * zero, and "+13123456789" is a real Chicago number. The provider would accept
 * the family's urgent text and deliver it to a stranger — a worse failure than
 * the silent one this fixes. Nothing available here can say which country a
 * bare local number belongs to (the reader's locale is a language choice, and
 * the family's own line is always a US Twilio number), so the one form that
 * carries its own country is the one accepted, and the refusal copy asks for
 * exactly that. Letters are refused too: "+1 555 CALL MOM" is not a number the
 * parent meant, and dropping the letters would store one they did not type.
 */
export function normalizeFallbackPhone(
  input: string | null | undefined,
): { ok: true; value: string | null } | { ok: false } {
  if (input === null || input === undefined) return { ok: true, value: null };
  const typed = input.trim();
  if (!typed) return { ok: true, value: null };
  // A plus, then digits and the spacing/punctuation people put between them.
  // Mirrored in supabase/migrations/0384 for the rows written before this.
  if (!/^\+[\d\s().-]+$/.test(typed)) return { ok: false };
  const e164 = `+${typed.replace(/\D/g, '')}`;
  return isE164(e164) ? { ok: true, value: e164 } : { ok: false };
}
