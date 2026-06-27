// lib/autopilot/twin.ts — the Family Digital Twin's behavioral learning layer.
//
// Pure + testable. Turns each member's real history into reliability traits
// ("who forgets chores", "who's dependable"), then exposes a confidence/urgency
// adjustment the autopilot applies per suggestion. This is how the twin makes
// the autopilot smarter over time: a member who routinely misses chores gets
// nudged harder + earlier; a dependable one gets nagged less.

export type MemberHistory = {
  memberId: string;
  choresCompleted: number;
  choresTotal: number;
};

export type MemberTraits = {
  memberId: string;
  choreCompletionRate: number; // 0..1
  reliabilityScore: number;    // 0..100, general dependability
  sampleSize: number;          // total observations behind the score
};

/** Minimum observations before we trust a trait enough to act on it. */
export const MIN_SAMPLE = 5;

export function computeMemberTraits(history: MemberHistory[]): MemberTraits[] {
  return history.map((h) => {
    const rate = h.choresTotal > 0 ? h.choresCompleted / h.choresTotal : 1;
    return {
      memberId: h.memberId,
      choreCompletionRate: rate,
      reliabilityScore: Math.round(rate * 100),
      sampleSize: h.choresTotal,
    };
  });
}

export type TraitAdjustment = { confidenceDelta: number; urgencyDelta: number };

/**
 * How a member's traits should bend a suggestion of a given kind. Only acts
 * once there's enough history (MIN_SAMPLE); otherwise no change.
 */
export function confidenceAdjustment(traits: MemberTraits | undefined, kind: string): TraitAdjustment {
  const none: TraitAdjustment = { confidenceDelta: 0, urgencyDelta: 0 };
  if (!traits || traits.sampleSize < MIN_SAMPLE) return none;

  // Chore nudges: lean on the member's actual follow-through.
  if (kind === 'chore') {
    if (traits.choreCompletionRate < 0.5) return { confidenceDelta: 8, urgencyDelta: 1 };   // forgetful → nudge harder/earlier
    if (traits.choreCompletionRate > 0.85) return { confidenceDelta: -4, urgencyDelta: -1 }; // dependable → ease off
  }

  // For time-sensitive personal items, a historically-unreliable member warrants
  // a slightly stronger nudge.
  if ((kind === 'appointment' || kind === 'medication') && traits.reliabilityScore < 50) {
    return { confidenceDelta: 5, urgencyDelta: 1 };
  }

  return none;
}

export function clampConfidence(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function clampUrgency(n: number): 1 | 2 | 3 {
  return (n <= 1 ? 1 : n >= 3 ? 3 : 2) as 1 | 2 | 3;
}
