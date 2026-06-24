export type InsuranceInsights = {
  totalPolicies: number;
  typeCounts: Record<string, number>;
  totalPremium: number;
  totalCoverage: number;
  renewingSoonCount: number;
  summary: string;
};

export interface InsurancePolicyForAI {
  policy_type: string;
  insurer: string;
  premium_amount: number | null;
  premium_frequency: string;
  coverage_amount: number | null;
  deductible: number | null;
  renewal_date: string | null;
}

export function analyzeInsurance(policies: InsurancePolicyForAI[]): InsuranceInsights {
  const typeCounts: Record<string, number> = {};
  let totalPremium = 0;
  let totalCoverage = 0;
  let renewingSoonCount = 0;
  const now = new Date();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;

  for (const p of policies) {
    typeCounts[p.policy_type] = (typeCounts[p.policy_type] ?? 0) + 1;
    totalPremium += p.premium_amount ?? 0;
    totalCoverage += p.coverage_amount ?? 0;
    if (p.renewal_date) {
      const renew = new Date(p.renewal_date);
      if (renew.getTime() - now.getTime() < thirtyDays && renew >= now) renewingSoonCount++;
    }
  }

  const summary = policies.length === 0
    ? 'No insurance policies tracked yet.'
    : `${policies.length} policies. Total premium: $${totalPremium.toLocaleString()}, coverage: $${totalCoverage.toLocaleString()}. ${renewingSoonCount} renewing within 30 days.`;

  return { totalPolicies: policies.length, typeCounts, totalPremium, totalCoverage, renewingSoonCount, summary };
}

export function buildInsurancePrompt(policies: InsurancePolicyForAI[]) {
  const system = `You are an insurance advisor. Analyze family insurance data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"coverageTips":["..."],"savingsTip":"..."}
suggestions: up to 4 actionable ideas. coverageTips: up to 3 tips. savingsTip: one sentence about saving on premiums.`;

  const user = `Insurance policies:\n${JSON.stringify(policies.slice(0, 50))}`;
  return { system, user };
}

export type InsuranceAIResponse = {
  suggestions: string[];
  coverageTips: string[];
  savingsTip: string;
};

export function parseInsuranceResponse(raw: string): InsuranceAIResponse {
  const empty: InsuranceAIResponse = { suggestions: [], coverageTips: [], savingsTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      coverageTips: Array.isArray(parsed.coverageTips)
        ? parsed.coverageTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      savingsTip: typeof parsed.savingsTip === 'string' ? parsed.savingsTip : '',
    };
  } catch {
    return empty;
  }
}
