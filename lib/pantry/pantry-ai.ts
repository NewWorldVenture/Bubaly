export type PantryInsights = {
  totalItems: number;
  lowStockCount: number;
  expiringCount: number;
  locationCounts: Record<string, number>;
  summary: string;
};

export interface PantryItemLike {
  name: string;
  category: string | null;
  location: string;
  quantity: number;
  expires_at: string | null;
  low_threshold: number | null;
}

export function analyzePantry(items: readonly PantryItemLike[]): PantryInsights {
  const locationCounts: Record<string, number> = {};
  let lowStockCount = 0;
  let expiringCount = 0;

  const now = new Date();
  const weekOut = new Date(now);
  weekOut.setDate(weekOut.getDate() + 7);

  for (const item of items) {
    locationCounts[item.location] = (locationCounts[item.location] ?? 0) + 1;
    if (item.low_threshold && item.quantity <= item.low_threshold) lowStockCount++;
    if (item.expires_at && new Date(item.expires_at) <= weekOut) expiringCount++;
  }

  const parts: string[] = [];
  parts.push(`${items.length} item${items.length === 1 ? '' : 's'}`);
  if (lowStockCount > 0) parts.push(`${lowStockCount} low stock`);
  if (expiringCount > 0) parts.push(`${expiringCount} expiring soon`);
  parts.push(`${Object.keys(locationCounts).length} location${Object.keys(locationCounts).length === 1 ? '' : 's'}`);

  return { totalItems: items.length, lowStockCount, expiringCount, locationCounts, summary: parts.join(' · ') };
}

export function buildPantryPrompt(items: readonly PantryItemLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family pantry manager. Analyze the family's pantry inventory and suggest improvements. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable pantry suggestion"],
  "restockItems": ["item that needs restocking"],
  "organizationTip": "one short tip for better pantry management"
}

Rules:
- suggestions: max 4 practical suggestions based on current inventory
- restockItems: max 3 items that should be restocked or purchased
- organizationTip: one concrete tip
- Focus on expiring items, low stock staples, and storage optimization.`;

  const itemList = items.map((i) =>
    `${i.name} (${i.category ?? 'Other'}, ${i.location}, qty: ${i.quantity}${i.expires_at ? `, expires: ${i.expires_at.slice(0, 10)}` : ''})`
  ).join('\n');
  const user = `The pantry has ${items.length} items:\n\n${itemList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type PantryAIResponse = {
  suggestions: string[];
  restockItems: string[];
  organizationTip: string;
};

export function parsePantryResponse(raw: string): PantryAIResponse {
  const empty: PantryAIResponse = { suggestions: [], restockItems: [], organizationTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      restockItems: Array.isArray(parsed.restockItems)
        ? parsed.restockItems.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      organizationTip: typeof parsed.organizationTip === 'string' ? parsed.organizationTip : '',
    };
  } catch {
    return empty;
  }
}
