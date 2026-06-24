export type ExpenseInsights = {
  totalExpenses: number;
  totalSpentCents: number;
  categoryCounts: Record<string, number>;
  categorySpendCents: Record<string, number>;
  summary: string;
};

export interface ExpenseEntryLike {
  description: string;
  total_cents: number;
  category: string | null;
  spent_on: string;
}

export function analyzeExpenses(expenses: readonly ExpenseEntryLike[]): ExpenseInsights {
  const categoryCounts: Record<string, number> = {};
  const categorySpendCents: Record<string, number> = {};
  let totalSpentCents = 0;

  for (const e of expenses) {
    const cat = e.category ?? 'Other';
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
    categorySpendCents[cat] = (categorySpendCents[cat] ?? 0) + e.total_cents;
    totalSpentCents += e.total_cents;
  }

  const parts: string[] = [];
  parts.push(`${expenses.length} expense${expenses.length === 1 ? '' : 's'}`);
  parts.push(`$${(totalSpentCents / 100).toFixed(0)} total`);
  parts.push(`${Object.keys(categoryCounts).length} categor${Object.keys(categoryCounts).length === 1 ? 'y' : 'ies'}`);

  return { totalExpenses: expenses.length, totalSpentCents, categoryCounts, categorySpendCents, summary: parts.join(' · ') };
}

export function buildExpensesPrompt(expenses: readonly ExpenseEntryLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family expense advisor. Analyze the family's recent expenses and suggest improvements. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable expense suggestion"],
  "savingIdeas": ["potential way to reduce spending"],
  "budgetTip": "one short tip for better expense management"
}

Rules:
- suggestions: max 4 practical suggestions based on current expenses
- savingIdeas: max 3 specific ways to reduce spending
- budgetTip: one concrete tip
- Focus on spending patterns, category outliers, and splitting fairness.`;

  const expList = expenses.map((e) =>
    `${e.description} ($${(e.total_cents / 100).toFixed(2)}, ${e.category ?? 'Other'}, ${e.spent_on})`
  ).join('\n');
  const user = `The family has ${expenses.length} recent expenses:\n\n${expList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type ExpensesAIResponse = {
  suggestions: string[];
  savingIdeas: string[];
  budgetTip: string;
};

export function parseExpensesResponse(raw: string): ExpensesAIResponse {
  const empty: ExpensesAIResponse = { suggestions: [], savingIdeas: [], budgetTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      savingIdeas: Array.isArray(parsed.savingIdeas)
        ? parsed.savingIdeas.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      budgetTip: typeof parsed.budgetTip === 'string' ? parsed.budgetTip : '',
    };
  } catch {
    return empty;
  }
}
