// lib/habits/presets.ts — habit presets, starting with hydration (TODO-0416).
//
// "Can't stay hydrated" is the lightest-weight problem in the opportunity
// table: a reminder plus a streak. Bubaly's habit engine already does streaks,
// reminders and heat-maps, so hydration ships as first-class presets with an
// age-based daily target and one-tap "+1 cup" logging rather than a separate
// app. Presets are pure data; the module turns them into `habits` rows.

export type PresetCategory = 'hydration' | 'movement' | 'sleep' | 'mind' | 'home';

export type HabitPreset = {
  key: string;
  category: PresetCategory;
  title: string;
  description: string;
  emoji: string;
  color: string;
  cadence: 'daily' | 'weekly';
  /** Daily count target (cups, refills…) or weekly times. `'by_age'` = hydration target from the member's age. */
  target: number | 'by_age';
  /** Unit shown next to the counter for count habits. */
  unit?: string;
};

/**
 * Cups (~8 oz / 240 ml) of water a day by age, rounded from the usual
 * paediatric and adult guidance (total fluids, minus what food provides).
 * Null age = an adult default.
 */
export function recommendedCupsPerDay(age: number | null | undefined): number {
  if (age === null || age === undefined) return 8;
  if (age < 1) return 1;
  if (age <= 3) return 4;
  if (age <= 8) return 5;
  if (age <= 13) return 7;
  if (age <= 18) return 9;
  return 8;
}

export const HABIT_PRESETS: HabitPreset[] = [
  { key: 'water-cups', category: 'hydration', title: 'Drink water', description: 'A cup at a time. The target follows your age; tap +1 each glass.', emoji: '💧', color: 'sky', cadence: 'daily', target: 'by_age', unit: 'cups' },
  { key: 'bottle-refills', category: 'hydration', title: 'Refill the water bottle', description: 'Three refills of a 500 ml bottle is a day’s water for most people.', emoji: '🚰', color: 'sky', cadence: 'daily', target: 3, unit: 'refills' },
  { key: 'water-before-meals', category: 'hydration', title: 'Water before each meal', description: 'One glass before breakfast, lunch and dinner — the easiest three cups of the day.', emoji: '🥛', color: 'teal', cadence: 'daily', target: 3, unit: 'glasses' },
  { key: 'morning-glass', category: 'hydration', title: 'Glass of water on waking', description: 'Before coffee, before the phone.', emoji: '🌅', color: 'amber', cadence: 'daily', target: 1 },
  { key: 'no-sugary-drinks', category: 'hydration', title: 'No sugary drinks today', description: 'Water, milk or plain tea instead of soda and juice boxes.', emoji: '🚫', color: 'rose', cadence: 'daily', target: 1 },
  { key: 'walk', category: 'movement', title: 'Walk 20 minutes', description: 'Around the block after dinner counts.', emoji: '🚶', color: 'emerald', cadence: 'daily', target: 1 },
  { key: 'stretch', category: 'movement', title: 'Stretch', description: 'Five minutes, any time.', emoji: '🧘', color: 'violet', cadence: 'daily', target: 1 },
  { key: 'screens-off', category: 'sleep', title: 'Screens off an hour before bed', description: 'The single habit that moves sleep the most.', emoji: '📵', color: 'indigo', cadence: 'daily', target: 1 },
  { key: 'read', category: 'mind', title: 'Read 15 minutes', description: 'Paper or e-reader, not the feed.', emoji: '📖', color: 'amber', cadence: 'daily', target: 1 },
  { key: 'tidy-10', category: 'home', title: '10-minute tidy', description: 'One timer, one room.', emoji: '🧹', color: 'teal', cadence: 'daily', target: 1 },
];

export const PRESET_CATEGORIES: { value: PresetCategory; label: string }[] = [
  { value: 'hydration', label: 'Hydration' }, { value: 'movement', label: 'Movement' }, { value: 'sleep', label: 'Sleep' }, { value: 'mind', label: 'Mind' }, { value: 'home', label: 'Home' },
];

export const presetByKey = (key: string) => HABIT_PRESETS.find((p) => p.key === key) ?? null;

/** Resolve a preset's target for a member. */
export function presetTarget(preset: HabitPreset, age: number | null | undefined): number {
  return preset.target === 'by_age' ? recommendedCupsPerDay(age) : preset.target;
}

export type HabitInsert = { title: string; description: string | null; color: string; cadence: 'daily' | 'weekly'; target_per_period: number; weekdays: number[]; member_id: string | null };

/** The `habits` row a preset becomes for a member (age only matters for by-age targets). */
export function presetToHabit(preset: HabitPreset, member: { id: string | null; age: number | null | undefined }): HabitInsert {
  const target = presetTarget(preset, member.age);
  const detail = preset.target === 'by_age' ? `${preset.description} Target: ${target} cups a day.` : preset.description;
  return { title: `${preset.emoji} ${preset.title}`, description: detail, color: preset.color, cadence: preset.cadence, target_per_period: target, weekdays: [], member_id: member.id };
}

export type LogLike = { habit_id: string; log_date: string; count: number };

/** Today's total for a count habit and whether the target is met. */
export function dayProgress(logs: LogLike[], habitId: string, date: string, target: number): { count: number; target: number; pct: number; done: boolean } {
  const count = logs.filter((l) => l.habit_id === habitId && l.log_date === date).reduce((a, l) => a + l.count, 0);
  return { count, target, pct: target ? Math.min(100, Math.round((count / target) * 100)) : 0, done: count >= Math.max(1, target) };
}

/**
 * Dates on which a habit counted as done: any log for a target-of-one habit,
 * the day's total reaching the target for a count habit. Streaks and the
 * heat-map consume this, so a half-finished water day does not extend a streak.
 */
export function doneDates(logs: LogLike[], habitId: string, target: number): string[] {
  const totals = new Map<string, number>();
  for (const l of logs) if (l.habit_id === habitId) totals.set(l.log_date, (totals.get(l.log_date) ?? 0) + l.count);
  return [...totals.entries()].filter(([, c]) => c >= Math.max(1, target)).map(([d]) => d);
}

/** How to nudge a count habit mid-day, from the hour and the progress. */
export function hydrationNudge(progress: { count: number; target: number }, hour: number): string | null {
  if (progress.target <= 1) return null;
  if (progress.count >= progress.target) return 'Target met — nice.';
  const expected = Math.round((Math.min(22, Math.max(7, hour)) - 7) / 15 * progress.target);
  if (progress.count < expected - 1) return `${expected - progress.count} behind pace for this time of day`;
  return null;
}
