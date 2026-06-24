export type VolunteerInsights = {
  totalOpportunities: number;
  totalHours: number;
  categoryCounts: Record<string, number>;
  summary: string;
};

export interface VolunteerOpportunityForAI {
  title: string;
  organization: string;
  category: string;
  start_date: string | null;
  total_hours: number;
}

export function analyzeVolunteer(items: VolunteerOpportunityForAI[]): VolunteerInsights {
  const categoryCounts: Record<string, number> = {};
  let totalHours = 0;

  for (const v of items) {
    const cat = v.category || 'general';
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
    totalHours += v.total_hours;
  }

  const summary = items.length === 0
    ? 'No volunteer activities tracked yet.'
    : `${items.length} volunteer opportunities. ${totalHours} total hours logged.`;

  return { totalOpportunities: items.length, totalHours, categoryCounts, summary };
}

export function buildVolunteerPrompt(items: VolunteerOpportunityForAI[]) {
  const system = `You are a family volunteer advisor. Analyze volunteer data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"impactTips":["..."],"opportunityIdea":"..."}
suggestions: up to 4 actionable ideas. impactTips: up to 3 tips. opportunityIdea: one new volunteer opportunity idea.`;

  const user = `Volunteer activities:\n${JSON.stringify(items.slice(0, 50))}`;
  return { system, user };
}

export type VolunteerAIResponse = {
  suggestions: string[];
  impactTips: string[];
  opportunityIdea: string;
};

export function parseVolunteerResponse(raw: string): VolunteerAIResponse {
  const empty: VolunteerAIResponse = { suggestions: [], impactTips: [], opportunityIdea: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4) : [],
      impactTips: Array.isArray(parsed.impactTips) ? parsed.impactTips.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
      opportunityIdea: typeof parsed.opportunityIdea === 'string' ? parsed.opportunityIdea : '',
    };
  } catch { return empty; }
}
