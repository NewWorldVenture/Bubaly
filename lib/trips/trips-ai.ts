export type TripInsights = {
  totalTrips: number;
  upcomingTrips: number;
  completedTrips: number;
  avgChecklistCompletion: number;
  summary: string;
};

export interface TripEntryLike {
  destination: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  checklist_total: number;
  checklist_done: number;
}

export function analyzeTrips(trips: readonly TripEntryLike[]): TripInsights {
  let upcomingTrips = 0;
  let completedTrips = 0;
  let totalItems = 0;
  let doneItems = 0;

  for (const t of trips) {
    if (t.status === 'completed') completedTrips++;
    else if (t.status !== 'cancelled') upcomingTrips++;
    totalItems += t.checklist_total;
    doneItems += t.checklist_done;
  }

  const avgChecklistCompletion = totalItems === 0 ? 0 : Math.round((doneItems / totalItems) * 100);

  const parts: string[] = [];
  parts.push(`${trips.length} trip${trips.length === 1 ? '' : 's'}`);
  if (upcomingTrips > 0) parts.push(`${upcomingTrips} upcoming`);
  if (completedTrips > 0) parts.push(`${completedTrips} completed`);
  if (totalItems > 0) parts.push(`${avgChecklistCompletion}% packed`);

  return { totalTrips: trips.length, upcomingTrips, completedTrips, avgChecklistCompletion, summary: parts.join(' · ') };
}

export function buildTripsPrompt(trips: readonly TripEntryLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family travel assistant. Analyze the family's trips and suggest improvements for travel planning. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable travel planning suggestion"],
  "packingReminders": ["important item or category to pack"],
  "planningTip": "one short tip for better trip planning"
}

Rules:
- suggestions: max 4 practical suggestions based on current trip plans
- packingReminders: max 4 commonly forgotten packing items or categories
- planningTip: one concrete tip
- Consider checklist completion, trip dates, and destination context.`;

  const tripList = trips.map((t) => {
    const dates = t.start_date && t.end_date ? `${t.start_date} → ${t.end_date}` : 'no dates';
    const pct = t.checklist_total > 0 ? Math.round((t.checklist_done / t.checklist_total) * 100) : 0;
    return `"${t.destination}" (${t.status}, ${dates}, checklist ${pct}%)`;
  }).join('\n');
  const user = `The family has ${trips.length} trips:\n\n${tripList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type TripsAIResponse = {
  suggestions: string[];
  packingReminders: string[];
  planningTip: string;
};

export function parseTripsResponse(raw: string): TripsAIResponse {
  const empty: TripsAIResponse = { suggestions: [], packingReminders: [], planningTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      packingReminders: Array.isArray(parsed.packingReminders)
        ? parsed.packingReminders.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      planningTip: typeof parsed.planningTip === 'string' ? parsed.planningTip : '',
    };
  } catch {
    return empty;
  }
}
