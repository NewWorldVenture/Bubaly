export type BehaviorInsights = {
  totalEntries: number;
  positiveCount: number;
  negativeCount: number;
  totalPoints: number;
  categoryCounts: Record<string, number>;
  summary: string;
};

export interface BehaviorEntryForAI {
  kind: string;
  category: string;
  points: number;
  occurred_at: string;
}

export function analyzeBehavior(entries: BehaviorEntryForAI[]): BehaviorInsights {
  const categoryCounts: Record<string, number> = {};
  let positiveCount = 0;
  let negativeCount = 0;
  let totalPoints = 0;

  for (const e of entries) {
    categoryCounts[e.category] = (categoryCounts[e.category] ?? 0) + 1;
    if (e.kind === 'positive') positiveCount++;
    else negativeCount++;
    totalPoints += e.points;
  }

  const total = entries.length;
  const topCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none';
  const summary = total === 0
    ? 'No behavior entries logged yet.'
    : `${total} entries: ${positiveCount} positive, ${negativeCount} negative. ${totalPoints} total points. Top category: ${topCategory}.`;

  return { totalEntries: total, positiveCount, negativeCount, totalPoints, categoryCounts, summary };
}

export function buildBehaviorPrompt(entries: BehaviorEntryForAI[]) {
  const system = `You are a family behavior coach. Analyze behavior log data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"encouragementTips":["..."],"patternInsight":"..."}
suggestions: up to 4 actionable ideas. encouragementTips: up to 3 tips. patternInsight: one sentence about patterns.`;

  const user = `Behavior log entries:\n${JSON.stringify(entries.slice(0, 50))}`;
  return { system, user };
}

export type BehaviorAIResponse = {
  suggestions: string[];
  encouragementTips: string[];
  patternInsight: string;
};

export function parseBehaviorResponse(raw: string): BehaviorAIResponse {
  const empty: BehaviorAIResponse = { suggestions: [], encouragementTips: [], patternInsight: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      encouragementTips: Array.isArray(parsed.encouragementTips)
        ? parsed.encouragementTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      patternInsight: typeof parsed.patternInsight === 'string' ? parsed.patternInsight : '',
    };
  } catch {
    return empty;
  }
}
