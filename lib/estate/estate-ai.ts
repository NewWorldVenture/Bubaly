export type EstateInsights = {
  totalDocuments: number;
  typeCounts: Record<string, number>;
  needsReviewCount: number;
  summary: string;
};

export interface EstateDocForAI {
  document_type: string;
  title: string;
  review_status: string;
  effective_date: string | null;
  expiration_date: string | null;
  next_review: string | null;
}

export function analyzeEstate(docs: EstateDocForAI[]): EstateInsights {
  const typeCounts: Record<string, number> = {};
  let needsReviewCount = 0;

  for (const d of docs) {
    typeCounts[d.document_type] = (typeCounts[d.document_type] ?? 0) + 1;
    if (d.review_status === 'needs_review' || d.review_status === 'overdue') needsReviewCount++;
  }

  const summary = docs.length === 0
    ? 'No estate documents stored yet.'
    : `${docs.length} estate documents across ${Object.keys(typeCounts).length} types. ${needsReviewCount} need review.`;

  return { totalDocuments: docs.length, typeCounts, needsReviewCount, summary };
}

export function buildEstatePrompt(docs: EstateDocForAI[]) {
  const system = `You are an estate planning advisor. Analyze estate document data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"reviewPriorities":["..."],"planningTip":"..."}
suggestions: up to 4 actionable ideas. reviewPriorities: up to 3 items to review. planningTip: one sentence about estate planning.`;

  const user = `Estate documents:\n${JSON.stringify(docs.slice(0, 50))}`;
  return { system, user };
}

export type EstateAIResponse = {
  suggestions: string[];
  reviewPriorities: string[];
  planningTip: string;
};

export function parseEstateResponse(raw: string): EstateAIResponse {
  const empty: EstateAIResponse = { suggestions: [], reviewPriorities: [], planningTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      reviewPriorities: Array.isArray(parsed.reviewPriorities)
        ? parsed.reviewPriorities.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      planningTip: typeof parsed.planningTip === 'string' ? parsed.planningTip : '',
    };
  } catch {
    return empty;
  }
}
