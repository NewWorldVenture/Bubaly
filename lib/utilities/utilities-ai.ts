export type UtilitiesInsights = {
  totalBills: number;
  typeCounts: Record<string, number>;
  totalCost: number;
  summary: string;
};

export interface UtilityBillForAI {
  kind: string;
  provider: string | null;
  amount_cents: number;
  period_month: string;
}

export function analyzeUtilities(bills: UtilityBillForAI[]): UtilitiesInsights {
  const typeCounts: Record<string, number> = {};
  let totalCost = 0;

  for (const b of bills) {
    typeCounts[b.kind] = (typeCounts[b.kind] ?? 0) + 1;
    totalCost += b.amount_cents;
  }

  const summary = bills.length === 0
    ? 'No utility bills tracked yet.'
    : `${bills.length} bills across ${Object.keys(typeCounts).length} utility types. $${(totalCost / 100).toFixed(0)} total.`;

  return { totalBills: bills.length, typeCounts, totalCost, summary };
}

export function buildUtilitiesPrompt(bills: UtilityBillForAI[]) {
  const system = `You are a family utilities advisor. Analyze utility bill data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"savingsTips":["..."],"efficiencyTip":"..."}
suggestions: up to 4 actionable ideas. savingsTips: up to 3 tips. efficiencyTip: one sentence about reducing utility costs.`;

  const user = `Utility bills:\n${JSON.stringify(bills.slice(0, 50))}`;
  return { system, user };
}

export type UtilitiesAIResponse = {
  suggestions: string[];
  savingsTips: string[];
  efficiencyTip: string;
};

export function parseUtilitiesResponse(raw: string): UtilitiesAIResponse {
  const empty: UtilitiesAIResponse = { suggestions: [], savingsTips: [], efficiencyTip: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4) : [],
      savingsTips: Array.isArray(parsed.savingsTips) ? parsed.savingsTips.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
      efficiencyTip: typeof parsed.efficiencyTip === 'string' ? parsed.efficiencyTip : '',
    };
  } catch { return empty; }
}
