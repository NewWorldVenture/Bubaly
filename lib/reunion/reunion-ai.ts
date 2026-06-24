export type ReunionInsights = {
  totalReunions: number;
  totalGuests: number;
  summary: string;
};

export interface ReunionForAI {
  title: string;
  start_date: string | null;
  end_date: string | null;
  location: string | null;
  guest_count: number;
}

export function analyzeReunions(reunions: ReunionForAI[]): ReunionInsights {
  let totalGuests = 0;
  for (const r of reunions) {
    totalGuests += r.guest_count;
  }

  const summary = reunions.length === 0
    ? 'No family reunions planned yet.'
    : `${reunions.length} reunion${reunions.length > 1 ? 's' : ''} planned. ${totalGuests} total guests.`;

  return { totalReunions: reunions.length, totalGuests, summary };
}

export function buildReunionPrompt(reunions: ReunionForAI[]) {
  const system = `You are a family reunion planner. Analyze reunion data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"planningTips":["..."],"activityIdea":"..."}
suggestions: up to 4 actionable ideas. planningTips: up to 3 tips. activityIdea: one fun reunion activity idea.`;

  const user = `Reunions:\n${JSON.stringify(reunions.slice(0, 50))}`;
  return { system, user };
}

export type ReunionAIResponse = {
  suggestions: string[];
  planningTips: string[];
  activityIdea: string;
};

export function parseReunionResponse(raw: string): ReunionAIResponse {
  const empty: ReunionAIResponse = { suggestions: [], planningTips: [], activityIdea: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4) : [],
      planningTips: Array.isArray(parsed.planningTips) ? parsed.planningTips.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
      activityIdea: typeof parsed.activityIdea === 'string' ? parsed.activityIdea : '',
    };
  } catch { return empty; }
}
