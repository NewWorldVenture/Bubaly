export type DonationsInsights = {
  totalDonations: number;
  totalAmount: number;
  taxDeductibleCount: number;
  categoryCounts: Record<string, number>;
  summary: string;
};

export interface DonationForAI {
  organization: string;
  donation_type: string;
  amount: number | null;
  category: string;
  donation_date: string;
  is_tax_deductible: boolean;
}

export function analyzeDonations(entries: DonationForAI[]): DonationsInsights {
  const categoryCounts: Record<string, number> = {};
  let totalAmount = 0;
  let taxDeductibleCount = 0;

  for (const d of entries) {
    categoryCounts[d.category] = (categoryCounts[d.category] ?? 0) + 1;
    totalAmount += d.amount ?? 0;
    if (d.is_tax_deductible) taxDeductibleCount++;
  }

  const summary = entries.length === 0
    ? 'No donations recorded yet.'
    : `${entries.length} donations totaling $${totalAmount.toLocaleString()}. ${taxDeductibleCount} tax-deductible.`;

  return { totalDonations: entries.length, totalAmount, taxDeductibleCount, categoryCounts, summary };
}

export function buildDonationsPrompt(entries: DonationForAI[]) {
  const system = `You are a charitable giving advisor. Analyze donation data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"taxTips":["..."],"givingStrategy":"..."}
suggestions: up to 4 actionable ideas. taxTips: up to 3 tax-related tips. givingStrategy: one sentence about giving strategy.`;

  const user = `Donation records:\n${JSON.stringify(entries.slice(0, 50))}`;
  return { system, user };
}

export type DonationsAIResponse = {
  suggestions: string[];
  taxTips: string[];
  givingStrategy: string;
};

export function parseDonationsResponse(raw: string): DonationsAIResponse {
  const empty: DonationsAIResponse = { suggestions: [], taxTips: [], givingStrategy: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      taxTips: Array.isArray(parsed.taxTips)
        ? parsed.taxTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      givingStrategy: typeof parsed.givingStrategy === 'string' ? parsed.givingStrategy : '',
    };
  } catch {
    return empty;
  }
}
