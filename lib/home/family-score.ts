// lib/home/family-score.ts — a deterministic 0–100 "Family Score" derived from
// live family signals (chores kept up, tasks on track, reminders not slipping).
// PURE (no I/O) so the Home dashboard reads real Supabase counts, passes them
// here, and shows an honest, explainable score. Unit-tested.

export type FamilyScoreInput = {
  /** Chores scheduled for today (assignments due today, any status). */
  choresToday: number;
  /** Of those, the ones completed/approved. */
  choresDone: number;
  /** Open to-do items past their due date. */
  tasksOverdue: number;
  /** Active reminders whose time has already passed. */
  overdueReminders: number;
};

export type FamilyScore = { score: number; grade: string; message: string };

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** Letter grade for a 0–100 score. */
export function scoreGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/** A warm, human one-liner for the score band. */
export function scoreMessage(score: number): string {
  if (score >= 90) return "Great job! You're all staying organized and connected.";
  if (score >= 75) return "Looking good — your family is on top of things.";
  if (score >= 60) return "Solid. A few things could use a little attention.";
  return "Let's catch up together — a few things are slipping.";
}

/**
 * Compute the Family Score. Starts at 100 and applies bounded, explainable
 * penalties: incomplete chores (up to −25, proportional), overdue tasks
 * (−5 each, capped −25), and overdue reminders (−5 each, capped −20). A family
 * with nothing slipping scores 100; the worst case floors at 0.
 */
export function familyScore(i: FamilyScoreInput): FamilyScore {
  let score = 100;
  if (i.choresToday > 0) {
    const rate = Math.max(0, Math.min(1, i.choresDone / i.choresToday));
    score -= 25 * (1 - rate);
  }
  score -= Math.min(25, Math.max(0, i.tasksOverdue) * 5);
  score -= Math.min(20, Math.max(0, i.overdueReminders) * 5);
  score = Math.round(clamp(score));
  return { score, grade: scoreGrade(score), message: scoreMessage(score) };
}
