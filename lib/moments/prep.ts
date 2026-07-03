// lib/moments/prep.ts — the "life moment" orchestration engine.
//
// Anticipatory FamilyOS treats a single upcoming calendar event not as a row on
// a grid but as a MOMENT that touches many modules at once. Given one event this
// pure engine returns a coordinated, deterministic prep bundle — leave-by time,
// packing, snacks/shopping, weather awareness, budget heads-up, photo reminder —
// each as a one-tap PrepItem that deep-links into the module that already owns it.
// No I/O, no React: the ranking/derivation brain only, so it's fully unit-tested.
//
// The goal is to remove decisions: instead of the parent opening Calendar, then
// Weather, then Grocery, then Reminders before a Saturday tournament, the moment
// card assembles the whole checklist and each item is a single tap.

export type MomentCategory =
  | 'sports' | 'trip' | 'appointment' | 'school' | 'outdoors' | 'celebration' | 'general';

export type PrepDomain =
  | 'time' | 'packing' | 'shopping' | 'weather' | 'budget' | 'photo' | 'health' | 'calendar';

/** A single coordinated prep step. `actionHref` deep-links into the owning module;
 *  `reminderTitle` (when set) means the step can be turned into a real reminder in one tap. */
export type PrepItem = {
  id: string;
  domain: PrepDomain;
  label: string;
  hint?: string;
  actionHref?: string;
  reminderTitle?: string;
};

export type MomentEvent = {
  id: string;
  title: string;
  category: string | null;
  location: string | null;
  starts_at: string;
  all_day: boolean;
  description?: string | null;
};

export type MomentPrep = {
  eventId: string;
  category: MomentCategory;
  startsAt: string;
  /** ISO time the family should leave to arrive on time (timed events with a place). */
  leaveByISO: string | null;
  travelBufferMins: number;
  weatherSensitive: boolean;
  items: PrepItem[];
};

const KEYWORDS: { re: RegExp; cat: MomentCategory }[] = [
  { re: /\b(game|match|tournament|practice|soccer|football|basketball|baseball|hockey|swim|meet|race|track|gym|scrimmage)\b/i, cat: 'sports' },
  { re: /\b(party|birthday|bday|celebration|anniversary|shower|graduation)\b/i, cat: 'celebration' },
  { re: /\b(trip|vacation|flight|airport|hotel|road trip|camping|getaway|drive to|visit)\b/i, cat: 'trip' },
  { re: /\b(doctor|dentist|appointment|checkup|clinic|therapy|vet|dmv|specialist|surgery|vaccine|shot)\b/i, cat: 'appointment' },
  { re: /\b(school|class|field trip|exam|test|recital|concert|conference|picture day|assembly|pta)\b/i, cat: 'school' },
  { re: /\b(park|hike|beach|zoo|picnic|playground|outdoor|festival|fair|farmers)\b/i, cat: 'outdoors' },
];

const CATEGORY_MAP: Record<string, MomentCategory> = {
  sports: 'sports', school: 'school', appointment: 'appointment',
  medication: 'appointment', birthday: 'celebration', holiday: 'celebration',
};

/** Classify an event into a life-moment category from its DB category + title/desc keywords. */
export function classifyMoment(event: MomentEvent): MomentCategory {
  const text = `${event.title} ${event.description ?? ''}`;
  for (const { re, cat } of KEYWORDS) if (re.test(text)) return cat;
  const mapped = event.category ? CATEGORY_MAP[event.category] : undefined;
  return mapped ?? 'general';
}

/** Default door-to-door buffer (minutes) by moment type — bigger for trips/sports. */
function travelBuffer(category: MomentCategory, hasLocation: boolean): number {
  if (!hasLocation) return 0;
  switch (category) {
    case 'trip': return 45;
    case 'sports': return 35;
    case 'outdoors': return 30;
    case 'celebration': return 25;
    default: return 20;
  }
}

const OUTDOOR = new Set<MomentCategory>(['sports', 'outdoors', 'trip', 'celebration']);

/**
 * Assemble the coordinated prep bundle for one event. Deterministic given `now`.
 * Only emits steps that make sense for the moment (no packing list for a phone
 * call), so the card stays short and every item is worth a tap.
 */
export function buildMomentPrep(event: MomentEvent, opts: { now?: Date } = {}): MomentPrep {
  const category = classifyMoment(event);
  const hasLocation = Boolean(event.location && event.location.trim());
  const buffer = event.all_day ? 0 : travelBuffer(category, hasLocation);
  const start = new Date(event.starts_at);
  const leaveByISO = !event.all_day && buffer > 0 && !Number.isNaN(start.getTime())
    ? new Date(start.getTime() - buffer * 60000).toISOString()
    : null;
  const weatherSensitive = OUTDOOR.has(category);

  const items: PrepItem[] = [];
  const push = (i: PrepItem) => items.push(i);

  // 1) Time — the single most valuable anticipation: when to leave.
  if (leaveByISO) {
    push({
      id: 'leave-by', domain: 'time',
      label: `Leave by ${fmtClock(leaveByISO)}`,
      hint: `${buffer} min to ${event.location}`,
      reminderTitle: `Leave for ${event.title}`,
    });
  }

  // 2) Weather — one tap to the forecast for outdoor moments.
  if (weatherSensitive) {
    push({ id: 'weather', domain: 'weather', label: 'Check the forecast', hint: 'Dress for the weather', actionHref: '/dashboard/weather' });
  }

  // 3) Packing / bring — category specific, concrete.
  const bring = bringList(category);
  if (bring) push({ id: 'pack', domain: 'packing', label: bring, hint: 'Pack the night before', reminderTitle: `Pack for ${event.title}` });

  // 4) Shopping — snacks/gift/supplies straight into the grocery list.
  const shop = shopHint(category);
  if (shop) push({ id: 'shop', domain: 'shopping', label: shop.label, hint: shop.hint, actionHref: '/dashboard/grocery' });

  // 5) Budget — a gentle heads-up for spendy moments.
  if (category === 'trip' || category === 'celebration') {
    push({ id: 'budget', domain: 'budget', label: 'Set a quick budget', hint: 'Avoid surprises', actionHref: '/dashboard/budgets' });
  }

  // 6) Health — bring records/insurance to appointments.
  if (category === 'appointment') {
    push({ id: 'records', domain: 'health', label: 'Bring insurance & records', hint: 'From your Health vault', actionHref: '/dashboard/medical' });
  }

  // 7) Photo — capture the memory for milestone moments.
  if (category === 'celebration' || category === 'sports' || category === 'school') {
    push({ id: 'photo', domain: 'photo', label: 'Capture a few photos', hint: 'Save it to Memories', reminderTitle: `Photos at ${event.title}` });
  }

  return { eventId: event.id, category, startsAt: event.starts_at, leaveByISO, travelBufferMins: buffer, weatherSensitive, items };
}

function bringList(category: MomentCategory): string | null {
  switch (category) {
    case 'sports': return 'Pack kit, water & cleats';
    case 'trip': return 'Start a packing list';
    case 'outdoors': return 'Sunscreen, water & snacks';
    case 'school': return 'Backpack, forms & lunch';
    case 'celebration': return 'Wrap the gift & card';
    default: return null;
  }
}

function shopHint(category: MomentCategory): { label: string; hint: string } | null {
  switch (category) {
    case 'sports': return { label: 'Add team snacks to Grocery', hint: 'For the sideline' };
    case 'outdoors': return { label: 'Add picnic items to Grocery', hint: 'Food & drinks' };
    case 'celebration': return { label: 'Add party supplies to Grocery', hint: 'Cake, candles, plates' };
    case 'trip': return { label: 'Add road-trip snacks to Grocery', hint: 'For the drive' };
    default: return null;
  }
}

function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** Human "when" label for a moment, e.g. "in 2 hours", "Tomorrow", "Sat 9:00 AM". */
export function momentWhen(startsAt: string, allDay: boolean, now: Date = new Date()): string {
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((d.getTime() - now.getTime()) / 60000);
  if (!allDay && mins >= 0 && mins < 60) return mins <= 1 ? 'starting now' : `in ${mins} min`;
  if (!allDay && mins >= 60 && mins < 300) return `in ${Math.round(mins / 60)} hours`;
  const startDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayDiff = Math.round((startDay.getTime() - today.getTime()) / 86400000);
  const time = allDay ? '' : ` ${fmtClock(startsAt)}`;
  if (dayDiff === 0) return `Today${time}`;
  if (dayDiff === 1) return `Tomorrow${time}`;
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}${time}`;
}
