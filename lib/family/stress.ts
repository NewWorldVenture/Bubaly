// lib/family/stress.ts
// Pure, deterministic family-load + stress scoring. No I/O, no DB — the page
// layer gathers real Supabase rows and feeds them in, so this stays unit-testable.
// This is a planning/wellbeing heuristic, NOT a medical assessment.

export type StressLevel = 'low' | 'moderate' | 'elevated' | 'high';

export type StressInput = {
  /** Events on the busiest single day in the window. */
  maxEventsPerDay: number;
  /** Count of back-to-back (gap < 30 min) event pairs across the window. */
  backToBackPairs: number;
  /** Tasks/chores past their due date and still open. */
  overdueTasks: number;
  /** School deadlines (homework/projects) due in the next 3 days. */
  schoolDeadlines: number;
  /** Sports events that collide with another event on the same day. */
  sportsConflicts: number;
  /** Health appointments in the next 7 days. */
  upcomingAppointments: number;
  /** Bills due in the next 7 days. */
  billsDueSoon: number;
  /** Optional self-reported low-sleep / off-routine notes logged this week. */
  routineDisruptions?: number;
};

export type StressFactor = { label: string; points: number; detail: string };

export type StressResult = {
  score: number; // 0–100
  level: StressLevel;
  factors: StressFactor[];
  suggestions: string[];
};

// Each factor contributes weighted points, then the total is clamped to 100.
const WEIGHTS = {
  maxEventsPerDay: 6, // per event over a comfortable threshold of 3
  backToBackPairs: 7,
  overdueTasks: 5,
  schoolDeadlines: 4,
  sportsConflicts: 8,
  upcomingAppointments: 3,
  billsDueSoon: 3,
  routineDisruptions: 6,
} as const;

const COMFORTABLE_EVENTS_PER_DAY = 3;

export function levelFor(score: number): StressLevel {
  if (score >= 75) return 'high';
  if (score >= 50) return 'elevated';
  if (score >= 25) return 'moderate';
  return 'low';
}

export function computeStress(input: StressInput): StressResult {
  const factors: StressFactor[] = [];
  const add = (raw: number, weight: number, label: string, detail: string) => {
    if (raw <= 0) return;
    const points = raw * weight;
    factors.push({ label, points, detail });
  };

  const overloadedDays = Math.max(0, input.maxEventsPerDay - COMFORTABLE_EVENTS_PER_DAY);
  add(overloadedDays, WEIGHTS.maxEventsPerDay, 'Overloaded day',
    `${input.maxEventsPerDay} events on your busiest day`);
  add(input.backToBackPairs, WEIGHTS.backToBackPairs, 'Back-to-back events',
    `${input.backToBackPairs} tightly packed transitions`);
  add(input.overdueTasks, WEIGHTS.overdueTasks, 'Overdue tasks',
    `${input.overdueTasks} tasks past due`);
  add(input.schoolDeadlines, WEIGHTS.schoolDeadlines, 'School deadlines',
    `${input.schoolDeadlines} due within 3 days`);
  add(input.sportsConflicts, WEIGHTS.sportsConflicts, 'Sports conflicts',
    `${input.sportsConflicts} same-day collisions`);
  add(input.upcomingAppointments, WEIGHTS.upcomingAppointments, 'Health appointments',
    `${input.upcomingAppointments} in the next week`);
  add(input.billsDueSoon, WEIGHTS.billsDueSoon, 'Bills due soon',
    `${input.billsDueSoon} due within 7 days`);
  add(input.routineDisruptions ?? 0, WEIGHTS.routineDisruptions, 'Routine disruption',
    `${input.routineDisruptions ?? 0} off-routine notes this week`);

  const rawTotal = factors.reduce((sum, f) => sum + f.points, 0);
  const score = Math.min(100, Math.round(rawTotal));
  const level = levelFor(score);
  factors.sort((a, b) => b.points - a.points);

  return { score, level, factors, suggestions: suggestionsFor(level, factors) };
}

function suggestionsFor(level: StressLevel, factors: StressFactor[]): string[] {
  if (level === 'low') {
    return ['The week looks balanced — no rescheduling needed right now.'];
  }
  const out: string[] = [];
  const top = factors.slice(0, 3).map((f) => f.label);
  if (top.includes('Sports conflicts')) {
    out.push('Resolve same-day sports collisions — split drop-offs or ask another parent to cover one.');
  }
  if (top.includes('Back-to-back events') || top.includes('Overloaded day')) {
    out.push('Add 15-minute buffers between back-to-back events, or move one item to a lighter day.');
  }
  if (top.includes('Overdue tasks')) {
    out.push('Knock out or reassign overdue tasks first — they compound the load.');
  }
  if (top.includes('School deadlines')) {
    out.push('Block focused homework time before the next deadline cluster.');
  }
  if (top.includes('Bills due soon')) {
    out.push('Schedule the upcoming bill payments now so they do not crowd a busy day.');
  }
  if (out.length === 0) {
    out.push('Lighten the busiest day by moving one flexible item to the weekend.');
  }
  return out;
}
