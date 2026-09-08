// lib/onboarding/facts.ts — turning onboarding answers into family memory.
//
// M30: the wizard asks a household how many adults and children it has, how old
// the children are, where it lives and what it wants Bubaly for — and then threw
// all of it into `family_onboarding`, a row nothing but the marketing segments
// ever read. The assistant went on asking "how many kids do you have?" to a
// family that had answered that question in its first two minutes.
//
// These are the person's OWN answers, typed into a form, so they belong in the
// confirmed lane (`family_facts`) rather than the suggestion inbox — there is
// nothing to accept, they already said it. Pure and DB-free: the server action
// maps the result through `rememberFact`, and the mapping is tested here.
//
// PROVENANCE. The audit asked for `source: 'onboarding'`, which the database
// will not take: `family_facts_source_check` (migration 0265) allows exactly
// 'user' | 'ai_conversation' | 'ai_inferred' | 'import'. Widening it is a
// migration, so the source stays 'user' — accurate, since a person typed every
// one of these — and WHERE it came from is carried in the note, which is also
// what the Family Memory UI shows. `ONBOARDING_FACT_NOTE` is the one string to
// change when the CHECK is widened.

import type { FactCategory } from '@/lib/memory/facts';
import { FAMILY_GOALS } from './family';

/** The note every onboarding-derived fact carries, and the marker to find them by. */
export const ONBOARDING_FACT_NOTE = 'Answered during onboarding';

/**
 * The `family_facts.source` these are written with. Not 'onboarding': see the
 * header — the CHECK constraint has four values and adding one is a migration.
 */
export const ONBOARDING_FACT_SOURCE = 'user' as const;

/** The answers the wizard collects that are worth remembering. */
export type OnboardingAnswers = {
  householdAdults: number;
  householdChildren: number;
  childAges: number[];
  region?: string | null;
  country?: string | null;
  goals: string[];
};

export type OnboardingFact = {
  category: FactCategory;
  /** The label a person looks the fact up under, in Family Memory. */
  key: string;
  content: string;
};

const GOAL_LABELS = new Map(FAMILY_GOALS.map((g) => [g.value, g.label]));

function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

/**
 * The facts an onboarding answer set is worth remembering, in a stable order.
 *
 * Only what the family actually answered: a household that skipped the "about"
 * step produces no facts at all, because a remembered "0 adults, 0 children" is
 * a false belief that would then steer a meal plan. Every value here is
 * something the person typed — nothing is inferred, guessed or scored.
 *
 * Keys are stable, so re-running onboarding (or the same answers arriving
 * twice) UPDATES the fact rather than stacking a second copy: `rememberFact`
 * matches a confirmed fact on (member, category, key).
 */
export function onboardingFacts(answers: OnboardingAnswers): OnboardingFact[] {
  const facts: OnboardingFact[] = [];

  const adults = Math.max(0, Math.trunc(answers.householdAdults || 0));
  const children = Math.max(0, Math.trunc(answers.householdChildren || 0));
  if (adults > 0 || children > 0) {
    const parts = [
      adults > 0 ? plural(adults, 'adult') : '',
      children > 0 ? (children === 1 ? '1 child' : `${children} children`) : '',
    ].filter(Boolean);
    facts.push({ category: 'about', key: 'Household size', content: parts.join(' and ') });
  }

  const ages = (answers.childAges ?? []).filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.trunc(n));
  if (ages.length > 0) {
    facts.push({ category: 'about', key: 'Children’s ages', content: ages.join(', ') });
  }

  const place = [answers.region?.trim(), answers.country?.trim()].filter(Boolean).join(', ');
  if (place) {
    facts.push({ category: 'about', key: 'Where the family lives', content: place });
  }

  const goals = (answers.goals ?? []).map((g) => GOAL_LABELS.get(g)).filter((l): l is string => !!l);
  if (goals.length > 0) {
    facts.push({ category: 'preference', key: 'What this family wants help with', content: goals.join(', ') });
  }

  return facts;
}
