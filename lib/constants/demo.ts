// lib/constants/demo.ts — demo-mode constants + helpers (pure, tested).
//
// The 5 seed "demo families" exist solely for showcasing the product. When the
// active family is one of them, the app shows a polished session countdown (the
// Demo Timer) and — where relevant — demo affordances. Real families never match,
// so nothing here affects normal accounts.

/** The seed demo family ids (see supabase/seed_prod.sql). */
export const DEMO_FAMILY_IDS: ReadonlySet<string> = new Set([
  '11111111-1111-1111-1111-111111111111', // The Patel Family (primary demo)
  '22222222-2222-2222-2222-222222222222', // The Nguyen Family
  '33333333-3333-3333-3333-333333333333', // The Garcia Family
  '44444444-4444-4444-4444-444444444444', // The Johnson Family
  '55555555-5555-5555-5555-555555555555', // The Okafor Family
]);

/** The family the curated demo dataset targets. */
export const PRIMARY_DEMO_FAMILY_ID = '11111111-1111-1111-1111-111111111111';

/** True when a family id is one of the demo families. */
export function isDemoFamily(familyId: string | null | undefined): boolean {
  return !!familyId && DEMO_FAMILY_IDS.has(familyId);
}

/** Length of a demo session, in seconds (the timer counts down from here). */
export const DEMO_SESSION_SECONDS = 300; // 5:00

/** Zero-padded mm / ss parts for a countdown display. */
export function formatMMSS(totalSeconds: number): { mm: string; ss: string } {
  const s = Math.max(0, Math.floor(totalSeconds));
  return {
    mm: String(Math.floor(s / 60)).padStart(2, '0'),
    ss: String(s % 60).padStart(2, '0'),
  };
}

/** Seconds left in a demo session given its start time (never negative). */
export function remainingSeconds(startMs: number, nowMs: number, total = DEMO_SESSION_SECONDS): number {
  return Math.max(0, total - Math.floor((nowMs - startMs) / 1000));
}
