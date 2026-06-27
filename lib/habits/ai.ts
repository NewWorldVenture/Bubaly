// lib/habits/ai.ts — pure prompt/parse helpers for the Habit AI Coach.
// The route gathers each habit's streak stats, asks the model to coach the
// person, and renders the structured reply. Kept pure for unit testing.

export type HabitStat = {
  title: string;
  cadence: 'daily' | 'weekly';
  currentStreak: number;
  longestStreak: number;
  completionRate: number; // 0..1 over trailing window
  doneToday: boolean;
};

export type HabitCoaching = {
  /** A short, warm overall message. */
  headline: string;
  /** Per-habit or cross-habit nudges the user can act on. */
  nudges: string[];
  /** One concrete suggestion for a NEW habit or tweak (optional). */
  suggestion: string;
};

export function buildCoachPrompt(stats: HabitStat[], firstName: string): { system: string; user: string } {
  const system = `You are the Bubaly habit coach — encouraging, specific, never preachy. You receive a person's habits with streak data and return STRUCTURED JSON only (no markdown, no code fences). Start with { end with }.

Shape:
{
  "headline": "one warm sentence celebrating progress or gently re-motivating",
  "nudges": ["specific, doable nudge tied to the data", "another"],
  "suggestion": "one concrete idea for a new habit or a tweak; empty string if none"
}

Rules:
- Reference real numbers (streaks, completion rates) — be specific, not generic.
- 2-4 nudges max. Celebrate strong streaks; for slipping habits, suggest the smallest next step.
- Warm and human. Address ${firstName} by name in the headline.
- Never shame. If everything's great, say so and suggest leveling up.`;

  const lines = stats.map(
    (s) =>
      `- ${s.title} (${s.cadence}): streak ${s.currentStreak}, best ${s.longestStreak}, ${Math.round(
        s.completionRate * 100,
      )}% last 30d, ${s.doneToday ? 'done today' : 'not done today'}`,
  );
  const user = `Coach ${firstName}. Their habits:\n${lines.join('\n') || '- (no habits yet)'}\n\nReturn the JSON now.`;
  return { system, user };
}

function asStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0)
    .slice(0, max);
}

export function parseCoachResponse(raw: string): HabitCoaching {
  const empty: HabitCoaching = { headline: '', nudges: [], suggestion: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return empty;
  }
  return {
    headline: typeof parsed.headline === 'string' ? parsed.headline.trim() : '',
    nudges: asStringArray(parsed.nudges, 4),
    suggestion: typeof parsed.suggestion === 'string' ? parsed.suggestion.trim() : '',
  };
}
