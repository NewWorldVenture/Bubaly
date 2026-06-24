export type GroceryInsights = {
  totalItems: number;
  checkedItems: number;
  uncheckedItems: number;
  categoryCounts: Record<string, number>;
  summary: string;
};

export interface GroceryItemLike {
  name: string;
  category: string | null;
  is_checked: boolean;
}

export function analyzeGroceryList(items: readonly GroceryItemLike[]): GroceryInsights {
  const categoryCounts: Record<string, number> = {};
  let checkedItems = 0;

  for (const item of items) {
    if (item.is_checked) checkedItems++;
    const cat = item.category ?? 'Other';
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
  }

  const uncheckedItems = items.length - checkedItems;
  const parts: string[] = [];
  parts.push(`${items.length} item${items.length === 1 ? '' : 's'}`);
  parts.push(`${uncheckedItems} remaining`);
  parts.push(`${Object.keys(categoryCounts).length} categor${Object.keys(categoryCounts).length === 1 ? 'y' : 'ies'}`);

  return { totalItems: items.length, checkedItems, uncheckedItems, categoryCounts, summary: parts.join(' · ') };
}

export function buildGroceryPrompt(items: readonly GroceryItemLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family grocery assistant. Analyze the family's grocery list and suggest improvements. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable grocery suggestion"],
  "mealIdeas": ["quick meal idea based on the items on the list"],
  "shoppingTip": "one short tip for better grocery shopping"
}

Rules:
- suggestions: max 4 practical suggestions based on the current list
- mealIdeas: max 3 meal ideas that could be made with items from the list
- shoppingTip: one concrete shopping tip
- Focus on nutrition balance, commonly forgotten staples, and efficient shopping.`;

  const unchecked = items.filter((i) => !i.is_checked);
  const itemList = unchecked.map((i) => `${i.name} (${i.category ?? 'Other'})`).join(', ');
  const user = `The grocery list has ${items.length} items (${unchecked.length} remaining):\n\n${itemList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type GroceryAIResponse = {
  suggestions: string[];
  mealIdeas: string[];
  shoppingTip: string;
};

export function parseGroceryResponse(raw: string): GroceryAIResponse {
  const empty: GroceryAIResponse = { suggestions: [], mealIdeas: [], shoppingTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      mealIdeas: Array.isArray(parsed.mealIdeas)
        ? parsed.mealIdeas.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      shoppingTip: typeof parsed.shoppingTip === 'string' ? parsed.shoppingTip : '',
    };
  } catch {
    return empty;
  }
}
