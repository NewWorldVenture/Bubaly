export type HomeworkInsights = {
  totalAssignments: number;
  pendingCount: number;
  overdueCount: number;
  completedCount: number;
  summary: string;
};

export interface HomeworkEntryLike {
  title: string;
  subject: string | null;
  status: string;
  due_at: string | null;
}

export function analyzeHomework(assignments: readonly HomeworkEntryLike[]): HomeworkInsights {
  let pendingCount = 0;
  let overdueCount = 0;
  let completedCount = 0;

  const now = new Date();

  for (const a of assignments) {
    if (a.status === 'done') {
      completedCount++;
    } else {
      pendingCount++;
      if (a.due_at && new Date(a.due_at) < now) overdueCount++;
    }
  }

  const parts: string[] = [];
  parts.push(`${assignments.length} assignment${assignments.length === 1 ? '' : 's'}`);
  parts.push(`${pendingCount} pending`);
  parts.push(`${completedCount} done`);
  if (overdueCount > 0) parts.push(`${overdueCount} overdue`);

  return { totalAssignments: assignments.length, pendingCount, overdueCount, completedCount, summary: parts.join(' · ') };
}

export function buildHomeworkPrompt(assignments: readonly HomeworkEntryLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family homework helper. Analyze the family's homework assignments and suggest study strategies. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable homework suggestion"],
  "studyTips": ["helpful study strategy or time management tip"],
  "priorityTip": "one short tip about which assignment to tackle first"
}

Rules:
- suggestions: max 4 practical suggestions based on current assignments
- studyTips: max 3 study strategies or time management tips
- priorityTip: one concrete tip about prioritization
- Focus on overdue items, upcoming deadlines, and subject balance.`;

  const assignList = assignments.map((a) =>
    `${a.title} (${a.subject ?? 'General'}, ${a.status}${a.due_at ? `, due: ${a.due_at.slice(0, 10)}` : ''})`
  ).join('\n');
  const user = `The family has ${assignments.length} homework assignments:\n\n${assignList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type HomeworkAIResponse = {
  suggestions: string[];
  studyTips: string[];
  priorityTip: string;
};

export function parseHomeworkResponse(raw: string): HomeworkAIResponse {
  const empty: HomeworkAIResponse = { suggestions: [], studyTips: [], priorityTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      studyTips: Array.isArray(parsed.studyTips)
        ? parsed.studyTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      priorityTip: typeof parsed.priorityTip === 'string' ? parsed.priorityTip : '',
    };
  } catch {
    return empty;
  }
}
