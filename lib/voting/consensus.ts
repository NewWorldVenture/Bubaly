// lib/voting/consensus.ts — AI-facilitated group consensus (pure, DB-free, tested).
//
// Group Voting is a democratic signal: what the family *wants*. But the choice
// that wins the vote isn't always the one that *works* — it may blow the budget
// or ignore a dietary need. This module facilitates consensus by blending two
// signals over the same poll options:
//
//   1. the democratic signal — the vote tally (what everyone prefers), and
//   2. the objective fit — the pure Decision Engine scoring the options on
//      cost + travel, with hard budget / required-tag (e.g. dietary) vetoes.
//
// It returns a blended ranking, a recommendation (top *feasible* option), the
// raw vote leader, and explicit CONFLICTS when the two signals disagree
// ("the favorite is over budget", "votes lean X but Y fits better"). The AI
// recommends; the family still decides. Deterministic + side-effect free.

import { evaluateDecision, type OptionInput } from '@/lib/decisions/engine';

export type ConsensusOption = {
  id: string;
  label: string;
  votes: number;              // raw vote count for this option
  costCents?: number;         // lower is better
  travelMinutes?: number;     // lower is better
  tags?: string[];            // attributes, e.g. ['vegetarian','gluten-free']
};

export type ConsensusConstraints = {
  budgetCents?: number;       // hard cap — options above are infeasible
  maxTravelMinutes?: number;  // hard cap
  requiredTags?: string[];    // every feasible option must carry ALL of these
  /** Blend weight for the democratic (vote) signal, 0..1. Default 0.55 —
   *  the family's preference leads, objective fit refines. */
  voteWeight?: number;
};

export type ConsensusRanked = {
  id: string;
  label: string;
  votes: number;
  votePct: number;            // share of total votes cast (0..100)
  fitScore: number;           // objective fit 0..100 (Decision Engine)
  blendedScore: number;       // combined vote + fit, 0..100
  feasible: boolean;          // no hard-constraint violations
  violations: string[];       // human-readable breaches (budget / travel / tags)
  rationale: string;          // one-line "why"
};

export type ConsensusResult = {
  ranked: ConsensusRanked[];         // best first (feasible above infeasible)
  recommendation: ConsensusRanked | null; // top feasible by blended score
  voteLeader: ConsensusRanked | null;      // most-voted option (votes > 0)
  conflicts: string[];               // vote-vs-fit tensions worth surfacing
  consensusLevel: number;            // 0..1 agreement (leader's share of voters)
  totalVotes: number;
};

const DEFAULT_VOTE_WEIGHT = 0.55;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const round = (n: number) => Math.round(n);
const usd = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

/** Does an option carry every required tag? Case-insensitive; empty req = ok. */
function missingTags(optionTags: string[] | undefined, required: string[]): string[] {
  if (required.length === 0) return [];
  const have = new Set((optionTags ?? []).map((t) => t.trim().toLowerCase()));
  return required.filter((r) => !have.has(r.trim().toLowerCase()));
}

/**
 * Facilitate consensus over a poll's options.
 * Gracefully degrades: with no metrics/constraints the fit signal is uniform,
 * so the blend collapses to the pure vote ranking (never worse than voting).
 */
export function facilitateConsensus(
  options: ConsensusOption[],
  constraints: ConsensusConstraints = {},
): ConsensusResult {
  if (options.length === 0) {
    return { ranked: [], recommendation: null, voteLeader: null, conflicts: [], consensusLevel: 0, totalVotes: 0 };
  }

  const voteWeight = clamp01(constraints.voteWeight ?? DEFAULT_VOTE_WEIGHT);
  const totalVotes = options.reduce((s, o) => s + Math.max(0, o.votes), 0);
  const maxVotes = Math.max(0, ...options.map((o) => Math.max(0, o.votes)));

  // Objective fit from the shared Decision Engine (cost + travel only — the
  // democratic vote already carries "benefit"/preference).
  const engineInputs: OptionInput[] = options.map((o) => ({
    id: o.id,
    label: o.label,
    costCents: o.costCents,
    travelMinutes: o.travelMinutes,
  }));
  const engine = evaluateDecision(engineInputs, {
    budgetCents: constraints.budgetCents,
    maxTravelMinutes: constraints.maxTravelMinutes,
  });
  const fitById = new Map(engine.ranked.map((r) => [r.id, r]));
  const required = constraints.requiredTags ?? [];

  const ranked: ConsensusRanked[] = options.map((o) => {
    const fit = fitById.get(o.id);
    const fitScore = fit?.score ?? 50;
    const votePct = totalVotes ? round((o.votes / totalVotes) * 100) : 0;
    const voteNorm = maxVotes ? o.votes / maxVotes : 0; // relative to best-voted
    const blended = voteWeight * voteNorm + (1 - voteWeight) * (fitScore / 100);

    // Hard constraints: engine budget/travel breaches + required-tag misses.
    const violations = [...(fit?.violations ?? [])];
    const missing = missingTags(o.tags, required);
    if (missing.length) violations.push(`missing ${missing.join(', ')}`);
    const feasible = violations.length === 0;

    return {
      id: o.id,
      label: o.label,
      votes: o.votes,
      votePct,
      fitScore,
      blendedScore: round(blended * 100),
      feasible,
      violations,
      rationale: '',
    };
  });

  // Feasible first, then by blended score desc, then by votes desc.
  ranked.sort(
    (a, b) =>
      Number(b.feasible) - Number(a.feasible) ||
      b.blendedScore - a.blendedScore ||
      b.votes - a.votes,
  );
  for (const r of ranked) r.rationale = buildRationale(r, constraints);

  const recommendation = ranked.find((r) => r.feasible) ?? null;

  // Vote leader = most votes (>0); break ties by blended score.
  const voted = ranked.filter((r) => r.votes > 0);
  const voteLeader = voted.length
    ? [...voted].sort((a, b) => b.votes - a.votes || b.blendedScore - a.blendedScore)[0]
    : null;

  const conflicts = buildConflicts(recommendation, voteLeader);

  // Agreement: leader's share of the vote (concentrated = high consensus).
  const consensusLevel = totalVotes ? clamp01(maxVotes / totalVotes) : 0;

  return { ranked, recommendation, voteLeader, conflicts, consensusLevel, totalVotes };
}

function buildRationale(r: ConsensusRanked, c: ConsensusConstraints): string {
  if (!r.feasible) return `Doesn't fit: ${r.violations.join('; ')}.`;
  const parts: string[] = [];
  parts.push(r.votes > 0 ? `${r.votes} vote${r.votes === 1 ? '' : 's'} (${r.votePct}%)` : 'no votes yet');
  if (typeof c.budgetCents === 'number' && r.fitScore >= 60) parts.push('within budget');
  if (r.fitScore >= 70) parts.push('strong objective fit');
  else if (r.fitScore <= 35) parts.push('weaker on cost/travel');
  return `${parts.join(' · ')}.`;
}

function buildConflicts(
  recommendation: ConsensusRanked | null,
  voteLeader: ConsensusRanked | null,
): string[] {
  const conflicts: string[] = [];
  if (!voteLeader) return conflicts;

  // The favorite can't actually be chosen as-is.
  if (!voteLeader.feasible) {
    conflicts.push(
      `The current favorite “${voteLeader.label}” doesn't fit — ${voteLeader.violations.join('; ')}.` +
        (recommendation ? ` Closest workable pick: “${recommendation.label}”.` : ''),
    );
    return conflicts;
  }

  // Votes and objective fit point at different options.
  if (recommendation && recommendation.id !== voteLeader.id) {
    conflicts.push(
      `Votes lean toward “${voteLeader.label}”, but “${recommendation.label}” scores higher overall ` +
        `(${recommendation.blendedScore} vs ${voteLeader.blendedScore}) once budget and fit are weighed.`,
    );
  }
  return conflicts;
}

/** Map a decision category to the budget category keywords that fund it, so the
 *  reasoning layer can pull a real budget cap when the poll didn't set one. */
export const CATEGORY_BUDGET_KEYWORDS: Record<string, string[]> = {
  meal: ['dining', 'restaurant', 'food', 'groceries'],
  shopping: ['shopping', 'groceries', 'household'],
  vacation: ['travel', 'vacation', 'trip'],
  activity: ['entertainment', 'activities', 'fun'],
  general: [],
};

/** Best-matching monthly budget cap (in cents) for a decision category, from
 *  the family's real budgets. Returns undefined when nothing matches. */
export function budgetCapForCategory(
  category: string,
  budgets: { category: string; amount: number }[],
): number | undefined {
  const keywords = CATEGORY_BUDGET_KEYWORDS[category] ?? [];
  if (keywords.length === 0) return undefined;
  for (const kw of keywords) {
    const hit = budgets.find((b) => b.category.trim().toLowerCase().includes(kw));
    if (hit && typeof hit.amount === 'number') return Math.round(hit.amount * 100);
  }
  return undefined;
}
