// Intent-Based UX — natural-language goal detection (pure, unit-tested, DB-free).
//
// The command bar already handles navigate + capture ("remind me to…"). This adds
// the missing layer: recognizing a higher-level GOAL in plain language and routing
// it to the right reasoning engine. "should we do soccer or swim?" → Decision
// Engine. "get ready for the Denver trip" → Prep Plans. "are we ready for Monday?"
// → Life Readiness. One input → the family's system of execution, not a feature
// menu. Deterministic patterns => testable; the command bar surfaces the result.

export type FamilyIntent =
  | 'make_decision' | 'check_readiness' | 'plan_trip' | 'prep_for' | 'plan_meals';

export type IntentMatch = {
  intent: FamilyIntent;
  /** Where the goal is fulfilled. */
  href: string;
  /** Human CTA shown in the command bar ("Decide this → Decision Engine"). */
  label: string;
};

type Rule = { intent: FamilyIntent; href: string; cta: string; test: RegExp };

// Order matters: the first matching rule wins. Patterns are intentionally narrow
// so ordinary navigation/capture text doesn't trip them.
const RULES: Rule[] = [
  {
    intent: 'make_decision', href: '/dashboard/decisions', cta: 'Weigh this → Decision Engine',
    test: /\b(should we|should i|which (one|option)|help me (pick|decide|choose)|decide between|choose between|worth it|.+\bvs\.?\b.+|.+\bor\b.+\?)\b/i,
  },
  {
    intent: 'check_readiness', href: '/dashboard/readiness', cta: 'Check → Life Readiness',
    test: /\b(are we ready|am i ready|how ready|ready for (tomorrow|the week|this week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week))\b/i,
  },
  {
    intent: 'plan_trip', href: '/dashboard/prep-plans', cta: 'Plan it → Prep Plans',
    test: /\b(plan (a|our|the) (trip|vacation|getaway)|book (a|our) (trip|vacation)|going on (a )?(trip|vacation))\b/i,
  },
  {
    intent: 'prep_for', href: '/dashboard/prep-plans', cta: 'Prepare → Prep Plans',
    test: /\b(get ready for|getting ready for|prep(are)? for|what do i need for|what do we need for|checklist for)\b/i,
  },
  {
    intent: 'plan_meals', href: '/dashboard/meals', cta: 'Plan → Meals',
    test: /\b(plan (dinner|meals|the meals|this week'?s meals|our meals)|meal plan|what'?s for dinner|figure out dinner)\b/i,
  },
];

/** Detect a family goal in free text, or null if it's not a goal phrase. */
export function detectIntent(text: string): IntentMatch | null {
  const q = text.trim();
  if (q.length < 4) return null;
  for (const r of RULES) {
    if (r.test.test(q)) return { intent: r.intent, href: r.href, label: r.cta };
  }
  return null;
}
