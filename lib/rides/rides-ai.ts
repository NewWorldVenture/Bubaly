export type RidesInsights = {
  totalRides: number;
  upcomingCount: number;
  needsDriverCount: number;
  completedCount: number;
  summary: string;
};

export interface RideEntryLike {
  title: string;
  ride_date: string;
  pickup_time: string | null;
  dropoff_time: string | null;
  pickup_location: string | null;
  dropoff_location: string | null;
  driver_id: string | null;
  status: string;
}

export function analyzeRides(rides: readonly RideEntryLike[]): RidesInsights {
  let upcomingCount = 0;
  let needsDriverCount = 0;
  let completedCount = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (const r of rides) {
    if (r.status === 'completed') {
      completedCount++;
    } else if (r.status !== 'cancelled') {
      if (r.ride_date >= today) upcomingCount++;
      if (!r.driver_id) needsDriverCount++;
    }
  }

  const parts: string[] = [];
  parts.push(`${rides.length} ride${rides.length === 1 ? '' : 's'}`);
  parts.push(`${upcomingCount} upcoming`);
  parts.push(`${completedCount} completed`);
  if (needsDriverCount > 0) parts.push(`${needsDriverCount} need a driver`);

  return { totalRides: rides.length, upcomingCount, needsDriverCount, completedCount, summary: parts.join(' · ') };
}

export function buildRidesPrompt(rides: readonly RideEntryLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family carpool coordinator. Analyze the family's rides and suggest scheduling improvements. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable ride coordination suggestion"],
  "carpoolIdeas": ["idea for optimizing carpooling or ride sharing"],
  "scheduleTip": "one short tip for better ride scheduling"
}

Rules:
- suggestions: max 4 practical suggestions based on current rides
- carpoolIdeas: max 3 ideas for combining rides or coordinating with other families
- scheduleTip: one concrete tip
- Focus on reducing trips, ensuring drivers are assigned, and optimizing pickup/dropoff logistics.`;

  const rideList = rides.map((r) =>
    `${r.title} (${r.ride_date}, ${r.status}${r.pickup_time ? `, pickup: ${r.pickup_time}` : ''}${r.pickup_location ? `, from: ${r.pickup_location}` : ''}${r.dropoff_location ? `, to: ${r.dropoff_location}` : ''}${r.driver_id ? '' : ', NO DRIVER'})`
  ).join('\n');
  const user = `The family has ${rides.length} rides:\n\n${rideList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type RidesAIResponse = {
  suggestions: string[];
  carpoolIdeas: string[];
  scheduleTip: string;
};

export function parseRidesResponse(raw: string): RidesAIResponse {
  const empty: RidesAIResponse = { suggestions: [], carpoolIdeas: [], scheduleTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      carpoolIdeas: Array.isArray(parsed.carpoolIdeas)
        ? parsed.carpoolIdeas.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      scheduleTip: typeof parsed.scheduleTip === 'string' ? parsed.scheduleTip : '',
    };
  } catch {
    return empty;
  }
}
