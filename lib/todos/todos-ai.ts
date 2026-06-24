export type TodoInsights = {
  totalTodos: number;
  doneCount: number;
  pendingCount: number;
  overdueCount: number;
  summary: string;
};

export interface TodoEntryLike {
  title: string;
  is_done: boolean;
  priority: string;
  due_date: string | null;
}

export function analyzeTodos(todos: readonly TodoEntryLike[]): TodoInsights {
  let doneCount = 0;
  let overdueCount = 0;

  const now = new Date();

  for (const t of todos) {
    if (t.is_done) {
      doneCount++;
    } else if (t.due_date && new Date(t.due_date) < now) {
      overdueCount++;
    }
  }

  const pendingCount = todos.length - doneCount;
  const parts: string[] = [];
  parts.push(`${todos.length} todo${todos.length === 1 ? '' : 's'}`);
  parts.push(`${pendingCount} pending`);
  parts.push(`${doneCount} done`);
  if (overdueCount > 0) parts.push(`${overdueCount} overdue`);

  return { totalTodos: todos.length, doneCount, pendingCount, overdueCount, summary: parts.join(' · ') };
}

export function buildTodosPrompt(todos: readonly TodoEntryLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family task manager. Analyze the family's to-do list and suggest productivity improvements. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable todo suggestion"],
  "productivityTips": ["helpful productivity or prioritization tip"],
  "focusTip": "one short tip about what to focus on first"
}

Rules:
- suggestions: max 4 practical suggestions based on current todos
- productivityTips: max 3 productivity or prioritization tips
- focusTip: one concrete tip about focus
- Focus on overdue items, priority balance, and quick wins.`;

  const todoList = todos.filter((t) => !t.is_done).map((t) =>
    `${t.title} (${t.priority}${t.due_date ? `, due: ${t.due_date}` : ''})`
  ).join('\n');
  const user = `The family has ${todos.length} todos (${todos.length - todos.filter(t => t.is_done).length} pending):\n\n${todoList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type TodosAIResponse = {
  suggestions: string[];
  productivityTips: string[];
  focusTip: string;
};

export function parseTodosResponse(raw: string): TodosAIResponse {
  const empty: TodosAIResponse = { suggestions: [], productivityTips: [], focusTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      productivityTips: Array.isArray(parsed.productivityTips)
        ? parsed.productivityTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      focusTip: typeof parsed.focusTip === 'string' ? parsed.focusTip : '',
    };
  } catch {
    return empty;
  }
}
