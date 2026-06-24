export type CelebrationInsights = {
  totalDates: number;
  upcomingCount: number;
  kindCounts: Record<string, number>;
  summary: string;
};

export interface CelebrationEntryLike {
  title: string;
  kind: string;
  event_date: string;
}

export function analyzeCelebrations(dates: readonly CelebrationEntryLike[]): CelebrationInsights {
  const kindCounts: Record<string, number> = {};
  let upcomingCount = 0;
  const now = new Date();

  for (const d of dates) {
    kindCounts[d.kind] = (kindCounts[d.kind] ?? 0) + 1;
    const eventDate = new Date(d.event_date);
    const thisYear = new Date(now.getFullYear(), eventDate.getMonth(), eventDate.getDate());
    if (thisYear < now) thisYear.setFullYear(thisYear.getFullYear() + 1);
    const daysUntil = Math.ceil((thisYear.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (daysUntil <= 30) upcomingCount++;
  }

  const parts: string[] = [];
  parts.push(`${dates.length} date${dates.length === 1 ? '' : 's'}`);
  parts.push(`${upcomingCount} upcoming`);
  parts.push(`${Object.keys(kindCounts).length} type${Object.keys(kindCounts).length === 1 ? '' : 's'}`);

  return { totalDates: dates.length, upcomingCount, kindCounts, summary: parts.join(' · ') };
}

export function buildCelebrationsPrompt(dates: readonly CelebrationEntryLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family celebrations planner. Analyze the family's important dates and suggest ways to celebrate. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable celebration suggestion"],
  "giftIdeas": ["thoughtful gift or activity idea"],
  "planningTip": "one short tip for celebration planning"
}

Rules:
- suggestions: max 4 practical suggestions based on upcoming dates
- giftIdeas: max 3 gift or activity ideas for upcoming celebrations
- planningTip: one concrete tip
- Focus on upcoming events, preparation timelines, and meaningful traditions.`;

  const dateList = dates.map((d) =>
    `${d.title} (${d.kind}, ${d.event_date})`
  ).join('\n');
  const user = `The family has ${dates.length} important dates:\n\n${dateList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type CelebrationsAIResponse = {
  suggestions: string[];
  giftIdeas: string[];
  planningTip: string;
};

export function parseCelebrationsResponse(raw: string): CelebrationsAIResponse {
  const empty: CelebrationsAIResponse = { suggestions: [], giftIdeas: [], planningTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      giftIdeas: Array.isArray(parsed.giftIdeas)
        ? parsed.giftIdeas.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      planningTip: typeof parsed.planningTip === 'string' ? parsed.planningTip : '',
    };
  } catch {
    return empty;
  }
}
