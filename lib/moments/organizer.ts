// lib/moments/organizer.ts — Moments as an ORGANIZING LAYER (R12). The strategy is
// "organize by moments, not modules": instead of hunting through 70 features, the
// family lands on the life moment they're in right now (Morning · School · Dinner ·
// Homework · Bedtime · Weekend) or one that's coming (Vacation · Birthday · Holiday),
// and each moment orchestrates the handful of capabilities it actually needs. This
// is the pure, deterministic core: given the clock + a few family signals it decides
// which moments are live and what each one pulls together. DOM-free + unit-tested.

export type MomentKey =
  | 'morning' | 'school' | 'dinner' | 'homework' | 'bedtime'
  | 'weekend' | 'vacation' | 'birthday' | 'holiday' | 'emergency';

export interface MomentCapability { label: string; href: string }

export interface MomentDef {
  key: MomentKey;
  label: string;
  blurb: string;
  capabilities: MomentCapability[];
}

export interface ActiveMoment extends MomentDef {
  reason: string;     // why it's live right now
  priority: number;   // higher surfaces first
}

/** The canonical life moments + the capabilities each orchestrates. */
export const MOMENT_DEFS: Record<MomentKey, MomentDef> = {
  morning: {
    key: 'morning', label: 'Morning', blurb: 'Get everyone out the door.',
    capabilities: [
      { label: 'Today’s schedule', href: '/dashboard/calendar' },
      { label: 'School run', href: '/dashboard/rides' },
      { label: 'Reminders', href: '/dashboard/reminders' },
    ],
  },
  school: {
    key: 'school', label: 'School', blurb: 'Classes, pickups and homework.',
    capabilities: [
      { label: 'Homework', href: '/dashboard/homework' },
      { label: 'School', href: '/dashboard/school' },
      { label: 'Pickups & rides', href: '/dashboard/rides' },
    ],
  },
  dinner: {
    key: 'dinner', label: 'Dinner', blurb: 'What’s for dinner — sorted.',
    capabilities: [
      { label: 'Meal plan', href: '/dashboard/meals' },
      { label: 'Grocery list', href: '/dashboard/grocery' },
      { label: 'Recipes', href: '/dashboard/recipes' },
    ],
  },
  homework: {
    key: 'homework', label: 'Homework', blurb: 'Due tomorrow — get ahead tonight.',
    capabilities: [
      { label: 'Assignments', href: '/dashboard/homework' },
      { label: 'Reminders', href: '/dashboard/reminders' },
    ],
  },
  bedtime: {
    key: 'bedtime', label: 'Bedtime', blurb: 'Wind down and prep tomorrow.',
    capabilities: [
      { label: 'Routines', href: '/dashboard/routines' },
      { label: 'Tomorrow’s plan', href: '/dashboard/calendar' },
      { label: 'Reminders', href: '/dashboard/reminders' },
    ],
  },
  weekend: {
    key: 'weekend', label: 'Weekend', blurb: 'Make the most of it.',
    capabilities: [
      { label: 'Weekend planner', href: '/dashboard/weekend' },
      { label: 'Activities', href: '/dashboard/outcomes' },
      { label: 'Memories', href: '/dashboard/memories' },
    ],
  },
  vacation: {
    key: 'vacation', label: 'Vacation', blurb: 'A trip is coming — get ready.',
    capabilities: [
      { label: 'Trip plans', href: '/dashboard/trips' },
      { label: 'Concierge', href: '/dashboard/concierge' },
      { label: 'Documents', href: '/dashboard/documents' },
    ],
  },
  birthday: {
    key: 'birthday', label: 'Birthday', blurb: 'A celebration is near.',
    capabilities: [
      { label: 'Celebrations', href: '/dashboard/celebrations' },
      { label: 'Wish lists', href: '/dashboard/wishlists' },
      { label: 'Gifts', href: '/dashboard/relationship' },
    ],
  },
  holiday: {
    key: 'holiday', label: 'Holiday', blurb: 'Plan the gathering.',
    capabilities: [
      { label: 'Celebrations', href: '/dashboard/celebrations' },
      { label: 'Meal plan', href: '/dashboard/meals' },
      { label: 'Calendar', href: '/dashboard/calendar' },
    ],
  },
  emergency: {
    key: 'emergency', label: 'Emergency', blurb: 'Everything you’d need, one tap away.',
    capabilities: [
      { label: 'Emergency info', href: '/dashboard/family-emergency' },
      { label: 'Key contacts', href: '/dashboard/contacts' },
      { label: 'Documents', href: '/dashboard/documents' },
    ],
  },
};

export interface MomentSignals {
  hour: number;                 // 0..23 (family-local)
  dow: number;                  // 0=Sun..6=Sat
  birthdayInDays?: number | null;
  birthdayName?: string | null;
  tripInDays?: number | null;
  tripLabel?: string | null;
  holidayInDays?: number | null;
  holidayLabel?: string | null;
  homeworkDueTomorrow?: number;
}

const NEAR_DAYS = 21;

/**
 * Which moments are live right now, ranked. Episodic moments that are close
 * (vacation/birthday/holiday) outrank the daily rhythm; Emergency is always
 * reachable at the bottom. Deterministic — the clock + signals fully decide it.
 */
export function activeMoments(sig: MomentSignals): ActiveMoment[] {
  const out: ActiveMoment[] = [];
  const add = (key: MomentKey, priority: number, reason: string) =>
    out.push({ ...MOMENT_DEFS[key], priority, reason });

  const weekday = sig.dow >= 1 && sig.dow <= 5;
  const weekend = sig.dow === 0 || sig.dow === 6;

  // Episodic, time-sensitive → highest when near (sooner = higher).
  if (typeof sig.tripInDays === 'number' && sig.tripInDays >= 0 && sig.tripInDays <= NEAR_DAYS) {
    add('vacation', 100 - sig.tripInDays, sig.tripLabel ? `“${sig.tripLabel}” in ${sig.tripInDays} day${sig.tripInDays === 1 ? '' : 's'}` : `A trip in ${sig.tripInDays} days`);
  }
  if (typeof sig.birthdayInDays === 'number' && sig.birthdayInDays >= 0 && sig.birthdayInDays <= NEAR_DAYS) {
    add('birthday', 98 - sig.birthdayInDays, sig.birthdayName ? `${sig.birthdayName}’s birthday in ${sig.birthdayInDays} day${sig.birthdayInDays === 1 ? '' : 's'}` : `A birthday in ${sig.birthdayInDays} days`);
  }
  if (typeof sig.holidayInDays === 'number' && sig.holidayInDays >= 0 && sig.holidayInDays <= NEAR_DAYS) {
    add('holiday', 96 - sig.holidayInDays, sig.holidayLabel ? `${sig.holidayLabel} in ${sig.holidayInDays} day${sig.holidayInDays === 1 ? '' : 's'}` : `A holiday in ${sig.holidayInDays} days`);
  }

  // Daily rhythm by time of day.
  if (weekday && sig.hour >= 5 && sig.hour < 9) add('morning', 80, 'Weekday morning');
  if (weekday && sig.hour >= 6 && sig.hour < 16) add('school', 70, 'School hours');
  if ((sig.homeworkDueTomorrow ?? 0) > 0 && sig.hour >= 15 && sig.hour < 21) {
    add('homework', 85, `${sig.homeworkDueTomorrow} due tomorrow`); // urgent → above rhythm
  }
  if (sig.hour >= 15 && sig.hour < 20) add('dinner', 75, 'Around dinnertime');
  if (sig.hour >= 19 && sig.hour < 23) add('bedtime', 60, 'Evening wind-down');
  if (weekend) add('weekend', 65, sig.dow === 6 ? 'It’s Saturday' : 'It’s Sunday');

  // Always reachable.
  add('emergency', 1, 'Always one tap away');

  // De-dup (a key added twice keeps the highest priority) + sort desc.
  const best = new Map<MomentKey, ActiveMoment>();
  for (const m of out) {
    const cur = best.get(m.key);
    if (!cur || m.priority > cur.priority) best.set(m.key, m);
  }
  return [...best.values()].sort((a, b) => b.priority - a.priority);
}
