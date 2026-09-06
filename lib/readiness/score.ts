// Household ACTIVITY scoring — pure, unit tested, no dependencies.
// A lightweight 0–100 score derived from real activity, shown to Free users to
// create demand for the Plus "Stress" / "Operations" scores.
//
// NOT §51's readiness, though the file is named `readiness` and sits beside it.
// This answers "how much is this family running through Bubaly" — meals
// planned, calendar current, chores kept on top of. §51's question is "is
// anything still open for tomorrow, this week, this month", and it lives in
// `./assess.ts`. The two ran side by side on the Family Readiness page under
// one word, so a household could read "78 · Looking good" above
// "40 · Not ready" and reasonably think one of them was wrong. They measure
// different things and the page now says which is which; keep it that way.

export type ReadinessInput = {
  choresOverdue: number;
  remindersOverdue: number;
  /** Days in the next week that have a planned meal (0–7). */
  mealsPlanned: number;
  /** Events scheduled in the next 7 days. */
  eventsUpcoming: number;
  activeMembers: number;
};

export type ReadinessFactor = { label: string; delta: number; good: boolean };
export type ReadinessBand = 'great' | 'good' | 'attention' | 'at_risk';

export type Readiness = {
  score: number;
  band: ReadinessBand;
  factors: ReadinessFactor[];
};

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export function bandFor(score: number): ReadinessBand {
  if (score >= 80) return 'great';
  if (score >= 60) return 'good';
  if (score >= 40) return 'attention';
  return 'at_risk';
}

export const BAND_LABEL: Record<ReadinessBand, string> = {
  great: 'On top of it', good: 'Looking good', attention: 'Needs attention', at_risk: 'Falling behind',
};

export function computeReadiness(input: ReadinessInput): Readiness {
  const factors: ReadinessFactor[] = [];
  let score = 70;

  const mealPts = Math.min(input.mealsPlanned, 7) * 2;
  if (mealPts > 0) { score += mealPts; factors.push({ label: `${input.mealsPlanned} day(s) of meals planned`, delta: mealPts, good: true }); }

  if (input.eventsUpcoming > 0) { score += 8; factors.push({ label: 'Calendar is up to date', delta: 8, good: true }); }
  if (input.activeMembers > 1) { score += 8; factors.push({ label: 'Whole family is on board', delta: 8, good: true }); }

  if (input.choresOverdue > 0) {
    const d = -Math.min(input.choresOverdue, 10) * 3;
    score += d; factors.push({ label: `${input.choresOverdue} overdue chore(s)`, delta: d, good: false });
  }
  if (input.remindersOverdue > 0) {
    const d = -Math.min(input.remindersOverdue, 10) * 2;
    score += d; factors.push({ label: `${input.remindersOverdue} overdue reminder(s)`, delta: d, good: false });
  }
  if (input.mealsPlanned === 0) factors.push({ label: 'No meals planned this week', delta: 0, good: false });

  score = clamp(Math.round(score));
  factors.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { score, band: bandFor(score), factors };
}
