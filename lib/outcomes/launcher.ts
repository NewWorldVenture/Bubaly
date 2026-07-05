// Outcomes launcher (North Star pillar #4 — "Outcomes, not features"). Families
// think in goals ("feed the family", "plan a trip"), not in app modules. This
// pure engine maps each outcome to the underlying capabilities and, given a
// small snapshot of the family's real state, auto-selects + badges the steps
// that matter right now. DOM-free and fully unit-tested; the page feeds it real
// Supabase data and renders the plan.

export type OutcomeId =
  | 'run_today' | 'feed_family' | 'plan_trip' | 'prepare_school'
  | 'manage_money' | 'stay_healthy' | 'celebrate' | 'prepare_unexpected';

/** A small, real snapshot of the family's current state (all from Supabase). */
export type OutcomeContext = {
  eventsToday: number;
  overdueTasks: number;
  birthdaysSoon: number;   // within ~2 weeks
  openGrocery: number;     // unchecked grocery items
};

export const EMPTY_CONTEXT: OutcomeContext = { eventsToday: 0, overdueTasks: 0, birthdaysSoon: 0, openGrocery: 0 };

export type Outcome = {
  id: OutcomeId;
  title: string;
  tagline: string;
  /** icon key resolved to a lucide icon in the UI layer. */
  icon: string;
};

export type OutcomeStep = {
  label: string;
  detail: string;
  href: string;
  /** A small live count/label when the family's state makes this step urgent. */
  badge?: string;
};

/** The eight outcomes, in priority order. */
export const OUTCOMES: Outcome[] = [
  { id: 'run_today',          title: 'Run Today',                 tagline: "Everything today needs, in order.",        icon: 'sun' },
  { id: 'feed_family',        title: 'Feed the Family',           tagline: 'Plan meals, shop, and cook with less thinking.', icon: 'utensils' },
  { id: 'plan_trip',          title: 'Plan a Trip',               tagline: 'From idea to packed bags.',                icon: 'plane' },
  { id: 'prepare_school',     title: 'Prepare for School',        tagline: 'Homework, timetables, and sign-ups handled.', icon: 'graduation' },
  { id: 'manage_money',       title: 'Manage Money',              tagline: 'Bills, budgets, and the family wallet.',   icon: 'wallet' },
  { id: 'stay_healthy',       title: 'Keep Everyone Healthy',     tagline: 'Appointments, meds, and records.',         icon: 'heart-pulse' },
  { id: 'celebrate',          title: 'Celebrate Together',        tagline: 'Birthdays, gifts, and memories.',          icon: 'cake' },
  { id: 'prepare_unexpected', title: 'Prepare for the Unexpected', tagline: 'Emergencies, documents, and readiness.',  icon: 'shield' },
];

export const OUTCOMES_BY_ID: Record<OutcomeId, Outcome> = Object.fromEntries(
  OUTCOMES.map((o) => [o.id, o]),
) as Record<OutcomeId, Outcome>;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Assemble the capability plan for one outcome. Core steps always appear (so the
 * outcome is a complete "how to"); the context adds live badges that make the
 * urgent ones jump out — the "AI picks the capabilities automatically" surface.
 */
export function buildOutcomePlan(id: OutcomeId, ctx: OutcomeContext = EMPTY_CONTEXT): OutcomeStep[] {
  switch (id) {
    case 'run_today':
      return [
        { label: "Today's schedule", detail: 'See everything happening today.', href: '/dashboard/calendar',
          badge: ctx.eventsToday > 0 ? plural(ctx.eventsToday, 'event') : undefined },
        { label: 'What needs you', detail: 'Your ranked next best actions.', href: '/dashboard/next-best-actions',
          badge: ctx.overdueTasks > 0 ? `${ctx.overdueTasks} overdue` : undefined },
        { label: 'Get ready', detail: 'Leave-by times and prep for upcoming moments.', href: '/dashboard/moments' },
        { label: 'Tasks & chores', detail: "Knock out what's due.", href: '/dashboard/todos' },
      ];
    case 'feed_family':
      return [
        { label: 'Plan meals', detail: "Decide what's for dinner this week.", href: '/dashboard/meals' },
        { label: 'Shopping list', detail: 'Everything to buy, in one list.', href: '/dashboard/grocery',
          badge: ctx.openGrocery > 0 ? plural(ctx.openGrocery, 'item') : undefined },
        { label: 'Check the pantry', detail: "See what you already have.", href: '/dashboard/pantry' },
        { label: 'Find a recipe', detail: 'Ideas the family will actually eat.', href: '/dashboard/recipes' },
      ];
    case 'plan_trip':
      return [
        { label: 'Plan the trip', detail: 'Dates, destination, and itinerary.', href: '/dashboard/trips' },
        { label: 'Trip intelligence', detail: 'Weather, docs, and what to know.', href: '/dashboard/trip-intel' },
        { label: 'Vacation planner', detail: 'Bigger getaways, step by step.', href: '/dashboard/vacations' },
        { label: 'Block the calendar', detail: 'Reserve the days so nothing clashes.', href: '/dashboard/calendar' },
      ];
    case 'prepare_school':
      return [
        { label: 'School hub', detail: 'Everything school in one place.', href: '/dashboard/school' },
        { label: 'Timetable', detail: 'Who has what, and when.', href: '/dashboard/timetable' },
        { label: 'Homework', detail: "Track what's due.", href: '/dashboard/homework' },
        { label: 'Sign-ups', detail: 'Permission slips and activities.', href: '/dashboard/signups' },
      ];
    case 'manage_money':
      return [
        { label: 'Finances', detail: 'The whole-family money picture.', href: '/dashboard/billing' },
        { label: 'Bills', detail: "Stay ahead of what's due.", href: '/dashboard/bills' },
        { label: 'Family wallet', detail: 'Cards, allowances, and balances.', href: '/wallet' },
        { label: 'Subscriptions', detail: 'Trim what you no longer use.', href: '/dashboard/subscriptions' },
      ];
    case 'stay_healthy':
      return [
        { label: 'Health hub', detail: 'Everyone’s health at a glance.', href: '/dashboard/health' },
        { label: 'Medications', detail: 'Doses and refills on time.', href: '/dashboard/medications' },
        { label: 'Appointments', detail: 'Book and remember visits.', href: '/dashboard/calendar' },
        { label: 'Medical records', detail: 'History and documents, handy.', href: '/dashboard/medical' },
      ];
    case 'celebrate':
      return [
        { label: 'Celebrations', detail: 'Plan the party or the day.', href: '/dashboard/celebrations',
          badge: ctx.birthdaysSoon > 0 ? `${ctx.birthdaysSoon} coming up` : undefined },
        { label: 'Wish lists', detail: 'Gift ideas everyone can see.', href: '/dashboard/wishlists' },
        { label: 'Memories', detail: 'Capture and relive the moment.', href: '/dashboard/memories' },
        { label: 'Family tree', detail: 'Who we’re celebrating.', href: '/dashboard/family-tree' },
      ];
    case 'prepare_unexpected':
      return [
        { label: 'Emergency hub', detail: 'Contacts and plans for a crisis.', href: '/dashboard/family-emergency' },
        { label: 'Readiness', detail: "How prepared the household is.", href: '/dashboard/readiness' },
        { label: 'Household binder', detail: 'Critical info in one vault.', href: '/dashboard/binder' },
        { label: 'Insurance', detail: 'Policies and coverage, organized.', href: '/dashboard/insurance' },
      ];
  }
}

/** Total live-urgency badges across an outcome — for a summary count on the card. */
export function outcomeUrgencyCount(id: OutcomeId, ctx: OutcomeContext): number {
  return buildOutcomePlan(id, ctx).filter((s) => s.badge).length;
}
