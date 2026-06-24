export type WishlistInsights = {
  totalItems: number;
  claimedCount: number;
  purchasedCount: number;
  totalValue: number;
  priorityCounts: Record<string, number>;
  summary: string;
};

export interface WishlistItemLike {
  title: string;
  price: number | null;
  priority: string;
  claimed_by: string | null;
  is_purchased: boolean;
}

export function analyzeWishlists(items: readonly WishlistItemLike[]): WishlistInsights {
  let claimedCount = 0;
  let purchasedCount = 0;
  let totalValue = 0;
  const priorityCounts: Record<string, number> = {};

  for (const item of items) {
    if (item.claimed_by) claimedCount++;
    if (item.is_purchased) purchasedCount++;
    if (item.price != null) totalValue += item.price;
    priorityCounts[item.priority] = (priorityCounts[item.priority] ?? 0) + 1;
  }

  const parts: string[] = [];
  parts.push(`${items.length} wish${items.length === 1 ? '' : 'es'}`);
  parts.push(`${claimedCount} claimed`);
  parts.push(`${purchasedCount} purchased`);
  if (totalValue > 0) parts.push(`$${totalValue.toFixed(0)} total value`);

  return { totalItems: items.length, claimedCount, purchasedCount, totalValue, priorityCounts, summary: parts.join(' · ') };
}

export function buildWishlistsPrompt(items: readonly WishlistItemLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family gift-giving advisor. Analyze the family's wish lists and suggest thoughtful gift coordination ideas. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable gift coordination suggestion"],
  "giftIdeas": ["creative gift idea or bundling suggestion"],
  "budgetTip": "one short tip for smart gift budgeting"
}

Rules:
- suggestions: max 4 practical suggestions based on current wish lists
- giftIdeas: max 3 creative ideas for gifts or coordination
- budgetTip: one concrete budgeting tip
- Focus on gift coordination, avoiding duplicates, and thoughtful gifting within budget.`;

  const wishList = items.map((item) =>
    `${item.title} (${item.priority}${item.price != null ? `, $${item.price}` : ''}${item.claimed_by ? ', claimed' : ''}${item.is_purchased ? ', purchased' : ''})`
  ).join('\n');
  const user = `The family has ${items.length} wishes across all lists:\n\n${wishList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type WishlistsAIResponse = {
  suggestions: string[];
  giftIdeas: string[];
  budgetTip: string;
};

export function parseWishlistsResponse(raw: string): WishlistsAIResponse {
  const empty: WishlistsAIResponse = { suggestions: [], giftIdeas: [], budgetTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      giftIdeas: Array.isArray(parsed.giftIdeas)
        ? parsed.giftIdeas.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      budgetTip: typeof parsed.budgetTip === 'string' ? parsed.budgetTip : '',
    };
  } catch {
    return empty;
  }
}
