export type ScreenTimeInsights = {
  totalEntries: number;
  totalMinutes: number;
  avgMinutesPerDay: number;
  categoryBreakdown: Record<string, number>;
  summary: string;
};

export interface ScreenTimeEntryLike {
  entry_date: string;
  minutes: number;
  category: string;
  device: string | null;
}

export function analyzeScreenTime(entries: readonly ScreenTimeEntryLike[]): ScreenTimeInsights {
  let totalMinutes = 0;
  const categoryBreakdown: Record<string, number> = {};
  const days = new Set<string>();

  for (const e of entries) {
    totalMinutes += e.minutes;
    categoryBreakdown[e.category] = (categoryBreakdown[e.category] ?? 0) + e.minutes;
    days.add(e.entry_date);
  }

  const avgMinutesPerDay = days.size > 0 ? Math.round(totalMinutes / days.size) : 0;

  const parts: string[] = [];
  parts.push(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
  parts.push(`${totalMinutes} total minutes`);
  parts.push(`~${avgMinutesPerDay} min/day avg`);

  return { totalEntries: entries.length, totalMinutes, avgMinutesPerDay, categoryBreakdown, summary: parts.join(' · ') };
}

export function buildScreenTimePrompt(entries: readonly ScreenTimeEntryLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family screen-time advisor. Analyze screen-time entries and suggest healthy balance improvements. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable screen-time suggestion"],
  "balanceTips": ["tip for healthier screen-time balance"],
  "limitAdvice": "one short piece of advice about screen-time limits"
}

Rules:
- suggestions: max 4 practical suggestions based on current usage
- balanceTips: max 3 tips for balancing screen time with other activities
- limitAdvice: one concrete recommendation
- Focus on age-appropriate limits, productive vs entertainment balance, and healthy habits.`;

  const entryList = entries.map((e) =>
    `${e.entry_date}: ${e.minutes}min ${e.category}${e.device ? ` (${e.device})` : ''}`
  ).join('\n');
  const user = `The family has ${entries.length} screen-time entries:\n\n${entryList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type ScreenTimeAIResponse = {
  suggestions: string[];
  balanceTips: string[];
  limitAdvice: string;
};

export function parseScreenTimeResponse(raw: string): ScreenTimeAIResponse {
  const empty: ScreenTimeAIResponse = { suggestions: [], balanceTips: [], limitAdvice: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      balanceTips: Array.isArray(parsed.balanceTips)
        ? parsed.balanceTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      limitAdvice: typeof parsed.limitAdvice === 'string' ? parsed.limitAdvice : '',
    };
  } catch {
    return empty;
  }
}
