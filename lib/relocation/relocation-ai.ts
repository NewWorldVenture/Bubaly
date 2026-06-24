export type RelocationInsights = {
  totalTasks: number;
  completedCount: number;
  pendingCount: number;
  summary: string;
};

export interface RelocationTaskForAI {
  title: string;
  status: string;
  category: string | null;
  due_date: string | null;
}

export function analyzeRelocation(tasks: RelocationTaskForAI[]): RelocationInsights {
  let completedCount = 0;
  let pendingCount = 0;

  for (const t of tasks) {
    if (t.status === 'done') completedCount++;
    else pendingCount++;
  }

  const summary = tasks.length === 0
    ? 'No relocation tasks tracked yet.'
    : `${tasks.length} tasks total. ${completedCount} completed, ${pendingCount} pending.`;

  return { totalTasks: tasks.length, completedCount, pendingCount, summary };
}

export function buildRelocationPrompt(tasks: RelocationTaskForAI[]) {
  const system = `You are a family relocation advisor. Analyze moving tasks and return ONLY valid JSON with this shape:
{"suggestions":["..."],"movingTips":["..."],"timelineTip":"..."}
suggestions: up to 4 actionable ideas. movingTips: up to 3 tips. timelineTip: one sentence about staying on track.`;

  const user = `Relocation tasks:\n${JSON.stringify(tasks.slice(0, 50))}`;
  return { system, user };
}

export type RelocationAIResponse = {
  suggestions: string[];
  movingTips: string[];
  timelineTip: string;
};

export function parseRelocationResponse(raw: string): RelocationAIResponse {
  const empty: RelocationAIResponse = { suggestions: [], movingTips: [], timelineTip: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4) : [],
      movingTips: Array.isArray(parsed.movingTips) ? parsed.movingTips.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
      timelineTip: typeof parsed.timelineTip === 'string' ? parsed.timelineTip : '',
    };
  } catch { return empty; }
}
