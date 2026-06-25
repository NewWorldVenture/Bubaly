// lib/guardian/trust.ts — Family Trust Graph™ trust levels and scoring.

export type TrustLevel =
  | 'immediate_family'
  | 'close_family'
  | 'trusted_friend'
  | 'known_contact'
  | 'unknown'
  | 'suspected_spam'
  | 'blocked';

export const TRUST_LEVELS: TrustLevel[] = [
  'immediate_family',
  'close_family',
  'trusted_friend',
  'known_contact',
  'unknown',
  'suspected_spam',
  'blocked',
];

export const TRUST_LABELS: Record<TrustLevel, string> = {
  immediate_family: 'Immediate Family',
  close_family: 'Close Family',
  trusted_friend: 'Trusted Friend',
  known_contact: 'Known Contact',
  unknown: 'Unknown',
  suspected_spam: 'Suspected Spam',
  blocked: 'Blocked',
};

export const TRUST_ICONS: Record<TrustLevel, string> = {
  immediate_family: '★★★★★',
  close_family: '★★★★',
  trusted_friend: '★★★',
  known_contact: '★★',
  unknown: '★',
  suspected_spam: '⚠',
  blocked: '❌',
};

export const TRUST_COLORS: Record<TrustLevel, string> = {
  immediate_family: 'text-emerald-500',
  close_family: 'text-green-500',
  trusted_friend: 'text-blue-500',
  known_contact: 'text-sky-500',
  unknown: 'text-amber-500',
  suspected_spam: 'text-orange-500',
  blocked: 'text-red-500',
};

export const TRUST_BG_COLORS: Record<TrustLevel, string> = {
  immediate_family: 'bg-emerald-500/10 border-emerald-500/30',
  close_family: 'bg-green-500/10 border-green-500/30',
  trusted_friend: 'bg-blue-500/10 border-blue-500/30',
  known_contact: 'bg-sky-500/10 border-sky-500/30',
  unknown: 'bg-amber-500/10 border-amber-500/30',
  suspected_spam: 'bg-orange-500/10 border-orange-500/30',
  blocked: 'bg-red-500/10 border-red-500/30',
};

/** Numeric rank for comparison — higher = more trusted. */
export const TRUST_RANK: Record<TrustLevel, number> = {
  immediate_family: 6,
  close_family: 5,
  trusted_friend: 4,
  known_contact: 3,
  unknown: 2,
  suspected_spam: 1,
  blocked: 0,
};

/** True if the trust level warrants immediate ring-through. */
export function shouldRingImmediately(level: TrustLevel): boolean {
  return ['immediate_family', 'close_family', 'trusted_friend'].includes(level);
}

/** True if the number should be blocked without any interaction. */
export function isBlocked(level: TrustLevel): boolean {
  return level === 'blocked';
}

/** True if AI screening is appropriate before routing. */
export function requiresScreening(level: TrustLevel): boolean {
  return ['known_contact', 'unknown', 'suspected_spam'].includes(level);
}

/**
 * Infer trust level from spam score (0-100).
 * Used when no explicit contact record exists.
 */
export function trustFromSpamScore(score: number): TrustLevel {
  if (score >= 90) return 'blocked';
  if (score >= 70) return 'suspected_spam';
  if (score >= 40) return 'unknown';
  return 'unknown';
}

/**
 * Produce a plain-English description of why a routing decision was made.
 * Used for Explainable AI display in the app.
 */
export function explainTrustDecision(
  trust: TrustLevel,
  name: string | null,
  spamScore: number,
): string {
  const who = name ?? 'This caller';
  if (trust === 'immediate_family') return `${who} is in your Immediate Family — always rings through.`;
  if (trust === 'close_family') return `${who} is a Close Family member — rings through immediately.`;
  if (trust === 'trusted_friend') return `${who} is a Trusted Friend — rings through immediately.`;
  if (trust === 'known_contact') return `${who} is a Known Contact — AI screens first, then connects.`;
  if (trust === 'suspected_spam') return `${who} has a spam score of ${spamScore}/100 — Bubaly handled it silently.`;
  if (trust === 'blocked') return `${who} is blocked — call was ended immediately.`;
  return `${who} is an unknown caller — Bubaly screened the call and will summarize.`;
}
