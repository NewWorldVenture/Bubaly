// lib/wallet/gift.ts — pure helpers for grandparent/relative gifting. Token
// generation lives server-side (crypto); these functions parse + validate the
// public-form inputs so the logic is unit-tested.

export const GIFT_MIN_CENTS = 100;        // $1 minimum
export const GIFT_MAX_CENTS = 100_000;    // $1,000 cap per gift (anti-abuse)
export const DEFAULT_SUGGESTED_CENTS = [2500, 5000, 10000];

export const GIFT_OCCASIONS = ['birthday', 'holiday', 'graduation', 'just_because'] as const;
export type GiftOccasion = (typeof GIFT_OCCASIONS)[number];

/** Parse a "25, 50, 100" dollar string into an ascending, de-duped cents array. */
export function parseSuggestedAmounts(input: string): number[] {
  const cents = (input ?? '')
    .split(/[,\s]+/)
    .map((s) => Number(s.replace(/[^0-9.]/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.round(n * 100))
    .filter((c) => c >= GIFT_MIN_CENTS && c <= GIFT_MAX_CENTS);
  return Array.from(new Set(cents)).sort((a, b) => a - b).slice(0, 6);
}

/** Clamp a gift amount to the allowed range; returns null if out of bounds. */
export function clampGiftAmountCents(cents: number): number | null {
  const c = Math.round(cents);
  if (!Number.isFinite(c) || c < GIFT_MIN_CENTS || c > GIFT_MAX_CENTS) return null;
  return c;
}

export function isValidOccasion(value: string | null | undefined): value is GiftOccasion {
  return !!value && (GIFT_OCCASIONS as readonly string[]).includes(value);
}

/** Public path for a gift link. */
export function giftPath(token: string): string {
  return `/gift/${token}`;
}

/** A friendly label for an occasion. */
export function occasionLabel(occasion: string | null): string {
  switch (occasion) {
    case 'birthday': return '🎂 Birthday';
    case 'holiday': return '🎄 Holiday';
    case 'graduation': return '🎓 Graduation';
    case 'just_because': return '💝 Just because';
    default: return 'Gift';
  }
}
