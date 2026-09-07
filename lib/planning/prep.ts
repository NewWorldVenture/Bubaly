// Autonomous prep-plan generator (pure, unit-tested, DB-free).
//
// The vision's "prepare, don't notify": instead of a reminder when something is
// already due, look at what's coming on the horizon and produce ONE coordinated
// preparation plan with ordered, timed steps. A trip in 3 weeks isn't a single
// alert — it's passport checks, packing, and pet care, each with its own lead
// time. The server feeds real upcoming signals (trips, birthdays, expiring docs,
// school start); this turns them into plans. Deterministic => testable.

export type SignalKind = 'trip' | 'birthday' | 'doc_expiry' | 'school_start' | 'event';

/** Something on the horizon with a date it happens. */
export type HorizonSignal = {
  id: string;
  kind: SignalKind;
  title: string;
  date: string; // ISO date (YYYY-MM-DD) the thing happens
};

export type PrepStep = {
  label: string;
  href: string;
  leadDays: number;   // start this many days before the date
  dueDate: string;    // date - leadDays (ISO)
  overdue: boolean;   // dueDate already passed
};

export type Urgency = 'now' | 'soon' | 'later';

export type PrepPlan = {
  signalId: string;
  kind: SignalKind;
  title: string;      // "Get ready: Beach Trip"
  targetDate: string;
  daysUntil: number;
  urgency: Urgency;
  steps: PrepStep[];  // ordered soonest-due first
};

type StepTemplate = { label: string; href: string; leadDays: number };

// Per-kind prep recipes. leadDays = how far ahead each step should start.
const TEMPLATES: Record<SignalKind, StepTemplate[]> = {
  trip: [
    { label: 'Check passports/IDs are valid', href: '/dashboard/documents', leadDays: 30 },
    { label: 'Arrange pet & plant care', href: '/dashboard/pets', leadDays: 14 },
    { label: 'Build the packing list', href: '/dashboard/trips', leadDays: 7 },
    { label: 'Confirm bookings & travel times', href: '/dashboard/trips', leadDays: 3 },
    { label: 'Pack the night before', href: '/dashboard/trips', leadDays: 1 },
  ],
  birthday: [
    { label: 'Decide the plan & guest list', href: '/dashboard/celebrations', leadDays: 21 },
    { label: 'Send invites', href: '/dashboard/celebrations', leadDays: 14 },
    { label: 'Order gift & cake', href: '/dashboard/celebrations', leadDays: 7 },
    { label: 'Wrap and prep the day', href: '/dashboard/celebrations', leadDays: 1 },
  ],
  doc_expiry: [
    { label: 'Gather renewal paperwork', href: '/dashboard/documents', leadDays: 30 },
    { label: 'Submit the renewal', href: '/dashboard/documents', leadDays: 14 },
  ],
  school_start: [
    { label: 'Complete registration & forms', href: '/dashboard/school', leadDays: 21 },
    { label: 'Buy supplies & clothes', href: '/dashboard/grocery', leadDays: 14 },
    { label: 'Book physicals/checkups', href: '/dashboard/health', leadDays: 10 },
    { label: 'Re-set the school-day routine', href: '/dashboard/calendar', leadDays: 5 },
  ],
  event: [
    { label: 'Confirm attendance & logistics', href: '/dashboard/calendar', leadDays: 7 },
    { label: 'Prepare what you need to bring', href: '/dashboard/calendar', leadDays: 2 },
  ],
};

const TITLE_PREFIX: Record<SignalKind, string> = {
  trip: 'Get ready', birthday: 'Plan', doc_expiry: 'Renew', school_start: 'Prep for', event: 'Prepare for',
};

const DAY = 86_400_000;

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function daysBetween(from: Date, to: Date): number {
  // whole days, using UTC midnight of each date to avoid DST/tz drift
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / DAY);
}

/**
 * Turn horizon signals into coordinated prep plans. Past-dated signals are
 * dropped. Each plan's steps are ordered soonest-due first; a step is `overdue`
 * when its lead-time window has already opened. Plans are sorted by target date.
 */
export function generatePrepPlans(signals: HorizonSignal[], now: Date = new Date()): PrepPlan[] {
  const today = new Date(isoDate(now) + 'T00:00:00Z');
  const plans: PrepPlan[] = [];

  for (const s of signals) {
    const target = new Date(s.date + 'T00:00:00Z');
    if (Number.isNaN(target.getTime())) continue;
    const daysUntil = daysBetween(today, target);
    if (daysUntil < 0) continue; // already happened

    const steps: PrepStep[] = (TEMPLATES[s.kind] ?? []).map((t) => {
      const due = new Date(target.getTime() - t.leadDays * DAY);
      return { label: t.label, href: t.href, leadDays: t.leadDays, dueDate: isoDate(due), overdue: due < today };
    }).sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    plans.push({
      signalId: s.id,
      kind: s.kind,
      title: `${TITLE_PREFIX[s.kind]}: ${s.title}`,
      targetDate: s.date,
      daysUntil,
      urgency: urgencyFor(daysUntil, steps),
      steps,
    });
  }

  return plans.sort((a, b) => a.targetDate.localeCompare(b.targetDate));
}

/** now = a step window is already open; soon = something opens within a week. */
function urgencyFor(daysUntil: number, steps: PrepStep[]): Urgency {
  if (steps.some((s) => s.overdue)) return 'now';
  if (daysUntil <= 7) return 'now';
  const daysUntilFirstStep = daysUntil - Math.max(...steps.map((s) => s.leadDays));
  if (daysUntilFirstStep <= 0) return 'now';
  if (daysUntilFirstStep <= 7) return 'soon';
  return 'later';
}

/** How many plans have at least one open/overdue step — the count worth surfacing. */
export function actionablePlans(plans: PrepPlan[]): number {
  return plans.filter((p) => p.urgency === 'now').length;
}
