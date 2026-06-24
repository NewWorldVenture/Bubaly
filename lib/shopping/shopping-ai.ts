export type ShoppingInsights = {
  totalLists: number;
  totalItems: number;
  completedItems: number;
  remainingItems: number;
  summary: string;
};

export interface ShoppingItemLike {
  name: string;
  category: string | null;
  is_checked: boolean;
}

export function analyzeShoppingLists(lists: number, items: readonly ShoppingItemLike[]): ShoppingInsights {
  let completedItems = 0;

  for (const item of items) {
    if (item.is_checked) completedItems++;
  }

  const remainingItems = items.length - completedItems;
  const parts: string[] = [];
  parts.push(`${lists} list${lists === 1 ? '' : 's'}`);
  parts.push(`${items.length} item${items.length === 1 ? '' : 's'}`);
  parts.push(`${remainingItems} remaining`);

  return { totalLists: lists, totalItems: items.length, completedItems, remainingItems, summary: parts.join(' · ') };
}

export function buildShoppingPrompt(items: readonly ShoppingItemLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family shopping assistant. Analyze the family's shopping lists and suggest improvements. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable shopping suggestion"],
  "dealTips": ["tip for getting better deals or saving money"],
  "organizationTip": "one short tip for better shopping list management"
}

Rules:
- suggestions: max 4 practical suggestions based on current lists
- dealTips: max 3 tips for saving money while shopping
- organizationTip: one concrete tip
- Focus on batch shopping, seasonal deals, and list organization.`;

  const unchecked = items.filter((i) => !i.is_checked);
  const itemList = unchecked.map((i) => `${i.name} (${i.category ?? 'Other'})`).join(', ');
  const user = `The shopping lists have ${items.length} items (${unchecked.length} remaining):\n\n${itemList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type ShoppingAIResponse = {
  suggestions: string[];
  dealTips: string[];
  organizationTip: string;
};

export function parseShoppingResponse(raw: string): ShoppingAIResponse {
  const empty: ShoppingAIResponse = { suggestions: [], dealTips: [], organizationTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      dealTips: Array.isArray(parsed.dealTips)
        ? parsed.dealTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      organizationTip: typeof parsed.organizationTip === 'string' ? parsed.organizationTip : '',
    };
  } catch {
    return empty;
  }
}
