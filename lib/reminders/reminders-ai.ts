export type RemindersInsights = {
  totalReminders: number;
  activeCount: number;
  completedCount: number;
  overdueCount: number;
  priorityCounts: Record<string, number>;
  summary: string;
};

export interface ReminderForAI {
  title: string;
  kind: string;
  priority: string;
  status: string;
  remind_at: string | null;
  recurrence: string;
}

export function analyzeReminders(reminders: ReminderForAI[]): RemindersInsights {
  const priorityCounts: Record<string, number> = {};
  let activeCount = 0;
  let completedCount = 0;
  let overdueCount = 0;
  const now = new Date();

  for (const r of reminders) {
    priorityCounts[r.priority] = (priorityCounts[r.priority] ?? 0) + 1;
    if (r.status === 'completed') completedCount++;
    else {
      activeCount++;
      if (r.remind_at && new Date(r.remind_at) < now) overdueCount++;
    }
  }

  const summary = reminders.length === 0
    ? 'No reminders set yet.'
    : `${reminders.length} reminders: ${activeCount} active, ${completedCount} completed. ${overdueCount} overdue.`;

  return { totalReminders: reminders.length, activeCount, completedCount, overdueCount, priorityCounts, summary };
}

export function buildRemindersPrompt(reminders: ReminderForAI[]) {
  const system = `You are a productivity advisor. Analyze reminder data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"organizationTips":["..."],"priorityAdvice":"..."}
suggestions: up to 4 actionable ideas. organizationTips: up to 3 tips. priorityAdvice: one sentence about prioritization.`;

  const user = `Reminders:\n${JSON.stringify(reminders.slice(0, 50))}`;
  return { system, user };
}

export type RemindersAIResponse = {
  suggestions: string[];
  organizationTips: string[];
  priorityAdvice: string;
};

export function parseRemindersResponse(raw: string): RemindersAIResponse {
  const empty: RemindersAIResponse = { suggestions: [], organizationTips: [], priorityAdvice: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4) : [],
      organizationTips: Array.isArray(parsed.organizationTips) ? parsed.organizationTips.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
      priorityAdvice: typeof parsed.priorityAdvice === 'string' ? parsed.priorityAdvice : '',
    };
  } catch { return empty; }
}
