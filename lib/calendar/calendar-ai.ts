export type CalendarInsights = {
  totalEvents: number;
  upcomingCount: number;
  categoryCounts: Record<string, number>;
  busiestDay: string | null;
  summary: string;
};

export interface CalendarEventLike {
  title: string;
  category: string;
  starts_at: string;
  all_day: boolean;
}

export function analyzeCalendarEvents(events: readonly CalendarEventLike[]): CalendarInsights {
  const categoryCounts: Record<string, number> = {};
  const dayCounts: Record<string, number> = {};
  let upcomingCount = 0;
  const now = new Date();

  for (const e of events) {
    categoryCounts[e.category] = (categoryCounts[e.category] ?? 0) + 1;
    const day = e.starts_at.slice(0, 10);
    dayCounts[day] = (dayCounts[day] ?? 0) + 1;
    if (new Date(e.starts_at) >= now) upcomingCount++;
  }

  let busiestDay: string | null = null;
  let maxEvents = 0;
  for (const [day, count] of Object.entries(dayCounts)) {
    if (count > maxEvents) { maxEvents = count; busiestDay = day; }
  }

  const parts: string[] = [];
  parts.push(`${events.length} event${events.length === 1 ? '' : 's'}`);
  parts.push(`${upcomingCount} upcoming`);
  parts.push(`${Object.keys(categoryCounts).length} categor${Object.keys(categoryCounts).length === 1 ? 'y' : 'ies'}`);
  if (busiestDay) parts.push(`busiest: ${busiestDay}`);

  return { totalEvents: events.length, upcomingCount, categoryCounts, busiestDay, summary: parts.join(' · ') };
}

export function buildCalendarPrompt(events: readonly CalendarEventLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family calendar assistant. Analyze the family's schedule and suggest improvements. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable scheduling suggestion"],
  "conflictWarnings": ["potential scheduling conflict or concern"],
  "planningTip": "one short tip for better calendar management"
}

Rules:
- suggestions: max 4 practical suggestions based on the current schedule
- conflictWarnings: max 3 potential conflicts or overbooked days
- planningTip: one concrete tip
- Focus on scheduling conflicts, family time balance, and preparation reminders.`;

  const eventList = events.map((e) =>
    `${e.title} (${e.category}, ${e.starts_at}${e.all_day ? ', all-day' : ''})`
  ).join('\n');
  const user = `The family has ${events.length} calendar events:\n\n${eventList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type CalendarAIResponse = {
  suggestions: string[];
  conflictWarnings: string[];
  planningTip: string;
};

export function parseCalendarResponse(raw: string): CalendarAIResponse {
  const empty: CalendarAIResponse = { suggestions: [], conflictWarnings: [], planningTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      conflictWarnings: Array.isArray(parsed.conflictWarnings)
        ? parsed.conflictWarnings.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      planningTip: typeof parsed.planningTip === 'string' ? parsed.planningTip : '',
    };
  } catch {
    return empty;
  }
}
