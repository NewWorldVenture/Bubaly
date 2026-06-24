export type HealthInsights = {
  totalMetrics: number;
  totalWorkouts: number;
  totalGoals: number;
  summary: string;
};

export interface HealthMetricForAI {
  type: string;
  value: number;
  recorded_at: string;
}

export interface WorkoutForAI {
  activity: string;
  duration_minutes: number | null;
  calories: number | null;
  recorded_at: string;
}

export function analyzeHealth(metrics: HealthMetricForAI[], workouts: WorkoutForAI[], goalCount: number): HealthInsights {
  const summary = metrics.length === 0 && workouts.length === 0
    ? 'No health data tracked yet.'
    : `${metrics.length} health readings, ${workouts.length} workouts logged. ${goalCount} active goals.`;

  return { totalMetrics: metrics.length, totalWorkouts: workouts.length, totalGoals: goalCount, summary };
}

export function buildHealthPrompt(metrics: HealthMetricForAI[], workouts: WorkoutForAI[]) {
  const system = `You are a family wellness advisor. Analyze health and fitness data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"wellnessTips":["..."],"motivationTip":"..."}
suggestions: up to 4 actionable ideas. wellnessTips: up to 3 tips. motivationTip: one motivational sentence about healthy habits.`;

  const user = `Health metrics:\n${JSON.stringify(metrics.slice(0, 30))}\nWorkouts:\n${JSON.stringify(workouts.slice(0, 30))}`;
  return { system, user };
}

export type HealthAIResponse = {
  suggestions: string[];
  wellnessTips: string[];
  motivationTip: string;
};

export function parseHealthResponse(raw: string): HealthAIResponse {
  const empty: HealthAIResponse = { suggestions: [], wellnessTips: [], motivationTip: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4) : [],
      wellnessTips: Array.isArray(parsed.wellnessTips) ? parsed.wellnessTips.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
      motivationTip: typeof parsed.motivationTip === 'string' ? parsed.motivationTip : '',
    };
  } catch { return empty; }
}
