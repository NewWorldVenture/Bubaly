// lib/onboarding/completeness.ts — pure, unit-tested onboarding completeness.
//
// Turns the raw facts we know about an account (does it have a display name? did
// it fill the household questionnaire? did it engage the value step? has it more
// than one member?) into a single completeness verdict:
//   • a 0..100 score (weighted), so we can rank/segment accounts,
//   • the concrete MISSING pieces (each with a label + where to fix it), so the
//     "finish setting up" nudge is specific, not vague,
//   • a lifecycle status and the two flags that drive re-onboarding:
//       needsSetup  — the account skipped the questionnaire entirely (the huge
//                     auto-provisioned cohort) — invite them to finish,
//       needsReset  — onboarding was explicitly reset — send them through again.
//
// DB-free & deterministic so it's testable without Supabase; the server helper
// (lib/server/onboarding-progress.ts) supplies the signals and persists the score.

export type OnboardingLifecycle = 'in_progress' | 'completed' | 'reset';

/** The raw facts the completeness verdict is computed from. */
export interface CompletenessSignals {
  /** The account holder set a real display name (not an email-derived fallback). */
  hasName: boolean;
  /** The family space exists (always true once provisioned). */
  hasFamily: boolean;
  /** A family_onboarding questionnaire row exists (goals/household/referral). */
  hasQuestionnaire: boolean;
  /** At least one goal was chosen. */
  hasGoals: boolean;
  /** The value step was engaged — a calendar was imported (or the sample tried). */
  valueEngaged: boolean;
  /** More than just the account holder — someone was added or invited. */
  memberCount: number;
  /** An App Lock PIN was seeded. */
  hasPin: boolean;
  /** How the space was created — 'auto_provision' means the wizard was skipped. */
  source: string;
  /** The persisted lifecycle status, if any. */
  status?: OnboardingLifecycle | null;
}

export interface MissingPiece {
  key: string;
  label: string;
  /** Where the user goes to complete it. */
  href: string;
  /** Weight this piece contributes to the score (also its nudge priority). */
  weight: number;
}

export interface CompletenessResult {
  /** 0..100, weighted across the pieces below. */
  score: number;
  /** Pieces still to do, most valuable first. */
  missing: MissingPiece[];
  /** True when nothing meaningful is left. */
  isComplete: boolean;
  /** Skipped the questionnaire entirely (auto-provisioned) — invite to finish. */
  needsSetup: boolean;
  /** Onboarding was explicitly reset — route back through it. */
  needsReset: boolean;
  /** A short, human status for the nudge card. */
  headline: string;
}

// Each onboarding "piece", its weight (sums to 100), and where it's completed.
// Ordered by weight so `missing` naturally lists the most valuable gap first.
const PIECES: Array<{ key: string; label: string; href: string; weight: number; done: (s: CompletenessSignals) => boolean }> = [
  { key: 'name',          label: 'Add your name',                    href: '/dashboard/setup',           weight: 15, done: (s) => s.hasName },
  { key: 'questionnaire', label: 'Tell us about your family',        href: '/dashboard/setup',           weight: 25, done: (s) => s.hasQuestionnaire },
  { key: 'goals',         label: 'Pick what you want help with',     href: '/dashboard/setup',           weight: 15, done: (s) => s.hasGoals },
  { key: 'value',         label: 'Connect your calendar',            href: '/dashboard/setup',           weight: 20, done: (s) => s.valueEngaged },
  { key: 'members',       label: 'Add your family',                  href: '/dashboard/family-access',   weight: 15, done: (s) => s.memberCount >= 1 },
  { key: 'pin',           label: 'Protect your profile with a PIN',  href: '/dashboard/settings',        weight: 10, done: (s) => s.hasPin },
];

/** The steps whose absence means "this account never really onboarded". */
const CORE_KEYS = new Set(['questionnaire', 'goals']);

export function computeCompleteness(signals: CompletenessSignals): CompletenessResult {
  const missing: MissingPiece[] = [];
  let score = 0;
  for (const p of PIECES) {
    if (p.done(signals)) score += p.weight;
    else missing.push({ key: p.key, label: p.label, href: p.href, weight: p.weight });
  }
  // Highest-value gap first.
  missing.sort((a, b) => b.weight - a.weight);

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  // "Complete" = all the CORE pieces are done (optional pieces like PIN/value
  // don't block completion, but they still cost score so the nudge can surface).
  const coreMissing = missing.some((m) => CORE_KEYS.has(m.key));
  const isComplete = !coreMissing;

  const needsReset = signals.status === 'reset';
  // Auto-provisioned accounts that never filled the questionnaire are the classic
  // "needs setup" cohort — offer to finish, unless they've since completed it.
  const needsSetup = !needsReset && !isComplete && (signals.source === 'auto_provision' || signals.status !== 'completed');

  const headline = needsReset
    ? 'Let’s set your family up again'
    : isComplete
      ? 'Your family is fully set up'
      : needsSetup
        ? 'Finish setting up your family'
        : 'A few things left to set up';

  return { score: clamped, missing, isComplete, needsSetup, needsReset, headline };
}

/** Map a completeness result to the durable lifecycle status we persist. */
export function statusFromCompleteness(r: CompletenessResult): OnboardingLifecycle {
  if (r.needsReset) return 'reset';
  return r.isComplete ? 'completed' : 'in_progress';
}
