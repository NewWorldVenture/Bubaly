export type SportsInsights = {
  totalEvents: number;
  sportCounts: Record<string, number>;
  upcomingCount: number;
  summary: string;
};

export interface SportsEventForAI {
  sport: string | null;
  title: string;
  event_type: string | null;
  starts_at: string;
}

export function analyzeSports(events: SportsEventForAI[]): SportsInsights {
  const sportCounts: Record<string, number> = {};
  let upcomingCount = 0;
  const now = new Date();

  for (const e of events) {
    const sport = e.sport || 'general';
    sportCounts[sport] = (sportCounts[sport] ?? 0) + 1;
    if (new Date(e.starts_at) > now) upcomingCount++;
  }

  const summary = events.length === 0
    ? 'No sports events tracked yet.'
    : `${events.length} events across ${Object.keys(sportCounts).length} sports. ${upcomingCount} upcoming.`;

  return { totalEvents: events.length, sportCounts, upcomingCount, summary };
}

export function buildSportsPrompt(events: SportsEventForAI[]) {
  const system = `You are a family sports coordinator. Analyze sports event data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"scheduleTips":["..."],"fitnessTip":"..."}
suggestions: up to 4 actionable ideas. scheduleTips: up to 3 tips. fitnessTip: one sentence about staying active.`;

  const user = `Sports events:\n${JSON.stringify(events.slice(0, 50))}`;
  return { system, user };
}

export type SportsAIResponse = {
  suggestions: string[];
  scheduleTips: string[];
  fitnessTip: string;
};

export function parseSportsResponse(raw: string): SportsAIResponse {
  const empty: SportsAIResponse = { suggestions: [], scheduleTips: [], fitnessTip: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4) : [],
      scheduleTips: Array.isArray(parsed.scheduleTips) ? parsed.scheduleTips.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
      fitnessTip: typeof parsed.fitnessTip === 'string' ? parsed.fitnessTip : '',
    };
  } catch { return empty; }
}
