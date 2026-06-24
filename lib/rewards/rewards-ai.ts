export type RewardsInsights = {
  totalRewards: number;
  redeemedCount: number;
  totalPoints: number;
  summary: string;
};

export interface RewardForAI {
  title: string;
  cost_points: number;
  redeemed_at: string | null;
}

export function analyzeRewards(rewards: RewardForAI[]): RewardsInsights {
  let redeemedCount = 0;
  let totalPoints = 0;

  for (const r of rewards) {
    totalPoints += r.cost_points;
    if (r.redeemed_at) redeemedCount++;
  }

  const summary = rewards.length === 0
    ? 'No rewards created yet.'
    : `${rewards.length} rewards available. ${redeemedCount} redeemed. ${totalPoints} total points in the system.`;

  return { totalRewards: rewards.length, redeemedCount, totalPoints, summary };
}

export function buildRewardsPrompt(rewards: RewardForAI[]) {
  const system = `You are a family rewards advisor. Analyze reward data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"motivationTips":["..."],"rewardIdea":"..."}
suggestions: up to 4 actionable ideas. motivationTips: up to 3 tips. rewardIdea: one new reward idea.`;

  const user = `Rewards:\n${JSON.stringify(rewards.slice(0, 50))}`;
  return { system, user };
}

export type RewardsAIResponse = {
  suggestions: string[];
  motivationTips: string[];
  rewardIdea: string;
};

export function parseRewardsResponse(raw: string): RewardsAIResponse {
  const empty: RewardsAIResponse = { suggestions: [], motivationTips: [], rewardIdea: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4) : [],
      motivationTips: Array.isArray(parsed.motivationTips) ? parsed.motivationTips.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
      rewardIdea: typeof parsed.rewardIdea === 'string' ? parsed.rewardIdea : '',
    };
  } catch { return empty; }
}
