// Child independence progression — the age-banded growth ladder (gap #19).
//
// Pure + deterministic. The LADDER is the product content: age-appropriate
// milestones across six life domains. Callers pass a child's age + achieved
// rows; this module says what to suggest next, what their level is, and what
// each new level unlocks — the "AI increases responsibilities as children
// mature" loop, grounded in real developmental-stage conventions.

export type IndependenceDomain = 'chores' | 'money' | 'safety' | 'self_care' | 'school' | 'social';
export type AgeBand = '4-6' | '7-9' | '10-12' | '13-15' | '16-18';
export type MilestoneStatus = 'suggested' | 'in_progress' | 'achieved' | 'skipped';

export interface LadderMilestone {
  domain: IndependenceDomain;
  ageBand: AgeBand;
  title: string;
  description: string;
  points: number;
}

export const DOMAIN_LABEL: Record<IndependenceDomain, string> = {
  chores: 'Chores & home',
  money: 'Money',
  safety: 'Safety',
  self_care: 'Self-care',
  school: 'School',
  social: 'Social',
};

export const DOMAIN_ICON: Record<IndependenceDomain, string> = {
  chores: '🧹', money: '💰', safety: '🛟', self_care: '🪥', school: '📚', social: '🤝',
};

export const AGE_BANDS: AgeBand[] = ['4-6', '7-9', '10-12', '13-15', '16-18'];

/** The product ladder: 3 milestones × 6 domains × 5 age bands = 90 milestones. */
export const LADDER: LadderMilestone[] = [
  // ---- 4-6 ----
  { domain: 'chores', ageBand: '4-6', title: 'Puts toys away', description: 'Tidies their own toys into bins after playing.', points: 5 },
  { domain: 'chores', ageBand: '4-6', title: 'Feeds a pet with help', description: 'Scoops and pours pet food with an adult watching.', points: 5 },
  { domain: 'chores', ageBand: '4-6', title: 'Sets the table', description: 'Puts out napkins, forks, and cups for dinner.', points: 5 },
  { domain: 'money', ageBand: '4-6', title: 'Knows coins by name', description: 'Can tell a penny from a nickel, dime, and quarter.', points: 5 },
  { domain: 'money', ageBand: '4-6', title: 'Saves in a jar', description: 'Puts allowance or gift money in a savings jar.', points: 5 },
  { domain: 'money', ageBand: '4-6', title: 'Waits to buy', description: 'Understands "not today — we can save for it".', points: 5 },
  { domain: 'safety', ageBand: '4-6', title: 'Knows their full name & parents', description: 'Can say their full name and a parent’s name if asked.', points: 5 },
  { domain: 'safety', ageBand: '4-6', title: 'Holds hands near roads', description: 'Stops at curbs and waits for an adult.', points: 5 },
  { domain: 'safety', ageBand: '4-6', title: 'Knows the emergency number', description: 'Can say when and how to call for help.', points: 5 },
  { domain: 'self_care', ageBand: '4-6', title: 'Brushes teeth', description: 'Brushes twice a day with a reminder.', points: 5 },
  { domain: 'self_care', ageBand: '4-6', title: 'Dresses themselves', description: 'Picks and puts on clothes for the day.', points: 5 },
  { domain: 'self_care', ageBand: '4-6', title: 'Washes hands unprompted', description: 'Before meals and after the bathroom, no reminder.', points: 5 },
  { domain: 'school', ageBand: '4-6', title: 'Packs their school bag', description: 'Puts folder, snack, and water bottle in the bag.', points: 5 },
  { domain: 'school', ageBand: '4-6', title: 'Follows a two-step instruction', description: 'e.g. "hang your coat, then wash hands".', points: 5 },
  { domain: 'school', ageBand: '4-6', title: 'Sits for story time', description: 'Focuses on a book or task for 10+ minutes.', points: 5 },
  { domain: 'social', ageBand: '4-6', title: 'Says please and thank you', description: 'Uses polite words without prompting.', points: 5 },
  { domain: 'social', ageBand: '4-6', title: 'Takes turns', description: 'Shares and waits their turn in games.', points: 5 },
  { domain: 'social', ageBand: '4-6', title: 'Greets people', description: 'Says hello and goodbye to family and friends.', points: 5 },
  // ---- 7-9 ----
  { domain: 'chores', ageBand: '7-9', title: 'Makes their bed daily', description: 'Every morning, without being asked.', points: 10 },
  { domain: 'chores', ageBand: '7-9', title: 'Helps with dishes', description: 'Loads or dries dishes after dinner.', points: 10 },
  { domain: 'chores', ageBand: '7-9', title: 'Takes out small trash', description: 'Empties room bins into the big one.', points: 10 },
  { domain: 'money', ageBand: '7-9', title: 'Earns allowance from chores', description: 'Connects work to earning.', points: 10 },
  { domain: 'money', ageBand: '7-9', title: 'Splits save/spend/share', description: 'Divides money into three jars with a plan.', points: 10 },
  { domain: 'money', ageBand: '7-9', title: 'Makes change for $1', description: 'Counts coins to a dollar reliably.', points: 10 },
  { domain: 'safety', ageBand: '7-9', title: 'Knows their address & a phone number', description: 'Can recite home address and a parent’s number.', points: 10 },
  { domain: 'safety', ageBand: '7-9', title: 'Crosses the street safely', description: 'Looks both ways; uses crosswalks on quiet streets.', points: 10 },
  { domain: 'safety', ageBand: '7-9', title: 'Stranger-safety basics', description: 'Knows the family code word and what to do.', points: 10 },
  { domain: 'self_care', ageBand: '7-9', title: 'Showers independently', description: 'Full routine including hair, with a schedule.', points: 10 },
  { domain: 'self_care', ageBand: '7-9', title: 'Makes a simple breakfast', description: 'Cereal, toast, or fruit — safely, no stove.', points: 10 },
  { domain: 'self_care', ageBand: '7-9', title: 'Manages a morning routine', description: 'Up, dressed, fed, packed with one reminder.', points: 10 },
  { domain: 'school', ageBand: '7-9', title: 'Does homework at a set time', description: 'Starts homework at the agreed time.', points: 10 },
  { domain: 'school', ageBand: '7-9', title: 'Remembers library/PE days', description: 'Brings the right things on the right days.', points: 10 },
  { domain: 'school', ageBand: '7-9', title: 'Tells the teacher when stuck', description: 'Asks for help instead of shutting down.', points: 10 },
  { domain: 'social', ageBand: '7-9', title: 'Orders their own food', description: 'Speaks to the server at a restaurant.', points: 10 },
  { domain: 'social', ageBand: '7-9', title: 'Handles losing a game', description: 'Good sport, win or lose.', points: 10 },
  { domain: 'social', ageBand: '7-9', title: 'Apologizes and repairs', description: 'Says sorry and makes it right after conflict.', points: 10 },
  // ---- 10-12 ----
  { domain: 'chores', ageBand: '10-12', title: 'Does own laundry with help', description: 'Sorts, loads, and folds with light supervision.', points: 15 },
  { domain: 'chores', ageBand: '10-12', title: 'Cooks a simple hot meal', description: 'Eggs or pasta with an adult nearby.', points: 15 },
  { domain: 'chores', ageBand: '10-12', title: 'Owns a weekly chore', description: 'One chore fully theirs, start to finish.', points: 15 },
  { domain: 'money', ageBand: '10-12', title: 'Sticks to a small budget', description: 'Plans and tracks spending for an outing.', points: 15 },
  { domain: 'money', ageBand: '10-12', title: 'Saves for a goal', description: 'Reaches a savings goal over several weeks.', points: 15 },
  { domain: 'money', ageBand: '10-12', title: 'Compares prices', description: 'Checks unit price / value before buying.', points: 15 },
  { domain: 'safety', ageBand: '10-12', title: 'Stays home alone briefly', description: '30–60 minutes with rules and a check-in.', points: 15 },
  { domain: 'safety', ageBand: '10-12', title: 'Rides bike to a friend’s', description: 'Known route, helmet, tells someone first.', points: 15 },
  { domain: 'safety', ageBand: '10-12', title: 'Basic first aid', description: 'Cleans a scrape, gets ice, knows when to call.', points: 15 },
  { domain: 'self_care', ageBand: '10-12', title: 'Manages own hygiene fully', description: 'Deodorant, hair, nails — no reminders.', points: 15 },
  { domain: 'self_care', ageBand: '10-12', title: 'Packs for a trip', description: 'From a list, packs their own bag.', points: 15 },
  { domain: 'self_care', ageBand: '10-12', title: 'Sets an alarm and gets up', description: 'Wakes themselves for school.', points: 15 },
  { domain: 'school', ageBand: '10-12', title: 'Tracks assignments', description: 'Uses a planner/app; nothing slips.', points: 15 },
  { domain: 'school', ageBand: '10-12', title: 'Emails a teacher', description: 'Writes a polite question to a teacher themselves.', points: 15 },
  { domain: 'school', ageBand: '10-12', title: 'Plans a multi-day project', description: 'Breaks a project into steps ahead of the deadline.', points: 15 },
  { domain: 'social', ageBand: '10-12', title: 'Arranges a hangout', description: 'Plans time with friends and clears it with parents.', points: 15 },
  { domain: 'social', ageBand: '10-12', title: 'Includes the left-out kid', description: 'Notices and includes others.', points: 15 },
  { domain: 'social', ageBand: '10-12', title: 'Handles group-chat drama', description: 'Steps back, doesn’t pile on, tells an adult when it’s serious.', points: 15 },
  // ---- 13-15 ----
  { domain: 'chores', ageBand: '13-15', title: 'Full laundry independence', description: 'Their laundry is entirely their job.', points: 20 },
  { domain: 'chores', ageBand: '13-15', title: 'Cooks dinner for the family', description: 'Plans and cooks one family dinner a month.', points: 20 },
  { domain: 'chores', ageBand: '13-15', title: 'Basic home maintenance', description: 'Changes bulbs, unclogs a drain, resets the router.', points: 20 },
  { domain: 'money', ageBand: '13-15', title: 'Manages a debit card', description: 'Uses a teen card within a monthly budget.', points: 20 },
  { domain: 'money', ageBand: '13-15', title: 'Earns outside money', description: 'Babysitting, mowing, or a first small job.', points: 20 },
  { domain: 'money', ageBand: '13-15', title: 'Understands saving vs. interest', description: 'Knows why money grows and what borrowing costs.', points: 20 },
  { domain: 'safety', ageBand: '13-15', title: 'Navigates public transit', description: 'Takes a known bus/train route solo.', points: 20 },
  { domain: 'safety', ageBand: '13-15', title: 'Home alone for an evening', description: 'Handles dinner, doors, and bedtime solo.', points: 20 },
  { domain: 'safety', ageBand: '13-15', title: 'Online-safety judgment', description: 'Spots scams and DMs that should be reported.', points: 20 },
  { domain: 'self_care', ageBand: '13-15', title: 'Books own appointments', description: 'Schedules a haircut or dentist visit (with a ride).', points: 20 },
  { domain: 'self_care', ageBand: '13-15', title: 'Manages own medication', description: 'Takes daily meds/vitamins reliably.', points: 20 },
  { domain: 'self_care', ageBand: '13-15', title: 'Balances sleep & screens', description: 'Keeps a school-night routine mostly unaided.', points: 20 },
  { domain: 'school', ageBand: '13-15', title: 'Owns grades & makeup work', description: 'Monitors the portal, arranges makeups themselves.', points: 20 },
  { domain: 'school', ageBand: '13-15', title: 'Self-advocates with teachers', description: 'Requests extra help or a regrade in person.', points: 20 },
  { domain: 'school', ageBand: '13-15', title: 'Studies without being told', description: 'Starts test prep on their own schedule.', points: 20 },
  { domain: 'social', ageBand: '13-15', title: 'Keeps commitments', description: 'Shows up for team/club obligations without chasing.', points: 20 },
  { domain: 'social', ageBand: '13-15', title: 'Resolves conflict directly', description: 'Talks it out with the person first.', points: 20 },
  { domain: 'social', ageBand: '13-15', title: 'Speaks to adults confidently', description: 'Handles a phone call or counter interaction alone.', points: 20 },
  // ---- 16-18 ----
  { domain: 'chores', ageBand: '16-18', title: 'Runs the house for a weekend', description: 'Meals, pets, laundry — the full stack, solo.', points: 25 },
  { domain: 'chores', ageBand: '16-18', title: 'Grocery shops from a budget', description: 'Plans meals, shops, and stays under budget.', points: 25 },
  { domain: 'chores', ageBand: '16-18', title: 'Car care basics', description: 'Gas, tire pressure, oil check, wiper fluid.', points: 25 },
  { domain: 'money', ageBand: '16-18', title: 'Has a checking account', description: 'Manages an account and reads statements.', points: 25 },
  { domain: 'money', ageBand: '16-18', title: 'Files simple taxes', description: 'Understands a W-2 and files (with review).', points: 25 },
  { domain: 'money', ageBand: '16-18', title: 'Budgets a real month', description: 'Income vs. expenses for a real month, written down.', points: 25 },
  { domain: 'safety', ageBand: '16-18', title: 'Drives (or transits) independently', description: 'Licensed and trusted for solo trips, or full transit fluency.', points: 25 },
  { domain: 'safety', ageBand: '16-18', title: 'Handles an emergency', description: 'Knows who to call and what to do first for common crises.', points: 25 },
  { domain: 'safety', ageBand: '16-18', title: 'Travels solo', description: 'Manages a day trip alone: tickets, transfers, check-ins.', points: 25 },
  { domain: 'self_care', ageBand: '16-18', title: 'Manages own healthcare', description: 'Books, attends, and follows up on appointments.', points: 25 },
  { domain: 'self_care', ageBand: '16-18', title: 'Cooks a week of meals', description: 'Feeds themselves for a week — real food.', points: 25 },
  { domain: 'self_care', ageBand: '16-18', title: 'Keeps commitments calendar', description: 'Runs their own calendar and shows up on time.', points: 25 },
  { domain: 'school', ageBand: '16-18', title: 'Owns applications & deadlines', description: 'College/job applications driven by them, not parents.', points: 25 },
  { domain: 'school', ageBand: '16-18', title: 'Negotiates workload', description: 'Balances courses, work, and activities realistically.', points: 25 },
  { domain: 'school', ageBand: '16-18', title: 'Finds help independently', description: 'Tutors, office hours, or online — finds it and uses it.', points: 25 },
  { domain: 'social', ageBand: '16-18', title: 'Maintains adult relationships', description: 'References, mentors, bosses — keeps them warm.', points: 25 },
  { domain: 'social', ageBand: '16-18', title: 'Hosts and plans events', description: 'Organizes a group outing end to end.', points: 25 },
  { domain: 'social', ageBand: '16-18', title: 'Sets boundaries kindly', description: 'Says no clearly and respectfully when needed.', points: 25 },
];

/** Age → the band whose milestones fit now (clamped to the ladder's range). */
export function bandForAge(ageYears: number): AgeBand {
  if (ageYears <= 6) return '4-6';
  if (ageYears <= 9) return '7-9';
  if (ageYears <= 12) return '10-12';
  if (ageYears <= 15) return '13-15';
  return '16-18';
}

export function ageFromBirthday(birthday: string | null, now = new Date()): number | null {
  if (!birthday) return null;
  const b = new Date(birthday + (birthday.length === 10 ? 'T00:00:00Z' : ''));
  if (isNaN(b.getTime())) return null;
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return Math.max(0, age);
}

/**
 * What to put in front of this child now: current-band milestones they don't
 * have yet, plus any earlier-band ones still missing (foundations first).
 */
export function suggestMilestones(ageYears: number, existingTitles: Set<string>): LadderMilestone[] {
  const band = bandForAge(ageYears);
  const bandIdx = AGE_BANDS.indexOf(band);
  const eligible = LADDER.filter(m => AGE_BANDS.indexOf(m.ageBand) <= bandIdx && !existingTitles.has(m.title));
  // Foundations (earlier bands) first, then current band, stable by domain.
  return eligible.sort((a, b) =>
    AGE_BANDS.indexOf(a.ageBand) - AGE_BANDS.indexOf(b.ageBand) || a.domain.localeCompare(b.domain));
}

export interface IndependenceLevel {
  level: number;              // 1..5
  label: string;
  achievedCount: number;
  eligibleCount: number;      // milestones at/below their band
  pct: number;                // 0-100 of eligible achieved
  nextUnlock: string;
}

const LEVEL_LABELS = ['Sprout', 'Helper', 'Doer', 'Navigator', 'Almost-adult'];
const LEVEL_UNLOCKS = [
  'A first solo responsibility of their choice',
  'Bigger chores with bigger rewards',
  'More freedom: solo time and their own budget',
  'Real-world independence: transit, appointments, earning',
  'Adult trust: they run things without a safety net',
];

/** Level from achieved share of the age-eligible ladder. */
export function independenceLevel(ageYears: number, achievedTitles: Set<string>): IndependenceLevel {
  const bandIdx = AGE_BANDS.indexOf(bandForAge(ageYears));
  const eligible = LADDER.filter(m => AGE_BANDS.indexOf(m.ageBand) <= bandIdx);
  const achieved = eligible.filter(m => achievedTitles.has(m.title));
  const pct = eligible.length ? Math.round((achieved.length / eligible.length) * 100) : 0;
  const level = Math.min(5, Math.max(1, Math.floor(pct / 20) + 1));
  return {
    level,
    label: LEVEL_LABELS[level - 1],
    achievedCount: achieved.length,
    eligibleCount: eligible.length,
    pct,
    nextUnlock: LEVEL_UNLOCKS[Math.min(level, 4)],
  };
}
