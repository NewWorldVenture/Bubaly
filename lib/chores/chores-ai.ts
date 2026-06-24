export type ChoreInsights = {
  totalChores: number;
  activeCount: number;
  completedCount: number;
  overdueCount: number;
  summary: string;
};

export interface ChoreEntryLike {
  title: string;
  priority: string;
  status: string;
  due_at: string | null;
  category: string | null;
}

export function analyzeChores(chores: readonly ChoreEntryLike[]): ChoreInsights {
  let activeCount = 0;
  let completedCount = 0;
  let overdueCount = 0;

  const now = new Date();

  for (const c of chores) {
    if (c.status === 'done') {
      completedCount++;
    } else {
      activeCount++;
      if (c.due_at && new Date(c.due_at) < now) overdueCount++;
    }
  }

  const parts: string[] = [];
  parts.push(`${chores.length} chore${chores.length === 1 ? '' : 's'}`);
  parts.push(`${activeCount} active`);
  parts.push(`${completedCount} done`);
  if (overdueCount > 0) parts.push(`${overdueCount} overdue`);

  return { totalChores: chores.length, activeCount, completedCount, overdueCount, summary: parts.join(' · ') };
}

export function buildChoresPrompt(chores: readonly ChoreEntryLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family chore manager. Analyze the family's chores and suggest improvements. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable chore management suggestion"],
  "fairnessIdeas": ["idea for making chores more fair or motivating"],
  "organizationTip": "one short tip for better chore management"
}

Rules:
- suggestions: max 4 practical suggestions based on current chores
- fairnessIdeas: max 3 ideas for fair distribution and motivation
- organizationTip: one concrete tip
- Focus on workload balance, age-appropriate tasks, and reducing overdue items.`;

  const choreList = chores.map((c) =>
    `${c.title} (${c.priority}, ${c.status}, ${c.category ?? 'General'}${c.due_at ? `, due: ${c.due_at.slice(0, 10)}` : ''})`
  ).join('\n');
  const user = `The family has ${chores.length} chores:\n\n${choreList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type ChoresAIResponse = {
  suggestions: string[];
  fairnessIdeas: string[];
  organizationTip: string;
};

export function parseChoresResponse(raw: string): ChoresAIResponse {
  const empty: ChoresAIResponse = { suggestions: [], fairnessIdeas: [], organizationTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      fairnessIdeas: Array.isArray(parsed.fairnessIdeas)
        ? parsed.fairnessIdeas.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      organizationTip: typeof parsed.organizationTip === 'string' ? parsed.organizationTip : '',
    };
  } catch {
    return empty;
  }
}
