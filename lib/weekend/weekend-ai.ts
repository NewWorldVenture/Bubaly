export type WeekendInsights = {
  totalEvents: number;
  totalPlans: number;
  categoryCounts: Record<string, number>;
  summary: string;
};

export interface WeekendEventForAI {
  title: string;
  category: string | null;
  venue_name: string | null;
  city: string | null;
  starts_at: string | null;
  is_family_friendly: boolean;
}

export function analyzeWeekend(events: WeekendEventForAI[], planCount: number): WeekendInsights {
  const categoryCounts: Record<string, number> = {};
  for (const e of events) {
    const cat = e.category || 'other';
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
  }

  const summary = events.length === 0
    ? 'No weekend events discovered yet.'
    : `${events.length} events found, ${planCount} planned. ${Object.keys(categoryCounts).length} categories.`;

  return { totalEvents: events.length, totalPlans: planCount, categoryCounts, summary };
}

export function buildWeekendPrompt(events: WeekendEventForAI[]) {
  const system = `You are a family weekend planner. Analyze weekend event data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"activityTips":["..."],"familyIdea":"..."}
suggestions: up to 4 actionable ideas. activityTips: up to 3 tips. familyIdea: one creative family weekend idea.`;

  const user = `Weekend events:\n${JSON.stringify(events.slice(0, 50))}`;
  return { system, user };
}

export type WeekendAIResponse = {
  suggestions: string[];
  activityTips: string[];
  familyIdea: string;
};

export function parseWeekendResponse(raw: string): WeekendAIResponse {
  const empty: WeekendAIResponse = { suggestions: [], activityTips: [], familyIdea: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4) : [],
      activityTips: Array.isArray(parsed.activityTips) ? parsed.activityTips.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
      familyIdea: typeof parsed.familyIdea === 'string' ? parsed.familyIdea : '',
    };
  } catch { return empty; }
}
