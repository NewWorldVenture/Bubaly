// The categories a family dials Bubaly's autonomy on, in the order the
// settings page shows them.
//
// A category IS a trust domain — the same string the tool registry stamps on
// every tool and the trust engine evaluates — so a setting made here reaches
// the gate without a mapping table to drift. What this file adds is the human
// half: which domains are worth showing, in what order, with a sentence that
// says what the dial actually does, and the feature key each one belongs to so
// a family that cannot see a feature is not offered a dial for it.
import { FEATURE_CATALOG_BY_KEY } from '@/lib/constants/feature-catalog';
import { DOMAIN_LABELS, type TrustDomain } from '@/lib/trust/engine';

export type AICategory = {
  /** The trust domain, and therefore the key in `family_ai_settings.category_behavior`. */
  domain: TrustDomain;
  label: string;
  /** What Bubaly does in this category, in the family's words. */
  description: string;
  /** The catalog feature this category belongs to (`lib/constants/feature-catalog.ts`). */
  featureKey: string;
};

/** The domains Bubaly's tools actually write in — the registry's own list, ordered for people. */
export const AI_CATEGORIES: AICategory[] = [
  { domain: 'calendar', label: DOMAIN_LABELS.calendar, description: 'Adding, moving and cancelling events.', featureKey: 'calendar' },
  { domain: 'scheduling', label: DOMAIN_LABELS.scheduling, description: 'Finding times, resolving clashes and reminders.', featureKey: 'calendar' },
  { domain: 'tasks', label: DOMAIN_LABELS.tasks, description: 'Creating and assigning to-dos.', featureKey: 'tasks-chores' },
  { domain: 'chores', label: DOMAIN_LABELS.chores, description: 'Assigning chores and awarding what they earn.', featureKey: 'tasks-chores' },
  { domain: 'meal_planning', label: DOMAIN_LABELS.meal_planning, description: 'Planning the week’s meals and recipes.', featureKey: 'meals' },
  { domain: 'shopping', label: DOMAIN_LABELS.shopping, description: 'Building grocery lists from the plan.', featureKey: 'groceries' },
  { domain: 'messaging', label: DOMAIN_LABELS.messaging, description: 'Messages and announcements to the family.', featureKey: 'messages' },
  { domain: 'travel', label: DOMAIN_LABELS.travel, description: 'Trips: packing, readiness and documents.', featureKey: 'trip-intelligence' },
  { domain: 'home_maintenance', label: DOMAIN_LABELS.home_maintenance, description: 'Contractors, service records and upkeep.', featureKey: 'home-projects' },
  { domain: 'education', label: DOMAIN_LABELS.education, description: 'School dates, forms and homework.', featureKey: 'school' },
  { domain: 'finances', label: DOMAIN_LABELS.finances, description: 'Budgets and savings goals. Money moves always need a person.', featureKey: 'finances' },
  { domain: 'documents', label: DOMAIN_LABELS.documents, description: 'Filing and expiry reminders. Sharing always needs a person.', featureKey: 'documents' },
];

export const AI_CATEGORY_BY_DOMAIN: Record<string, AICategory> =
  Object.fromEntries(AI_CATEGORIES.map((c) => [c.domain, c]));

/** The categories a family can see, given the features their plan and admin leave on. */
export function visibleCategories(isFeatureOn: (key: string) => boolean): AICategory[] {
  return AI_CATEGORIES.filter((category) => isFeatureOn(category.featureKey));
}

/** Every category names a real catalog feature — a dial for a page nobody has is a lie. */
export function unknownFeatureKeys(): string[] {
  return AI_CATEGORIES.map((c) => c.featureKey).filter((key) => !FEATURE_CATALOG_BY_KEY[key]);
}
