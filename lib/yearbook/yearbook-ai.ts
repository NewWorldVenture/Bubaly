export type YearbookInsights = {
  totalYearbooks: number;
  totalEntries: number;
  categoryCounts: Record<string, number>;
  summary: string;
};

export interface YearbookEntryForAI {
  title: string;
  category: string;
  entry_date: string | null;
  description: string;
}

export function analyzeYearbook(yearbooks: number, entries: YearbookEntryForAI[]): YearbookInsights {
  const categoryCounts: Record<string, number> = {};
  for (const e of entries) {
    const cat = e.category || 'general';
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
  }

  const summary = yearbooks === 0
    ? 'No yearbooks created yet.'
    : `${yearbooks} yearbook${yearbooks > 1 ? 's' : ''} with ${entries.length} entries across ${Object.keys(categoryCounts).length} categories.`;

  return { totalYearbooks: yearbooks, totalEntries: entries.length, categoryCounts, summary };
}

export function buildYearbookPrompt(entries: YearbookEntryForAI[]) {
  const system = `You are a family yearbook advisor. Analyze yearbook entries and return ONLY valid JSON with this shape:
{"suggestions":["..."],"memoryTips":["..."],"themeIdea":"..."}
suggestions: up to 4 actionable ideas. memoryTips: up to 3 tips. themeIdea: one creative yearbook theme idea.`;

  const user = `Yearbook entries:\n${JSON.stringify(entries.slice(0, 50))}`;
  return { system, user };
}

export type YearbookAIResponse = {
  suggestions: string[];
  memoryTips: string[];
  themeIdea: string;
};

export function parseYearbookResponse(raw: string): YearbookAIResponse {
  const empty: YearbookAIResponse = { suggestions: [], memoryTips: [], themeIdea: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4) : [],
      memoryTips: Array.isArray(parsed.memoryTips) ? parsed.memoryTips.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
      themeIdea: typeof parsed.themeIdea === 'string' ? parsed.themeIdea : '',
    };
  } catch { return empty; }
}
