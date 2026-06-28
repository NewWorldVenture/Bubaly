// App Lock — an OPT-IN 4-digit PIN that gates the app for casual privacy (handing
// your phone to a kid, leaving it on the counter). It is NOT a server security
// boundary — the real boundary is the Supabase session/RLS. The PIN is salted +
// SHA-256 hashed on the client; the plaintext never leaves the device. A 4-digit
// PIN is low-entropy by nature, so this is convenience, not cryptographic secrecy.

export type AppLockConfig = {
  enabled: boolean;
  salt: string;
  hash: string;
};

export function isAppLockConfig(v: unknown): v is AppLockConfig {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.enabled === 'boolean' && typeof o.salt === 'string' && typeof o.hash === 'string';
}

/** A 4-digit numeric PIN (exactly 4 digits). */
export function isValidPin(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 16-byte random salt as hex. Uses Web Crypto (browser + Node 20). */
export function randomSalt(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Salted SHA-256 of the PIN. Deterministic for a given (pin, salt). */
export async function hashPin(pin: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${pin}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(digest);
}

/** True when `pin` matches the stored salted hash. */
export async function verifyPin(pin: string, cfg: { salt: string; hash: string }): Promise<boolean> {
  if (!isValidPin(pin)) return false;
  const h = await hashPin(pin, cfg.salt);
  return h === cfg.hash;
}

/** Build a fresh config from a plaintext PIN (client-side; PIN never persisted). */
export async function buildAppLockConfig(pin: string): Promise<AppLockConfig> {
  const salt = randomSalt();
  const hash = await hashPin(pin, salt);
  return { enabled: true, salt, hash };
}

// Session-scoped unlock flag — once unlocked, stays unlocked until the tab/session
// ends (or sign-out). Per-user so switching accounts re-locks.
export const unlockKey = (userId: string) => `bubaly_applock_unlocked_${userId}`;
