// lib/home/home-brief.ts — the "outcome, never empty" home brief (T3). When a
// family is new or quiet, the AI home should show an OUTCOME — how ready the week
// is, the next best getting-started steps, and dinner ideas — instead of empty
// widgets. Pure + deterministic: given the family's own upcoming events, a couple
// of counts, and the curated dinner catalog, it produces that outcome. Reuses the
// onboarding first-brief engine for the calendar-derived bits so the home and the
// first-run screen tell the same story. DOM-free + fully unit-tested.

import { buildFirstBrief, type BriefEvent } from '@/lib/onboarding/first-brief';
import { type DinnerIdea } from '@/lib/onboarding/dinner-ideas';
import type { HomeBriefDisplay, HomeStepDisplay } from './home-brief-display';

export interface HomeStep {
  id: string;
  label: string;
  detail: string;
  href: string;
  done: boolean;
  /** Optional presentation facts; never part of the persisted summary. */
  display?: HomeStepDisplay;
}

export interface HomeBriefInput {
  /** The already-resolved family timezone; legacy callers default to UTC. */
  timezone?: string;
  /** Events in the next ~7 days (already family-scoped). */
  upcomingEvents: BriefEvent[];
  dinnerCandidates: DinnerIdea[];
  choresPending: number;
  openTodos: number;
  groceryOpen: number;
  memberCount: number;
}

export interface HomeBrief {
  isSparse: boolean;
  headline: string;
  readinessPct: number;      // 0..100 — how set-up the week is
  weekCount: number;
  conflictCount: number;
  timeSavedMinutes: number;
  steps: HomeStep[];         // getting-started outcomes, unfinished first
  dinnerIdeas: DinnerIdea[];
  display?: HomeBriefDisplay;
}

/**
 * Build the home outcome. `isSparse` marks a brand-new/quiet family (little in the
 * next week, nothing pending) — for them the home leads with getting-started steps
 * and dinner ideas rather than an "all caught up" void. Steps are real outcomes,
 * each marked done from the family's actual state, so readiness is honest.
 */
export function buildHomeBrief(input: HomeBriefInput, now: Date): HomeBrief {
  const upcoming = input.upcomingEvents ?? [];
  // Reuse the onboarding engine for conflicts / time-saved / dinner ideas so the
  // home and the first-run screen compute value the same way.
  const fb = buildFirstBrief(upcoming, now, input.dinnerCandidates ?? [], input.timezone);

  const weekCount = upcoming.length;
  const hasChores = input.choresPending > 0;
  const hasTodos = input.openTodos > 0;
  const hasGrocery = input.groceryOpen > 0;
  const hasFamily = input.memberCount > 1;

  const steps: HomeStep[] = [
    {
      id: 'calendar', label: 'Fill in your week',
      detail: weekCount > 0 ? `${weekCount} event${weekCount === 1 ? '' : 's'} on the calendar.` : 'Add what’s happening this week.',
      href: '/dashboard/calendar', done: weekCount > 0,
      display: { version: 1, kind: 'calendar', eventCount: weekCount },
    },
    {
      id: 'meals', label: 'Plan this week’s dinners',
      detail: fb.dinnerIdeas.length > 0 ? `Start with ${fb.dinnerIdeas[0].title}.` : 'Pick a few dinners so nights run smoother.',
      href: '/dashboard/meals', done: false,
      display: { version: 1, kind: 'meals', dinnerTitle: fb.dinnerIdeas[0]?.title ?? null },
    },
    {
      id: 'family', label: 'Invite your family',
      detail: hasFamily ? 'Your people are in.' : 'Add a partner or give the kids a login.',
      href: '/dashboard/family-access', done: hasFamily,
      display: { version: 1, kind: 'family' },
    },
    {
      id: 'grocery', label: 'Start a grocery list',
      detail: hasGrocery ? 'Your list is going.' : 'Jot what you’re out of — share it with everyone.',
      href: '/dashboard/grocery', done: hasGrocery,
      display: { version: 1, kind: 'grocery' },
    },
    {
      id: 'chores', label: 'Set up chores',
      detail: hasChores ? 'Chores are assigned.' : 'Share the load with a simple routine.',
      href: '/dashboard/chores', done: hasChores,
      display: { version: 1, kind: 'chores' },
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const readinessPct = Math.round((doneCount / steps.length) * 100);
  // Unfinished steps first (that's the call to action), then the done ones.
  const orderedSteps = [...steps.filter((s) => !s.done), ...steps.filter((s) => s.done)];

  // Sparse = a brand-new/quiet family: little coming up and nothing pending.
  const isSparse = weekCount < 3 && !hasChores && !hasTodos && !hasGrocery;

  let headline: string;
  let display: HomeBriefDisplay;
  if (isSparse) {
    display = { version: 1, headline: 'sparse' };
    headline = 'Let’s make this week easier — a few quick wins to set up.';
  } else if (fb.conflicts.length > 0) {
    display = { version: 1, headline: 'conflicts' };
    headline = `You’re rolling — ${weekCount} event${weekCount === 1 ? '' : 's'} ahead, ${fb.conflicts.length} clash${fb.conflicts.length === 1 ? '' : 'es'} to smooth out.`;
  } else {
    display = { version: 1, headline: 'clear' };
    headline = `You’re in good shape — ${weekCount} event${weekCount === 1 ? '' : 's'} this week and nothing urgent.`;
  }

  return {
    isSparse,
    headline,
    readinessPct,
    weekCount,
    conflictCount: fb.conflicts.length,
    timeSavedMinutes: fb.timeSavedMinutes,
    steps: orderedSteps,
    dinnerIdeas: fb.dinnerIdeas,
    display,
  };
}

/** Compact summary persisted to home_briefs.brief. */
export function homeBriefSummary(brief: HomeBrief): Record<string, unknown> {
  return {
    headline: brief.headline,
    readinessPct: brief.readinessPct,
    isSparse: brief.isSparse,
    weekCount: brief.weekCount,
    conflictCount: brief.conflictCount,
    dinnerCount: brief.dinnerIdeas.length,
    timeSavedMinutes: brief.timeSavedMinutes,
    steps: brief.steps.map((s) => ({ id: s.id, done: s.done })),
  };
}
