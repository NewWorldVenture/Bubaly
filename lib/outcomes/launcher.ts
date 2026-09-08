// Outcomes launcher (North Star pillar #4 — "Outcomes, not features"). Families
// think in goals ("feed the family", "plan a trip"), not in app modules. This
// pure engine maps each outcome to the underlying capabilities and, given a
// small snapshot of the family's real state, auto-selects + badges the steps
// that matter right now. DOM-free and fully unit-tested; the page feeds it real
// Supabase data and renders the plan.
//
// M25: an outcome is also a REQUEST. Every outcome names the workflow template
// that runs it (`OUTCOME_INTENT`) and the sentence that reaches the classifier
// (`buildOutcomeLaunchRequest`), so the "Have Bubaly do it" button files an
// `ai_requests` row that lands on the same run timeline and the same Home
// "Working on" strip as anything typed into the bar. The launch text is written
// to match a deterministic fast path in `lib/ai/context/intents.ts`, which is
// what `tests/outcomes-launch-request.test.ts` pins: an outcome must never fall
// through to the classifier model and be planned as something else.
import type { IntentKey } from '@/lib/ai/context/intents';
import { runPagePath, type AIRequestResponse } from '@/lib/ai/chat-request';

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

// ── "Do one thing now" (M30) ─────────────────────────────────────────────────
//
// A family that has just finished the wizard has seen a brief and a celebration
// screen and has done nothing. The activation metric measures the first OUTCOME
// viewed, and nothing on the path there pointed at one — so the last screen of
// onboarding said "start exploring", which is another way of saying "you work
// out what to do next".
//
// This picks ONE thing, from the same `buildOutcomePlan` the Outcomes page
// renders and from the same real snapshot, and hands back the step's own href.
// It promises nothing and claims nothing has happened: it is a door, chosen by
// what the family's own data says is closest to hand.

/** Why a first thing was chosen — each reason has its own copy. */
export type FirstThingReason = 'overdue' | 'events' | 'grocery' | 'birthday' | 'default';

export type FirstThing = {
  outcomeId: OutcomeId;
  reason: FirstThingReason;
  /** English source copy; the UI renders `labelKey`/`detailKey` through t(). */
  label: string;
  labelKey: string;
  detail: string;
  detailKey: string;
  /** The step of that outcome's plan this sends the family into. */
  href: string;
};

const FIRST_THING_COPY: Record<FirstThingReason, { label: string; labelKey: string; detail: string; detailKey: string }> = {
  overdue: {
    label: 'Clear what is overdue',
    labelKey: 'doOneThing.overdueLabel',
    detail: 'Your ranked next actions — start with the first one.',
    detailKey: 'doOneThing.overdueDetail',
  },
  events: {
    label: 'See today, in order',
    labelKey: 'doOneThing.eventsLabel',
    detail: 'Everything happening today, and what to get ready.',
    detailKey: 'doOneThing.eventsDetail',
  },
  grocery: {
    label: 'Finish the shopping list',
    labelKey: 'doOneThing.groceryLabel',
    detail: 'Everything left to buy, in one list.',
    detailKey: 'doOneThing.groceryDetail',
  },
  birthday: {
    label: 'Get ready for the birthday',
    labelKey: 'doOneThing.birthdayLabel',
    detail: 'Plan the day while there is still time.',
    detailKey: 'doOneThing.birthdayDetail',
  },
  default: {
    label: 'Start with today',
    labelKey: 'doOneThing.defaultLabel',
    detail: 'Open your day and put the first thing in it.',
    detailKey: 'doOneThing.defaultDetail',
  },
};

/** reason → (outcome, index of the step in its plan). */
const FIRST_THING_TARGET: Record<FirstThingReason, { outcomeId: OutcomeId; step: number }> = {
  overdue: { outcomeId: 'run_today', step: 1 },   // "What needs you"
  events: { outcomeId: 'run_today', step: 0 },    // "Today's schedule"
  grocery: { outcomeId: 'feed_family', step: 1 }, // "Shopping list"
  birthday: { outcomeId: 'celebrate', step: 0 },  // "Celebrations"
  default: { outcomeId: 'run_today', step: 0 },
};

/**
 * The one thing to offer a family that has not reached its first outcome yet.
 *
 * Priority is by what is already true of their data, most pressing first: an
 * overdue task beats a full day, a full day beats a shopping list, and a family
 * with none of those is pointed at today rather than at a feature tour.
 */
export function pickFirstThing(ctx: OutcomeContext = EMPTY_CONTEXT): FirstThing {
  const reason: FirstThingReason =
    ctx.overdueTasks > 0 ? 'overdue'
    : ctx.eventsToday > 0 ? 'events'
    : ctx.openGrocery > 0 ? 'grocery'
    : ctx.birthdaysSoon > 0 ? 'birthday'
    : 'default';
  const target = FIRST_THING_TARGET[reason];
  const plan = buildOutcomePlan(target.outcomeId, ctx);
  const step = plan[target.step] ?? plan[0];
  return { outcomeId: target.outcomeId, reason, ...FIRST_THING_COPY[reason], href: step.href };
}

// ── Launching an outcome (M25) ──────────────────────────────────────────────

/**
 * The workflow template each outcome runs. Eight outcomes, eight intents — a
 * card the concierge cannot act on is a card that lies about what the button
 * does, so this map is total by construction and the test proves every value
 * has a registered template.
 */
export const OUTCOME_INTENT: Record<OutcomeId, IntentKey> = {
  run_today: 'daily_brief',
  feed_family: 'plan_meals',
  plan_trip: 'prepare_vacation',
  prepare_school: 'back_to_school',
  manage_money: 'spending_review',
  stay_healthy: 'what_am_i_forgetting',
  celebrate: 'holiday',
  prepare_unexpected: 'emergency_prep',
};

/**
 * The sentence the launch button files. Deliberately the phrasing a person
 * would use, not a machine token: it is stored verbatim in
 * `ai_requests.request_text` and read back on the run page, and it has to match
 * a fast-path rule so the request is classified without a model call.
 */
const OUTCOME_REQUEST_TEXT: Record<OutcomeId, string> = {
  run_today: 'Brief me on today and get the day moving.',
  feed_family: "Plan our week's meals and put what we need on the shopping list.",
  plan_trip: 'Prepare for our trip: documents, packing and the home checklist.',
  prepare_school: 'Get us ready for the new school year: supplies, forms and the routine.',
  manage_money: 'Spending review: where did our money go this month?',
  stay_healthy: 'What are we forgetting about appointments, medications and records?',
  celebrate: 'Plan the holidays: the day, the food, the gifts and who is coming.',
  prepare_unexpected: 'Prepare for an emergency: our kit, documents, contacts and plan.',
};

export type OutcomeLaunchRequest = {
  outcomeId: OutcomeId;
  /** The intent the request must classify as; the test asserts the fast path agrees. */
  intent: IntentKey;
  text: string;
  /** Page context sent with the request, so the run says where it came from. */
  context: { module: string };
};

/** Everything the "Have Bubaly do it" button POSTs to `/api/ai/requests`. */
export function buildOutcomeLaunchRequest(id: OutcomeId): OutcomeLaunchRequest {
  return {
    outcomeId: id,
    intent: OUTCOME_INTENT[id],
    text: OUTCOME_REQUEST_TEXT[id],
    context: { module: `outcomes:${id}` },
  };
}

/**
 * What the launcher may honestly say once the server has answered.
 *
 *   - `working`  — a plan on a real run: work IS in flight and `runHref` opens it;
 *   - `question` — the run is PARKED on a clarifying question and is waiting on
 *                  the family; nothing is happening until they answer;
 *   - `reply`    — the request was answered or a recommendation was filed
 *                  inline. `submitRequest` returns `runId: null` for both, so
 *                  there is no run row, nothing to follow, and no work under way.
 */
export type OutcomeLaunchReport =
  | { kind: 'working'; runHref: string }
  | { kind: 'question'; question: string; runHref: string | null }
  | { kind: 'reply'; reply: string };

/**
 * Turn a `POST /api/ai/requests` response into the one claim that is true of it.
 *
 * Pure, and separate from the component, because the honesty rule this enforces
 * is the kind that regresses silently: rendering "Bubaly is working on it" for
 * every 2xx tells a family that work is under way when the planner in fact
 * answered them inline (`outcome: 'answer'`) or is waiting on them
 * (`outcome: 'clarification'`). `tests/outcomes-launch-request.test.ts` feeds
 * real `submitRequest` results through this.
 */
export function describeOutcomeLaunch(
  result: Pick<AIRequestResponse, 'outcome' | 'runId' | 'redirect' | 'summary'>,
): OutcomeLaunchReport {
  const runHref = result.redirect ?? (result.runId ? runPagePath(result.runId) : null);
  if (result.outcome === 'plan' && runHref) return { kind: 'working', runHref };
  if (result.outcome === 'clarification') return { kind: 'question', question: result.summary ?? '', runHref };
  return { kind: 'reply', reply: result.summary ?? '' };
}
