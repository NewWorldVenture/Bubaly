export type TaxVaultInsights = {
  totalDocuments: number;
  yearCounts: Record<number, number>;
  summary: string;
};

export interface TaxDocForAI {
  category: string;
  tax_year: number;
  name: string;
}

export function analyzeTaxVault(docs: TaxDocForAI[]): TaxVaultInsights {
  const yearCounts: Record<number, number> = {};
  for (const d of docs) {
    yearCounts[d.tax_year] = (yearCounts[d.tax_year] ?? 0) + 1;
  }

  const summary = docs.length === 0
    ? 'No tax documents stored yet.'
    : `${docs.length} tax documents across ${Object.keys(yearCounts).length} tax year${Object.keys(yearCounts).length > 1 ? 's' : ''}.`;

  return { totalDocuments: docs.length, yearCounts, summary };
}

export function buildTaxVaultPrompt(docs: TaxDocForAI[]) {
  const system = `You are a family tax organization advisor. Analyze tax document data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"organizationTips":["..."],"complianceTip":"..."}
suggestions: up to 4 actionable ideas. organizationTips: up to 3 tips. complianceTip: one sentence about staying compliant.`;

  const user = `Tax documents:\n${JSON.stringify(docs.slice(0, 50))}`;
  return { system, user };
}

export type TaxVaultAIResponse = {
  suggestions: string[];
  organizationTips: string[];
  complianceTip: string;
};

export function parseTaxVaultResponse(raw: string): TaxVaultAIResponse {
  const empty: TaxVaultAIResponse = { suggestions: [], organizationTips: [], complianceTip: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4) : [],
      organizationTips: Array.isArray(parsed.organizationTips) ? parsed.organizationTips.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
      complianceTip: typeof parsed.complianceTip === 'string' ? parsed.complianceTip : '',
    };
  } catch { return empty; }
}
