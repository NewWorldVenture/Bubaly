export type CareInsights = {
  totalEntries: number;
  typeCounts: Record<string, number>;
  avgWellbeing: number | null;
  recentCount: number;
  summary: string;
};

export interface CareEntryForAI {
  log_type: string;
  occurred_at: string;
  wellbeing: number | null;
  note: string | null;
}

export function analyzeCare(entries: readonly CareEntryForAI[]): CareInsights {
  const typeCounts: Record<string, number> = {};
  let wellbeingSum = 0;
  let wellbeingCount = 0;
  let recentCount = 0;
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  for (const e of entries) {
    typeCounts[e.log_type] = (typeCounts[e.log_type] ?? 0) + 1;
    if (e.wellbeing != null) { wellbeingSum += e.wellbeing; wellbeingCount++; }
    if (new Date(e.occurred_at) >= weekAgo) recentCount++;
  }

  const avgWellbeing = wellbeingCount > 0 ? Math.round((wellbeingSum / wellbeingCount) * 10) / 10 : null;

  const parts: string[] = [];
  parts.push(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
  parts.push(`${recentCount} this week`);
  if (avgWellbeing != null) parts.push(`${avgWellbeing}/10 avg wellbeing`);

  return { totalEntries: entries.length, typeCounts, avgWellbeing, recentCount, summary: parts.join(' · ') };
}

export function buildCarePrompt(entries: readonly CareEntryForAI[]): { system: string; user: string } {
  const system = `You are the Bubaly family care coordinator. Analyze care log entries for elderly or loved-one care and suggest improvements. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable care suggestion"],
  "wellbeingTips": ["tip for improving care quality or wellbeing"],
  "coordinationTip": "one short tip for better care coordination"
}

Rules:
- suggestions: max 4 practical suggestions based on the care log
- wellbeingTips: max 3 tips for improving wellbeing or care quality
- coordinationTip: one concrete recommendation
- Focus on consistency of check-ins, wellbeing trends, and caregiver coordination.`;

  const entryList = entries.slice(0, 50).map((e) =>
    `${e.occurred_at.slice(0, 10)} ${e.log_type}${e.wellbeing != null ? ` (wellbeing: ${e.wellbeing}/10)` : ''}${e.note ? `: ${e.note}` : ''}`
  ).join('\n');
  const user = `The care log has ${entries.length} entries:\n\n${entryList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type CareAIResponse = {
  suggestions: string[];
  wellbeingTips: string[];
  coordinationTip: string;
};

export function parseCareResponse(raw: string): CareAIResponse {
  const empty: CareAIResponse = { suggestions: [], wellbeingTips: [], coordinationTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      wellbeingTips: Array.isArray(parsed.wellbeingTips)
        ? parsed.wellbeingTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      coordinationTip: typeof parsed.coordinationTip === 'string' ? parsed.coordinationTip : '',
    };
  } catch {
    return empty;
  }
}
