export type GoalsInsights = {
  totalGoals: number;
  activeCount: number;
  completedCount: number;
  avgProgress: number;
  summary: string;
};

export interface GoalEntryLike {
  title: string;
  description: string | null;
  target_date: string | null;
  progress: number;
  is_complete: boolean;
}

export function analyzeGoals(goals: readonly GoalEntryLike[]): GoalsInsights {
  let activeCount = 0;
  let completedCount = 0;
  let totalProgress = 0;

  for (const g of goals) {
    if (g.is_complete) {
      completedCount++;
    } else {
      activeCount++;
    }
    totalProgress += g.progress;
  }

  const avgProgress = goals.length > 0 ? Math.round(totalProgress / goals.length) : 0;

  const parts: string[] = [];
  parts.push(`${goals.length} goal${goals.length === 1 ? '' : 's'}`);
  parts.push(`${activeCount} active`);
  parts.push(`${completedCount} completed`);
  parts.push(`${avgProgress}% avg progress`);

  return { totalGoals: goals.length, activeCount, completedCount, avgProgress, summary: parts.join(' · ') };
}

export function buildGoalsPrompt(goals: readonly GoalEntryLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family goal coach. Analyze the family's goals and suggest motivational strategies. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable goal-setting suggestion"],
  "motivationTips": ["tip for staying motivated and on track"],
  "focusAdvice": "one short piece of advice for prioritizing goals"
}

Rules:
- suggestions: max 4 practical suggestions based on current goals
- motivationTips: max 3 tips for maintaining momentum
- focusAdvice: one concrete recommendation
- Focus on achievable milestones, accountability, and celebrating progress.`;

  const goalList = goals.map((g) =>
    `${g.title} (${g.progress}%${g.is_complete ? ', DONE' : ''}${g.target_date ? `, target: ${g.target_date}` : ''}${g.description ? `, ${g.description}` : ''})`
  ).join('\n');
  const user = `The family has ${goals.length} goals:\n\n${goalList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type GoalsAIResponse = {
  suggestions: string[];
  motivationTips: string[];
  focusAdvice: string;
};

export function parseGoalsResponse(raw: string): GoalsAIResponse {
  const empty: GoalsAIResponse = { suggestions: [], motivationTips: [], focusAdvice: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      motivationTips: Array.isArray(parsed.motivationTips)
        ? parsed.motivationTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      focusAdvice: typeof parsed.focusAdvice === 'string' ? parsed.focusAdvice : '',
    };
  } catch {
    return empty;
  }
}
