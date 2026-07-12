// lib/demo/config.ts — pure demo-session constants + countdown math (unit-tested).
// No server/DB deps so the timer component and tests import it freely.

export const DEMO_TTL_MINUTES = 5;
export const DEMO_EMAIL_DOMAIN = 'demo.bubaly.app';

// The single, shared demo account everyone logs into (there is exactly one — no
// throwaway per-visitor users). Its family is looked up by this exact name, and
// the name is shown on login ("Welcome Bubaly Demo Account").
export const DEMO_ACCOUNT_NAME = 'Bubaly Demo Account';
// The prior name — migrated to DEMO_ACCOUNT_NAME on the next demo login so the
// existing shared account (and its data) carries over instead of being orphaned.
export const DEMO_ACCOUNT_LEGACY_NAME = 'Bubaly Demo';
export const DEMO_ACCOUNT_EMAIL = `demo@${DEMO_EMAIL_DOMAIN}`;

/** When a demo session created `now` should expire. */
export function demoExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + DEMO_TTL_MINUTES * 60_000);
}

/** Whole seconds remaining until `expiresAt` (never negative). */
export function demoSecondsLeft(expiresAt: string | Date, now: Date = new Date()): number {
  const end = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(end.getTime())) return 0;
  return Math.max(0, Math.round((end.getTime() - now.getTime()) / 1000));
}

/** Seconds → "M:SS". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Pragmatic "looks like an email" check for the demo gate (server-side — the
 *  form's `required`/`type=email` are client-only and bypassable). */
export function isLikelyEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s ?? '').trim());
}

/**
 * One demo per email: true when the email's recorded demo window (its FIRST
 * demo's expiry, from demo_email_uses) has already passed — meaning the email
 * has used up its allowance and must be routed to the upgrade page. A missing /
 * unparsable record means "not used up" (fail open: the gate must never lock out
 * a first-time visitor over bad data).
 */
export function isDemoEmailUsedUp(priorExpiresAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!priorExpiresAt) return false;
  const t = new Date(priorExpiresAt).getTime();
  return !Number.isNaN(t) && t <= now.getTime();
}
