export type CollegeInsights = {
  totalApplications: number;
  totalScholarships: number;
  statusCounts: Record<string, number>;
  totalTuition: number;
  totalAid: number;
  summary: string;
};

export interface CollegeAppForAI {
  school_name: string;
  program: string;
  status: string;
  deadline: string | null;
  tuition: number | null;
  financial_aid: number | null;
}

export interface ScholarshipForAI {
  name: string;
  provider: string;
  amount: number | null;
  status: string;
  deadline: string | null;
}

export function analyzeCollege(apps: CollegeAppForAI[], scholarships: ScholarshipForAI[]): CollegeInsights {
  const statusCounts: Record<string, number> = {};
  let totalTuition = 0;
  let totalAid = 0;

  for (const a of apps) {
    statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;
    totalTuition += a.tuition ?? 0;
    totalAid += a.financial_aid ?? 0;
  }
  for (const s of scholarships) {
    totalAid += s.amount ?? 0;
  }

  const summary = apps.length === 0 && scholarships.length === 0
    ? 'No college applications or scholarships tracked yet.'
    : `${apps.length} applications, ${scholarships.length} scholarships. Estimated tuition: $${totalTuition.toLocaleString()}, total aid: $${totalAid.toLocaleString()}.`;

  return { totalApplications: apps.length, totalScholarships: scholarships.length, statusCounts, totalTuition, totalAid, summary };
}

export function buildCollegePrompt(apps: CollegeAppForAI[], scholarships: ScholarshipForAI[]) {
  const system = `You are a college planning advisor. Analyze application and scholarship data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"deadlineTips":["..."],"strategyTip":"..."}
suggestions: up to 4 actionable ideas. deadlineTips: up to 3 deadline-related tips. strategyTip: one strategic recommendation.`;

  const user = `Applications:\n${JSON.stringify(apps.slice(0, 30))}\n\nScholarships:\n${JSON.stringify(scholarships.slice(0, 30))}`;
  return { system, user };
}

export type CollegeAIResponse = {
  suggestions: string[];
  deadlineTips: string[];
  strategyTip: string;
};

export function parseCollegeResponse(raw: string): CollegeAIResponse {
  const empty: CollegeAIResponse = { suggestions: [], deadlineTips: [], strategyTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      deadlineTips: Array.isArray(parsed.deadlineTips)
        ? parsed.deadlineTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      strategyTip: typeof parsed.strategyTip === 'string' ? parsed.strategyTip : '',
    };
  } catch {
    return empty;
  }
}
