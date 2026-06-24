export type TripMemoriesInsights = {
  totalMemories: number;
  locationCounts: Record<string, number>;
  summary: string;
};

export interface TripMemoryForAI {
  title: string;
  location: string | null;
  memory_date: string | null;
  note: string | null;
}

export function analyzeTripMemories(memories: TripMemoryForAI[]): TripMemoriesInsights {
  const locationCounts: Record<string, number> = {};
  for (const m of memories) {
    const loc = m.location || 'Unknown';
    locationCounts[loc] = (locationCounts[loc] ?? 0) + 1;
  }

  const summary = memories.length === 0
    ? 'No trip memories saved yet.'
    : `${memories.length} memories across ${Object.keys(locationCounts).length} location${Object.keys(locationCounts).length > 1 ? 's' : ''}.`;

  return { totalMemories: memories.length, locationCounts, summary };
}

export function buildTripMemoriesPrompt(memories: TripMemoryForAI[]) {
  const system = `You are a family travel advisor. Analyze trip memory data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"travelTips":["..."],"memoryIdea":"..."}
suggestions: up to 4 actionable ideas. travelTips: up to 3 tips. memoryIdea: one idea for capturing future trip memories.`;

  const user = `Trip memories:\n${JSON.stringify(memories.slice(0, 50))}`;
  return { system, user };
}

export type TripMemoriesAIResponse = {
  suggestions: string[];
  travelTips: string[];
  memoryIdea: string;
};

export function parseTripMemoriesResponse(raw: string): TripMemoriesAIResponse {
  const empty: TripMemoriesAIResponse = { suggestions: [], travelTips: [], memoryIdea: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4) : [],
      travelTips: Array.isArray(parsed.travelTips) ? parsed.travelTips.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
      memoryIdea: typeof parsed.memoryIdea === 'string' ? parsed.memoryIdea : '',
    };
  } catch { return empty; }
}
