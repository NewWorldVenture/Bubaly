// lib/onboarding/flow.ts — the pure engine behind the world-class onboarding
// journey. The wizard is a thin renderer over this: step order + gating,
// a sessionStorage-safe draft (SECURITY: the PIN is never serialized), a smart
// family-name suggestion, and the personalization payoff — mapping the goals a
// family picked onto real feature deep-links for their first-run launchpad.
// Deterministic + DOM-free so every rule is unit-tested.

import type { DraftMember } from '@/lib/onboarding/draft';
import { FAMILY_GOALS } from '@/lib/onboarding/family';
import { splitFullName } from '@/lib/onboarding/profile';

// ── Steps ───────────────────────────────────────────────────────────────────

export type FlowStep = 'you' | 'family' | 'people' | 'goals' | 'pin' | 'done';

/** Wizard order. `done` is terminal and excluded from the progress denominator. */
export const FLOW_STEPS: FlowStep[] = ['you', 'family', 'people', 'goals', 'pin', 'done'];

export const STEP_LABELS: Record<FlowStep, string> = {
  you: 'You',
  family: 'Your family',
  people: 'Your people',
  goals: 'What matters',
  pin: 'App lock',
  done: 'Done',
};

/** Steps a user may skip without blocking first value. */
const SKIPPABLE: ReadonlySet<FlowStep> = new Set(['people', 'goals', 'pin']);
export function isSkippable(step: FlowStep): boolean {
  return SKIPPABLE.has(step);
}

export function nextStep(step: FlowStep): FlowStep {
  const i = FLOW_STEPS.indexOf(step);
  return FLOW_STEPS[Math.min(i + 1, FLOW_STEPS.length - 1)];
}
export function prevStep(step: FlowStep): FlowStep {
  const i = FLOW_STEPS.indexOf(step);
  return FLOW_STEPS[Math.max(i - 1, 0)];
}

/** 0–100 progress; `you` starts above zero so the bar never looks stalled. */
export function progressPct(step: FlowStep): number {
  const active = FLOW_STEPS.length - 1; // exclude `done`
  const i = Math.min(FLOW_STEPS.indexOf(step), active);
  return Math.round(((i + 1) / active) * 100);
}

// ── Draft ───────────────────────────────────────────────────────────────────

export interface OnboardingDraft {
  version: 1;
  step: FlowStep;
  fullName: string;
  avatarUrl: string;
  color: string;
  age: string;              // '' = prefer not to say
  familyName: string;
  householdAdults: number;
  householdChildren: number;
  childAges: number[];
  members: DraftMember[];
  goals: string[];
  referralSource: string;
}

export const DRAFT_KEY = 'bubaly.onboarding.draft.v1';

export function emptyDraft(): OnboardingDraft {
  return {
    version: 1, step: 'you',
    fullName: '', avatarUrl: '', color: '', age: '',
    familyName: '', householdAdults: 2, householdChildren: 0, childAges: [],
    members: [], goals: [], referralSource: '',
  };
}

/** Serialize for sessionStorage. The PIN is intentionally NOT part of the draft. */
export function serializeDraft(d: OnboardingDraft): string {
  return JSON.stringify(d);
}

/** Parse a stored draft; anything malformed/mismatched falls back to null. */
export function hydrateDraft(raw: string | null | undefined): OnboardingDraft | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<OnboardingDraft>;
    if (p?.version !== 1 || typeof p.fullName !== 'string') return null;
    const base = emptyDraft();
    const step: FlowStep = FLOW_STEPS.includes(p.step as FlowStep) && p.step !== 'done'
      ? (p.step as FlowStep) : 'you';
    return {
      ...base,
      ...p,
      step,
      members: Array.isArray(p.members) ? (p.members as DraftMember[]) : [],
      childAges: Array.isArray(p.childAges) ? p.childAges.filter((n) => Number.isInteger(n)) : [],
      goals: Array.isArray(p.goals) ? p.goals.filter((g) => typeof g === 'string') : [],
      version: 1,
    };
  } catch {
    return null;
  }
}

// ── Per-step gating ─────────────────────────────────────────────────────────

/** Can the user leave this step going forward? (Skippable steps always can.) */
export function canContinue(step: FlowStep, d: OnboardingDraft): boolean {
  switch (step) {
    case 'you': return d.fullName.trim().length >= 1;
    case 'family': return d.familyName.trim().length >= 2;
    case 'people':
    case 'goals':
    case 'pin':
    case 'done':
      return true;
  }
}

// ── Personalization ─────────────────────────────────────────────────────────

/** "Jordan Lee" → "The Lee Family"; "Jordan" → "Jordan's Family". */
export function suggestFamilyName(fullName: string): string {
  const { firstName, lastName } = splitFullName(fullName);
  if (lastName) return `The ${lastName} Family`;
  if (firstName) return `${firstName}'s Family`;
  return 'Our Family';
}

export interface QuickstartItem {
  goal: string;       // the goal value it came from
  label: string;      // human action, e.g. "Plan this week's meals"
  href: string;       // real in-app destination
  icon: string;       // emoji (matches the goal chips)
}

/** Each pickable goal maps to a concrete first action inside the product. */
const GOAL_ACTIONS: Record<string, { label: string; href: string }> = {
  chores:     { label: 'Set up your first chores & allowance', href: '/dashboard/chores' },
  calendar:   { label: 'Add your family calendar events',      href: '/dashboard/calendar' },
  meals:      { label: "Plan this week's meals",               href: '/dashboard/meals' },
  groceries:  { label: 'Start your shared grocery list',       href: '/dashboard/grocery' },
  budget:     { label: 'Create your family budget',            href: '/dashboard/budgets' },
  health:     { label: 'Track health & medications',           href: '/dashboard/health' },
  school:     { label: 'Organize school & homework',           href: '/dashboard/school' },
  activities: { label: 'Manage sports & activities',           href: '/dashboard/family-sports' },
};

const GOAL_ICONS = new Map(FAMILY_GOALS.map((g) => [g.value, g.icon]));

/**
 * The personalized launchpad: the user's chosen goals as concrete first
 * actions, order-preserving, unknown values dropped, capped so the finish
 * screen stays scannable. Empty goals → a sensible default trio.
 */
export function goalQuickstart(goals: readonly string[], max = 4): QuickstartItem[] {
  const picked = goals
    .filter((g) => GOAL_ACTIONS[g])
    .slice(0, max)
    .map((g) => ({ goal: g, ...GOAL_ACTIONS[g], icon: GOAL_ICONS.get(g) ?? '✨' }));
  if (picked.length > 0) return picked;
  return ['calendar', 'groceries', 'chores'].map((g) => ({
    goal: g, ...GOAL_ACTIONS[g], icon: GOAL_ICONS.get(g) ?? '✨',
  }));
}

/** Browser timezone with a safe fallback (pure wrapper for testability). */
export function detectTimezone(resolve: () => string | undefined = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  try {
    return resolve() || 'UTC';
  } catch {
    return 'UTC';
  }
}
