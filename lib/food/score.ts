// lib/food/score.ts — the Family Food Health Score engine. PURE + tested.
//
// Bubaly's proprietary food metric. Seven sub-scores, each 0–100, computed from
// data the family already has (planned meals, nutrition estimates, pantry state,
// budget, ratings). The overall score is a weighted average of whichever
// sub-scores have enough data, with a letter grade and AI-style coaching.
//
// No I/O — the dashboard derives the numeric inputs from Supabase and passes
// them here, so the whole thing is deterministic and unit-testable.

import type { Nutrition } from '@/lib/meals/nutrition';
import { DAILY_VALUES } from '@/lib/meals/nutrition';

export type FoodScoreKey =
  | 'planning' | 'variety' | 'nutrition' | 'waste' | 'pantry' | 'budget' | 'satisfaction';

export interface FoodScoreInput {
  /** Slots filled with a meal this week (e.g. dinners planned). */
  plannedSlots: number;
  /** Total slots in the planning window (e.g. 7 dinners). */
  totalSlots: number;
  /** Distinct dish names planned this week (variety). */
  distinctDishes: number;
  /** Per-day average nutrition for the week, if estimated. */
  perDayNutrition?: Nutrition | null;
  /** Pantry totals. */
  pantryTotal: number;
  pantryExpired: number;
  pantryExpiringSoon: number;
  /** Planned meals that use an expiring pantry item (waste avoidance). */
  plannedUsingExpiring: number;
  /** Planned weekly food cost vs. the household budget (cents). */
  plannedCostCents?: number | null;
  weeklyBudgetCents?: number | null;
  /** Average family rating/vote of planned dishes, 0–5. */
  avgRating?: number | null;
}

export interface SubScore {
  key: FoodScoreKey;
  label: string;
  score: number;            // 0–100
  detail: string;
}

export interface FoodScore {
  overall: number;          // 0–100
  grade: string;            // A+ … F
  subScores: SubScore[];    // only the ones we had data for
  coaching: string[];       // prioritized, actionable tips
  headline: string;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

const LABELS: Record<FoodScoreKey, string> = {
  planning: 'Meal Prep', variety: 'Variety', nutrition: 'Nutrition', waste: 'Food Waste',
  pantry: 'Pantry Efficiency', budget: 'Budget', satisfaction: 'Family Satisfaction',
};

// Relative weights toward the overall score.
const WEIGHTS: Record<FoodScoreKey, number> = {
  nutrition: 1.4, planning: 1.2, waste: 1.1, budget: 1.0, variety: 0.9, pantry: 0.9, satisfaction: 1.0,
};

/** Nutrition balance 0–100 from per-day averages vs. reference daily values.
 *  Rewards hitting protein + fiber; penalizes excess sodium + sugar; keeps
 *  calories in a sane band. Returns null when there's no estimate. */
export function nutritionBalanceScore(perDay: Nutrition | null | undefined): number | null {
  if (!perDay) return null;
  const adequacy = (val: number, target: number) => Math.min(1, val / Math.max(1, target));
  // Good to meet these:
  const protein = adequacy(perDay.protein_g, DAILY_VALUES.protein_g);
  const fiber = adequacy(perDay.fiber_g, DAILY_VALUES.fiber_g);
  // Good to stay under these (over the DV is penalized):
  const sodiumOver = Math.max(0, perDay.sodium_mg / DAILY_VALUES.sodium_mg - 1);
  const sugarOver = Math.max(0, perDay.sugar_g / DAILY_VALUES.sugar_g - 1);
  // Calorie band: within 70–115% of DV is ideal.
  const calRatio = perDay.calories / DAILY_VALUES.calories;
  const calPenalty = calRatio < 0.7 ? (0.7 - calRatio) : calRatio > 1.15 ? (calRatio - 1.15) : 0;

  let score = 100;
  score -= (1 - protein) * 25;
  score -= (1 - fiber) * 20;
  score -= Math.min(1, sodiumOver) * 25;
  score -= Math.min(1, sugarOver) * 20;
  score -= Math.min(1, calPenalty) * 20;
  return clamp(score);
}

export function computeFoodScore(input: FoodScoreInput): FoodScore {
  const subs: SubScore[] = [];

  // Planning / meal-prep coverage.
  if (input.totalSlots > 0) {
    const s = clamp((input.plannedSlots / input.totalSlots) * 100);
    subs.push({ key: 'planning', label: LABELS.planning, score: s,
      detail: `${input.plannedSlots} of ${input.totalSlots} slots planned` });
  }

  // Variety — distinct dishes vs. planned slots.
  if (input.plannedSlots > 0) {
    const s = clamp((input.distinctDishes / input.plannedSlots) * 100);
    subs.push({ key: 'variety', label: LABELS.variety, score: s,
      detail: `${input.distinctDishes} distinct ${input.distinctDishes === 1 ? 'dish' : 'dishes'}` });
  }

  // Nutrition balance.
  const nutritionScore = nutritionBalanceScore(input.perDayNutrition);
  if (nutritionScore != null) {
    subs.push({ key: 'nutrition', label: LABELS.nutrition, score: nutritionScore,
      detail: `${Math.round(input.perDayNutrition!.calories)} kcal/day avg` });
  }

  // Food waste — expired + expiring items drag it down.
  if (input.pantryTotal > 0) {
    const expiredPenalty = (input.pantryExpired / input.pantryTotal) * 120; // expired hurts most
    const expiringPenalty = (Math.max(0, input.pantryExpiringSoon - input.plannedUsingExpiring) / input.pantryTotal) * 50;
    const s = clamp(100 - expiredPenalty - expiringPenalty);
    subs.push({ key: 'waste', label: LABELS.waste, score: s,
      detail: input.pantryExpired > 0 ? `${input.pantryExpired} expired item${input.pantryExpired === 1 ? '' : 's'}` : 'Nothing wasted' });
  }

  // Pantry efficiency — are we using up the food that's about to expire?
  if (input.pantryExpiringSoon > 0) {
    const s = clamp((input.plannedUsingExpiring / input.pantryExpiringSoon) * 100);
    subs.push({ key: 'pantry', label: LABELS.pantry, score: s,
      detail: `${input.plannedUsingExpiring}/${input.pantryExpiringSoon} expiring items planned in` });
  }

  // Budget — under budget is 100; overage scales the penalty.
  if (input.weeklyBudgetCents && input.weeklyBudgetCents > 0 && input.plannedCostCents != null) {
    const ratio = input.plannedCostCents / input.weeklyBudgetCents;
    const s = clamp(ratio <= 1 ? 100 : 100 - (ratio - 1) * 100);
    subs.push({ key: 'budget', label: LABELS.budget, score: s,
      detail: `$${(input.plannedCostCents / 100).toFixed(0)} of $${(input.weeklyBudgetCents / 100).toFixed(0)} budget` });
  }

  // Family satisfaction — average rating out of 5.
  if (input.avgRating != null && input.avgRating > 0) {
    const s = clamp((input.avgRating / 5) * 100);
    subs.push({ key: 'satisfaction', label: LABELS.satisfaction, score: s,
      detail: `${input.avgRating.toFixed(1)}★ avg` });
  }

  const overall = weightedOverall(subs);
  const coaching = buildCoaching(subs, input);

  return {
    overall,
    grade: gradeFor(overall),
    subScores: subs,
    coaching,
    headline: headlineFor(overall, subs),
  };
}

function weightedOverall(subs: SubScore[]): number {
  if (subs.length === 0) return 0;
  let sum = 0, wsum = 0;
  for (const s of subs) {
    const w = WEIGHTS[s.key];
    sum += s.score * w; wsum += w;
  }
  return clamp(sum / wsum);
}

export function gradeFor(score: number): string {
  if (score >= 97) return 'A+';
  if (score >= 93) return 'A';
  if (score >= 90) return 'A−';
  if (score >= 87) return 'B+';
  if (score >= 83) return 'B';
  if (score >= 80) return 'B−';
  if (score >= 77) return 'C+';
  if (score >= 73) return 'C';
  if (score >= 70) return 'C−';
  if (score >= 60) return 'D';
  return 'F';
}

function buildCoaching(subs: SubScore[], input: FoodScoreInput): string[] {
  const tips: string[] = [];
  const by = new Map(subs.map((s) => [s.key, s]));

  const planning = by.get('planning');
  if (planning && planning.score < 80) {
    tips.push(`Plan the rest of the week — ${input.totalSlots - input.plannedSlots} slot${input.totalSlots - input.plannedSlots === 1 ? '' : 's'} still open. Ask the AI Chef to fill them.`);
  }
  if (input.pantryExpired > 0) {
    tips.push(`${input.pantryExpired} pantry item${input.pantryExpired === 1 ? '' : 's'} already expired — clear them and log any leftovers to cut waste.`);
  }
  const pantry = by.get('pantry');
  if (pantry && pantry.score < 70 && input.pantryExpiringSoon > 0) {
    tips.push(`${input.pantryExpiringSoon - input.plannedUsingExpiring} expiring item${input.pantryExpiringSoon - input.plannedUsingExpiring === 1 ? '' : 's'} aren't in any meal yet — cook with them this week.`);
  }
  const nutrition = by.get('nutrition');
  if (nutrition && nutrition.score < 75 && input.perDayNutrition) {
    if (input.perDayNutrition.protein_g < DAILY_VALUES.protein_g) tips.push('Protein is running low — add a lean protein to a couple of dinners.');
    else if (input.perDayNutrition.fiber_g < DAILY_VALUES.fiber_g) tips.push('Add more fiber — beans, whole grains, or a veggie side a few nights.');
    else if (input.perDayNutrition.sodium_mg > DAILY_VALUES.sodium_mg) tips.push('Sodium is high this week — favor fresh over packaged for a couple of meals.');
  }
  const budget = by.get('budget');
  if (budget && budget.score < 75) tips.push('Over budget — ask the AI Chef to re-plan a cheaper week using pantry staples.');
  const variety = by.get('variety');
  if (variety && variety.score < 60) tips.push('Lots of repeats — mix in a new recipe or two for variety.');

  if (tips.length === 0) tips.push("Your family's eating well this week — keep it up! 🎉");
  return tips.slice(0, 4);
}

function headlineFor(overall: number, subs: SubScore[]): string {
  if (subs.length === 0) return 'Plan a few meals to see your Family Food Health Score.';
  if (overall >= 90) return 'Your family is eating exceptionally well this week.';
  if (overall >= 80) return 'Solid week of eating — a couple of easy wins left.';
  if (overall >= 70) return 'Decent week — a little planning will push this higher.';
  if (overall >= 60) return 'Some gaps this week — the AI Chef can help close them.';
  return "Let's get this week on track — start with the tips below.";
}
