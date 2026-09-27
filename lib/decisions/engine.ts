// Family Decision Engine (pure, unit-tested, DB-free).
//
// Many family decisions are trade-offs: which vacation fits budget AND calendar?
// which activity is worth the added load? which grocery run minimizes cost + travel?
// This scores options against weighted criteria + hard constraints, EXPLAINS the
// reasoning, flags constraint violations, and recommends — but the family decides.
// The engine is deterministic and pure; the server feeds it real context (budget,
// calendar load) and persists the chosen option.

import type { LocaleCode } from '@/lib/i18n/locales';
import { formatCents } from '@/lib/wallet/ledger';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export type Criterion = 'cost' | 'time' | 'travel' | 'load' | 'benefit';

/** One option under consideration. All metrics optional; missing = neutral. */
export type OptionInput = {
  id: string;
  label: string;
  costCents?: number;     // lower is better
  timeMinutes?: number;   // effort/duration — lower is better
  travelMinutes?: number; // lower is better
  loadDelta?: number;     // added burden on the family (0..100) — lower is better
  benefit?: number;       // upside/value (0..100) — higher is better
};

export type DecisionConstraints = {
  budgetCents?: number;        // hard cap — options above are flagged
  maxTravelMinutes?: number;   // hard cap — options above are flagged
  /** Relative importance per criterion (defaults below). Missing keys use the default. */
  weights?: Partial<Record<Criterion, number>>;
};

export type ScoredOption = {
  id: string;
  label: string;
  score: number;                       // 0..100, higher = better fit
  rationale: string;                   // human-readable "why"
  violations: string[];                // hard-constraint breaches
  breakdown: Record<Criterion, number>; // per-criterion normalized 0..1 (already polarity-corrected)
  feasible: boolean;                   // no hard violations
};

export type DecisionResult = {
  ranked: ScoredOption[];              // best first
  recommendation: ScoredOption | null; // top *feasible* option, or null
};

const DEFAULT_WEIGHTS: Record<Criterion, number> = {
  cost: 1, time: 0.7, travel: 0.7, load: 0.9, benefit: 1.2,
};
// Criteria where a LOWER raw value is better (inverted during normalization).
const LOWER_IS_BETTER: Record<Criterion, boolean> = {
  cost: true, time: true, travel: true, load: true, benefit: false,
};

const raw = (o: OptionInput, c: Criterion): number | undefined => {
  switch (c) {
    case 'cost': return o.costCents;
    case 'time': return o.timeMinutes;
    case 'travel': return o.travelMinutes;
    case 'load': return o.loadDelta;
    case 'benefit': return o.benefit;
  }
};

const CRITERIA: Criterion[] = ['cost', 'time', 'travel', 'load', 'benefit'];
const LABEL: Record<Criterion, string> = {
  cost: 'cost', time: 'effort', travel: 'travel', load: 'family load', benefit: 'benefit',
};

/**
 * Score + rank options. Each criterion is min-max normalized across the options
 * that provide it (so scores are relative to the real choice set), polarity-
 * corrected so 1 is always "good", then combined by weight. Options that breach a
 * hard cap are marked infeasible and pushed below every feasible option.
 */
/**
 * `locale` and `t` are the READER's, and required. A hard-constraint breach is
 * a sentence with money in it — "over budget by $120.00" — and it reaches two
 * screens: components/modules/decisions-module.tsx (useLocale / useTranslations)
 * and, through lib/voting/consensus.ts, components/modules/voting-module.tsx.
 * Both are client components with a reader; a default here is how one of them
 * would quietly stop passing it.
 */
export function evaluateDecision(
  options: OptionInput[],
  constraints: DecisionConstraints,
  locale: LocaleCode,
  t: Translate,
): DecisionResult {
  if (options.length === 0) return { ranked: [], recommendation: null };
  const weights = { ...DEFAULT_WEIGHTS, ...(constraints.weights ?? {}) };

  // Per-criterion min/max across options that supplied a value.
  const bounds = new Map<Criterion, { min: number; max: number }>();
  for (const c of CRITERIA) {
    const vals = options.map((o) => raw(o, c)).filter((v): v is number => typeof v === 'number');
    if (vals.length) bounds.set(c, { min: Math.min(...vals), max: Math.max(...vals) });
  }

  const scored: ScoredOption[] = options.map((o) => {
    const breakdown = {} as Record<Criterion, number>;
    let weightedSum = 0;
    let weightTotal = 0;
    for (const c of CRITERIA) {
      const v = raw(o, c);
      const b = bounds.get(c);
      if (typeof v !== 'number' || !b) { breakdown[c] = 0.5; continue; } // neutral if absent
      let norm = b.max === b.min ? 1 : (v - b.min) / (b.max - b.min); // 0..1, higher raw
      if (LOWER_IS_BETTER[c]) norm = 1 - norm;                        // flip so 1 = good
      breakdown[c] = round(norm);
      weightedSum += norm * weights[c];
      weightTotal += weights[c];
    }
    const score = weightTotal ? round((weightedSum / weightTotal) * 100) : 0;

    // Hard constraints.
    const violations: string[] = [];
    if (typeof constraints.budgetCents === 'number' && typeof o.costCents === 'number' && o.costCents > constraints.budgetCents) {
      // The reader's format — this was `$${(cents / 100).toFixed(2)}`, which has no
      // locale — and the sentence from the catalogue, not English around it. USD:
      // decision_options.cost_cents and family_decisions.budget_cents carry no
      // currency column, so the amounts are dollars of record.
      violations.push(t('decisionEngine.overBudgetBy', { amount: formatCents(o.costCents - constraints.budgetCents, 'USD', locale) }));
    }
    if (typeof constraints.maxTravelMinutes === 'number' && typeof o.travelMinutes === 'number' && o.travelMinutes > constraints.maxTravelMinutes) {
      // Worded by the catalogue too: it is joined into the SAME "Doesn't fit"
      // sentence as the budget breach, and half a translated sentence is worse
      // than none.
      violations.push(t('decisionEngine.overTravelLimit', { minutes: o.travelMinutes - constraints.maxTravelMinutes }));
    }

    return { id: o.id, label: o.label, score, breakdown, violations, feasible: violations.length === 0, rationale: '' };
  });

  // Rank: feasible first, then by score desc.
  scored.sort((a, b) => (Number(b.feasible) - Number(a.feasible)) || (b.score - a.score));

  // Rationale references each option's strongest + weakest polarity-corrected criteria.
  for (const s of scored) s.rationale = buildRationale(s, t);

  const recommendation = scored.find((s) => s.feasible) ?? null;
  return { ranked: scored, recommendation };
}

function buildRationale(s: ScoredOption, t: Translate): string {
  if (!s.feasible) return t('decisionEngine.doesNotFit', { reasons: s.violations.join('; ') });
  const present = CRITERIA.filter((c) => s.breakdown[c] !== 0.5);
  if (present.length === 0) return 'No metrics provided — needs more detail to compare.';
  const best = [...present].sort((a, b) => s.breakdown[b] - s.breakdown[a])[0];
  const worst = [...present].sort((a, b) => s.breakdown[a] - s.breakdown[b])[0];
  const parts = [`strong on ${LABEL[best]}`];
  if (worst !== best && s.breakdown[worst] < 0.4) parts.push(`weaker on ${LABEL[worst]}`);
  return `${parts.join(', ')}.`;
}

function round(n: number): number { return Math.round(n * 1000) / 1000; }

export const DECISION_CRITERIA = CRITERIA;
