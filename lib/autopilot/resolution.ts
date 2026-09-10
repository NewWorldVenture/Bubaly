import type { Tables } from '@/lib/database.types';

type Suggestion = Pick<Tables<'autopilot_suggestions'>, 'kind' | 'action_type' | 'status'>;
export type SuggestionAction =
  | { kind: 'reminder' | 'policy'; labelKey: string }
  | { kind: 'review'; labelKey: string; href: string }
  | { kind: 'unavailable'; labelKey: string };

// Persisted labels/payload URLs are descriptions, never executable routing input.
const REVIEW_ACTIONS: Record<string, { labelKey: string; href: string }> = {
  nudge: { labelKey: 'autopilotResolution.openChores', href: '/dashboard/chores' },
  plan_meals: { labelKey: 'autopilotResolution.openMeals', href: '/dashboard/meals' },
  plan_celebration: { labelKey: 'autopilotResolution.openCelebrations', href: '/dashboard/celebrations' },
  keep_grocery: { labelKey: 'autopilotResolution.openGroceries', href: '/dashboard/grocery' },
  add_groceries: { labelKey: 'autopilotResolution.openGroceries', href: '/dashboard/grocery' },
  review_conflict: { labelKey: 'autopilotResolution.openCalendar', href: '/dashboard/calendar' },
  review_subscription: { labelKey: 'autopilotResolution.openSubscriptions', href: '/dashboard/subscriptions' },
  review_wellbeing: { labelKey: 'autopilotResolution.openFamilyHealth', href: '/dashboard/family-health' },
};

export function suggestionAction(suggestion: Suggestion): SuggestionAction {
  if (suggestion.kind === 'policy') return suggestion.status === 'open'
    ? { kind: 'policy', labelKey: 'autopilotModule.trustBubalyWithThis' }
    : { kind: 'review', labelKey: 'autopilotResolution.openTrust', href: '/dashboard/trust' };
  if (suggestion.action_type === 'create_reminder') return suggestion.status === 'open'
    ? { kind: 'reminder', labelKey: 'autopilotResolution.saveReminder' }
    : { kind: 'review', labelKey: 'autopilotResolution.openReminders', href: '/dashboard/reminders' };
  const type = suggestion.action_type ?? '';
  const review = Object.hasOwn(REVIEW_ACTIONS, type) ? REVIEW_ACTIONS[type] : undefined;
  return review ? { kind: 'review', ...review } : { kind: 'unavailable', labelKey: 'autopilotResolution.noDirectAction' };
}
