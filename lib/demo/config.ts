// lib/demo/config.ts — pure demo-session constants + countdown math (unit-tested).
// No server/DB deps so the timer component and tests import it freely.

export const DEMO_TTL_MINUTES = 5;
export const DEMO_EMAIL_DOMAIN = 'demo.bubaly.app';

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
