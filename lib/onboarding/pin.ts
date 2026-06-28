// lib/onboarding/pin.ts — pure PIN validation helpers (no crypto here so this is
// safe to import on the client). Hashing/verification live server-side in the
// onboarding action. The 4-digit PIN keeps a member's profile private on a shared
// device (mockup: "Create a PIN for Jordan").

/** Keep only digits, max 4 — for controlled PIN inputs. */
export function normalizePin(input: string): string {
  return (input ?? '').replace(/\D/g, '').slice(0, 4);
}

/** Exactly four digits. */
export function isValidPin(input: string): boolean {
  return /^\d{4}$/.test(input ?? '');
}

/** Trivially-guessable PINs (all-same or a strict run) — flagged, not blocked. */
export function isWeakPin(pin: string): boolean {
  if (!isValidPin(pin)) return false;
  if (/^(\d)\1{3}$/.test(pin)) return true;          // 0000, 1111, …
  return '0123456789'.includes(pin) || '9876543210'.includes(pin); // 1234, 4321, …
}

/** Normalize an "age" answer into a sane integer (1–120) or null. */
export function normalizeAge(input: unknown): number | null {
  const n = typeof input === 'number' ? input : parseInt(String(input ?? ''), 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) return null;
  return Math.trunc(n);
}
