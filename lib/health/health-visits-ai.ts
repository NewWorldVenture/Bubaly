export type HealthVisitsInsights = {
  totalVisits: number;
  kindCounts: Record<string, number>;
  upcomingFollowUps: number;
  totalCostCents: number;
  summary: string;
};

export interface HealthVisitEntryLike {
  title: string;
  kind: string;
  visit_date: string;
  provider_name: string | null;
  follow_up_date: string | null;
  cost_cents: number | null;
}

export function analyzeHealthVisits(visits: readonly HealthVisitEntryLike[]): HealthVisitsInsights {
  const kindCounts: Record<string, number> = {};
  let upcomingFollowUps = 0;
  let totalCostCents = 0;
  const now = new Date().toISOString().slice(0, 10);

  for (const v of visits) {
    kindCounts[v.kind] = (kindCounts[v.kind] ?? 0) + 1;
    if (v.follow_up_date && v.follow_up_date >= now) upcomingFollowUps++;
    if (v.cost_cents != null) totalCostCents += v.cost_cents;
  }

  const parts: string[] = [];
  parts.push(`${visits.length} visit${visits.length === 1 ? '' : 's'}`);
  parts.push(`${Object.keys(kindCounts).length} types`);
  if (upcomingFollowUps > 0) parts.push(`${upcomingFollowUps} follow-ups`);
  if (totalCostCents > 0) parts.push(`$${(totalCostCents / 100).toFixed(0)} total cost`);

  return { totalVisits: visits.length, kindCounts, upcomingFollowUps, totalCostCents, summary: parts.join(' · ') };
}

export function buildHealthVisitsPrompt(visits: readonly HealthVisitEntryLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family health advisor. Analyze the family's health visit history and suggest preventive care improvements. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable health care suggestion"],
  "preventiveTips": ["tip for staying on top of preventive care"],
  "wellnessTip": "one short wellness recommendation"
}

Rules:
- suggestions: max 4 practical suggestions based on visit history
- preventiveTips: max 3 tips for preventive care scheduling
- wellnessTip: one concrete recommendation
- Focus on scheduling follow-ups, preventive screenings, and keeping records up to date.`;

  const visitList = visits.map((v) =>
    `${v.title} (${v.kind}, ${v.visit_date}${v.provider_name ? `, ${v.provider_name}` : ''}${v.follow_up_date ? `, follow-up: ${v.follow_up_date}` : ''})`
  ).join('\n');
  const user = `The family has ${visits.length} health visits on record:\n\n${visitList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type HealthVisitsAIResponse = {
  suggestions: string[];
  preventiveTips: string[];
  wellnessTip: string;
};

export function parseHealthVisitsResponse(raw: string): HealthVisitsAIResponse {
  const empty: HealthVisitsAIResponse = { suggestions: [], preventiveTips: [], wellnessTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      preventiveTips: Array.isArray(parsed.preventiveTips)
        ? parsed.preventiveTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      wellnessTip: typeof parsed.wellnessTip === 'string' ? parsed.wellnessTip : '',
    };
  } catch {
    return empty;
  }
}
