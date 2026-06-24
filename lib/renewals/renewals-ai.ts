export type RenewalsInsights = {
  totalRenewals: number;
  activeCount: number;
  expiredCount: number;
  expiringSoonCount: number;
  totalCost: number;
  summary: string;
};

export interface RenewalEntryLike {
  title: string;
  category: string | null;
  expires_at: string;
  cost: number | null;
  status: string;
}

export function analyzeRenewals(renewals: readonly RenewalEntryLike[]): RenewalsInsights {
  let activeCount = 0;
  let expiredCount = 0;
  let expiringSoonCount = 0;
  let totalCost = 0;
  const now = new Date();
  const soonThreshold = new Date();
  soonThreshold.setDate(soonThreshold.getDate() + 30);

  for (const r of renewals) {
    if (r.cost != null) totalCost += r.cost;
    if (r.status !== 'active') continue;
    activeCount++;
    const expires = new Date(r.expires_at);
    if (expires < now) expiredCount++;
    else if (expires <= soonThreshold) expiringSoonCount++;
  }

  const parts: string[] = [];
  parts.push(`${renewals.length} renewal${renewals.length === 1 ? '' : 's'}`);
  parts.push(`${activeCount} active`);
  if (expiredCount > 0) parts.push(`${expiredCount} expired`);
  if (expiringSoonCount > 0) parts.push(`${expiringSoonCount} expiring soon`);
  if (totalCost > 0) parts.push(`$${totalCost.toFixed(0)} total cost`);

  return { totalRenewals: renewals.length, activeCount, expiredCount, expiringSoonCount, totalCost, summary: parts.join(' · ') };
}

export function buildRenewalsPrompt(renewals: readonly RenewalEntryLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family renewals tracker. Analyze the family's renewals and expirations and suggest timely actions. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable renewal suggestion"],
  "priorityItems": ["item that needs urgent attention"],
  "organizationTip": "one short tip for managing renewals"
}

Rules:
- suggestions: max 4 practical suggestions based on current renewals
- priorityItems: max 3 items that need immediate attention (expired or expiring soon)
- organizationTip: one concrete recommendation
- Focus on preventing lapses, saving on renewal costs, and setting up reminders.`;

  const renewalList = renewals.map((r) =>
    `${r.title} (${r.category ?? 'other'}, expires: ${r.expires_at}, ${r.status}${r.cost != null ? `, $${r.cost}` : ''})`
  ).join('\n');
  const user = `The family has ${renewals.length} renewals tracked:\n\n${renewalList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type RenewalsAIResponse = {
  suggestions: string[];
  priorityItems: string[];
  organizationTip: string;
};

export function parseRenewalsResponse(raw: string): RenewalsAIResponse {
  const empty: RenewalsAIResponse = { suggestions: [], priorityItems: [], organizationTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      priorityItems: Array.isArray(parsed.priorityItems)
        ? parsed.priorityItems.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      organizationTip: typeof parsed.organizationTip === 'string' ? parsed.organizationTip : '',
    };
  } catch {
    return empty;
  }
}
