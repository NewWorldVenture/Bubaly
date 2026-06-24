export type SubscriptionInsights = {
  totalSubscriptions: number;
  activeCount: number;
  monthlySpendCents: number;
  annualSpendCents: number;
  staleCount: number;
  summary: string;
};

export interface SubscriptionEntryLike {
  name: string;
  cost_cents: number;
  cadence: string;
  category: string | null;
  status: string;
  last_used: string | null;
}

function monthlyCents(costCents: number, cadence: string): number {
  switch (cadence) {
    case 'weekly': return Math.round(costCents * 52 / 12);
    case 'monthly': return costCents;
    case 'quarterly': return Math.round(costCents / 3);
    case 'yearly': return Math.round(costCents / 12);
    default: return costCents;
  }
}

export function analyzeSubscriptions(subs: readonly SubscriptionEntryLike[]): SubscriptionInsights {
  let monthlySpendCents = 0;
  let activeCount = 0;
  let staleCount = 0;

  const now = new Date();
  const staleThreshold = new Date(now);
  staleThreshold.setDate(staleThreshold.getDate() - 60);

  for (const s of subs) {
    if (s.status === 'active') {
      activeCount++;
      monthlySpendCents += monthlyCents(s.cost_cents, s.cadence);
      if (s.last_used && new Date(s.last_used) < staleThreshold) staleCount++;
    }
  }

  const annualSpendCents = monthlySpendCents * 12;
  const parts: string[] = [];
  parts.push(`${subs.length} subscription${subs.length === 1 ? '' : 's'} (${activeCount} active)`);
  parts.push(`$${(monthlySpendCents / 100).toFixed(0)}/mo`);
  parts.push(`$${(annualSpendCents / 100).toFixed(0)}/yr`);
  if (staleCount > 0) parts.push(`${staleCount} unused`);

  return { totalSubscriptions: subs.length, activeCount, monthlySpendCents, annualSpendCents, staleCount, summary: parts.join(' · ') };
}

export function buildSubscriptionsPrompt(subs: readonly SubscriptionEntryLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family subscription optimizer. Analyze the family's subscriptions and suggest cost-saving opportunities. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable subscription optimization"],
  "savingOpportunities": ["potential cost-saving action"],
  "managementTip": "one short tip for better subscription management"
}

Rules:
- suggestions: max 4 practical suggestions based on current subscriptions
- savingOpportunities: max 3 specific ways to reduce subscription spending
- managementTip: one concrete tip
- Look for overlapping services, unused subscriptions, and bundle opportunities.`;

  const subList = subs.map((s) => {
    const monthly = monthlyCents(s.cost_cents, s.cadence);
    return `${s.name} ($${(monthly / 100).toFixed(2)}/mo, ${s.cadence}, ${s.category ?? 'Other'}, ${s.status}${s.last_used ? `, last used: ${s.last_used.slice(0, 10)}` : ''})`;
  }).join('\n');
  const user = `The family has ${subs.length} subscriptions:\n\n${subList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type SubscriptionsAIResponse = {
  suggestions: string[];
  savingOpportunities: string[];
  managementTip: string;
};

export function parseSubscriptionsResponse(raw: string): SubscriptionsAIResponse {
  const empty: SubscriptionsAIResponse = { suggestions: [], savingOpportunities: [], managementTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      savingOpportunities: Array.isArray(parsed.savingOpportunities)
        ? parsed.savingOpportunities.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      managementTip: typeof parsed.managementTip === 'string' ? parsed.managementTip : '',
    };
  } catch {
    return empty;
  }
}
