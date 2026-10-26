// App Lock is an opt-in privacy screen, not an authorization boundary.
// Only server code builds, stores or verifies a PIN configuration. The browser
// receives status booleans and submits a PIN to rate-limited server actions.
// Supabase authentication/RLS still controls direct API and native access.

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
  return typeof pin === 'string' && pin.length === 4 && /^\d{4}$/.test(pin);
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

/** Build a fresh server-stored config; never send this verifier to a client. */
export async function buildAppLockConfig(pin: string): Promise<AppLockConfig> {
  if (!isValidPin(pin)) throw new Error('Invalid App Lock PIN');
  const salt = randomSalt();
  const hash = await hashPin(pin, salt);
  return { enabled: true, salt, hash };
}
