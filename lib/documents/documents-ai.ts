export type DocumentsInsights = {
  totalDocuments: number;
  categoryCounts: Record<string, number>;
  expiringCount: number;
  summary: string;
};

export interface DocumentForAI {
  title: string;
  category: string | null;
  expires_at: string | null;
}

export function analyzeDocuments(docs: DocumentForAI[]): DocumentsInsights {
  const categoryCounts: Record<string, number> = {};
  let expiringCount = 0;
  const now = new Date();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;

  for (const d of docs) {
    const cat = d.category || 'uncategorized';
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
    if (d.expires_at) {
      const exp = new Date(d.expires_at);
      if (exp.getTime() - now.getTime() < thirtyDays && exp >= now) expiringCount++;
    }
  }

  const summary = docs.length === 0
    ? 'No documents stored yet.'
    : `${docs.length} documents across ${Object.keys(categoryCounts).length} categories. ${expiringCount} expiring within 30 days.`;

  return { totalDocuments: docs.length, categoryCounts, expiringCount, summary };
}

export function buildDocumentsPrompt(docs: DocumentForAI[]) {
  const system = `You are a family document organization advisor. Analyze document data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"organizationTips":["..."],"securityTip":"..."}
suggestions: up to 4 actionable ideas. organizationTips: up to 3 tips. securityTip: one sentence about document security.`;

  const user = `Documents:\n${JSON.stringify(docs.slice(0, 50))}`;
  return { system, user };
}

export type DocumentsAIResponse = {
  suggestions: string[];
  organizationTips: string[];
  securityTip: string;
};

export function parseDocumentsResponse(raw: string): DocumentsAIResponse {
  const empty: DocumentsAIResponse = { suggestions: [], organizationTips: [], securityTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      organizationTips: Array.isArray(parsed.organizationTips)
        ? parsed.organizationTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      securityTip: typeof parsed.securityTip === 'string' ? parsed.securityTip : '',
    };
  } catch {
    return empty;
  }
}
