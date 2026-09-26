// lib/moments/prep.ts — the "life moment" orchestration engine.
//
// Anticipatory Bubaly treats a single upcoming calendar event not as a row on
// a grid but as a MOMENT that touches many modules at once. Given one event this
// pure engine returns a coordinated, deterministic prep bundle — leave-by time,
// packing, snacks/shopping, weather awareness, budget heads-up, photo reminder —
// each as a one-tap PrepItem that deep-links into the module that already owns it.
// No I/O, no React: the ranking/derivation brain only, so it's fully unit-tested.
//
// The goal is to remove decisions: instead of the parent opening Calendar, then
// Weather, then Grocery, then Reminders before a Saturday tournament, the moment
// card assembles the whole checklist and each item is a single tap.

import { createFormat } from '@/lib/utils/format';
import { dayKeyInZone } from '@/lib/schedule/zoned';
import { DEFAULT_LOCALE, type LocaleCode } from '@/lib/i18n/locales';

type Translate = (key: string, params?: Record<string, string | number>) => string;

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
  /** When set, the step can add these concrete items to the family grocery list in one tap. */
  groceryItems?: string[];
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
  /** Where the leave-by came from: a real drive time, or the per-category door-to-door buffer. */
  leaveBySource: 'drive_time' | 'category_buffer' | null;
  weatherSensitive: boolean;
  items: PrepItem[];
};

/**
 * A composed departure for the event (lib/schedule/intelligence.ts), when the
 * caller has one: a real drive time beats the static category buffer. Only
 * honoured for timed events with a place, which is the only case a leave-by
 * makes sense for.
 */
export type MomentDeparture = {
  leaveByISO: string;
  /** Whole minutes door to door, for the hint. */
  travelMinutes: number;
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
export function buildMomentPrep(
  event: MomentEvent,
  // `timeZone` belongs on the options object rather than as another positional:
  // the item LABELS carry clock times, and binding only the caller's own clock
  // leaves them behind. That is not hypothetical — it shipped for one run of this
  // fix, and the push read "Leave by 8:25 AM — Leave by 3:25 PM": the same
  // instant, zoned in the headline and Greenwich in the step beside it, one
  // notification contradicting itself.
  opts: { now?: Date; departure?: MomentDeparture | null; timeZone?: string } = {},
): MomentPrep {
  const category = classifyMoment(event);
  const hasLocation = Boolean(event.location && event.location.trim());
  const start = new Date(event.starts_at);
  const validStart = !Number.isNaN(start.getTime());
  // A composed departure (real drive time) replaces the static buffer when the
  // event can have a leave-by at all; otherwise the category buffer stands.
  const composed = !event.all_day && hasLocation && validStart && opts.departure
    && Number.isFinite(Date.parse(opts.departure.leaveByISO)) ? opts.departure : null;
  const buffer = composed
    ? Math.max(0, Math.round(composed.travelMinutes))
    : event.all_day ? 0 : travelBuffer(category, hasLocation);
  const leaveByISO = composed
    ? new Date(Date.parse(composed.leaveByISO)).toISOString()
    : !event.all_day && buffer > 0 && validStart
      ? new Date(start.getTime() - buffer * 60000).toISOString()
      : null;
  const leaveBySource: MomentPrep['leaveBySource'] = leaveByISO ? (composed ? 'drive_time' : 'category_buffer') : null;
  const weatherSensitive = OUTDOOR.has(category);

  const items: PrepItem[] = [];
  const push = (i: PrepItem) => items.push(i);

  // 1) Time — the single most valuable anticipation: when to leave.
  if (leaveByISO) {
    push({
      id: 'leave-by', domain: 'time',
      label: `Leave by ${fmtClock(leaveByISO, undefined, opts.timeZone)}`,
      hint: composed ? `${buffer} min drive to ${event.location}` : `${buffer} min to ${event.location}`,
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

  // 4) Shopping — snacks/gift/supplies added straight to the grocery list in one tap.
  const shop = shopHint(category);
  if (shop) push({ id: 'shop', domain: 'shopping', label: shop.label, hint: shop.hint, actionHref: '/dashboard/grocery', groceryItems: shop.items });

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

  return { eventId: event.id, category, startsAt: event.starts_at, leaveByISO, travelBufferMins: buffer, leaveBySource, weatherSensitive, items };
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

function shopHint(category: MomentCategory): { label: string; hint: string; items: string[] } | null {
  switch (category) {
    case 'sports': return { label: 'Add team snacks to Grocery', hint: 'For the sideline', items: ['Water bottles', 'Orange slices', 'Granola bars'] };
    case 'outdoors': return { label: 'Add picnic items to Grocery', hint: 'Food & drinks', items: ['Sandwiches', 'Chips', 'Fruit', 'Drinks'] };
    case 'celebration': return { label: 'Add party supplies to Grocery', hint: 'Cake, candles, plates', items: ['Cake', 'Candles', 'Paper plates', 'Napkins'] };
    case 'trip': return { label: 'Add road-trip snacks to Grocery', hint: 'For the drive', items: ['Water bottles', 'Trail mix', 'Chips', 'Fruit'] };
    default: return null;
  }
}

function fmtClock(iso: string, locale: LocaleCode = DEFAULT_LOCALE, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return createFormat(locale, undefined, timeZone).fmtTime(d);
}

/**
 * A calendar day as a whole number, in `tz`, so two of them subtract to a count
 * of DAYS.
 *
 * Day keys parsed at UTC midnight are exactly 86_400_000 apart whatever the zone
 * does in between, so this is DST-proof in a way `(a - b) / 86400000` on the
 * instants is not.
 */
function dayIndexInZone(ms: number, tz: string): number {
  const key = dayKeyInZone(ms, tz);
  return key ? Math.round(Date.parse(`${key}T00:00:00Z`) / 86_400_000) : Math.round(ms / 86_400_000);
}

/** Human "when" label for a moment, e.g. "in 2 hours", "Tomorrow", "Sat 9:00 AM". */
export function momentWhen(
  startsAt: string,
  allDay: boolean,
  now: Date = new Date(),
  locale: LocaleCode = DEFAULT_LOCALE,
  t?: Translate,
  timeZone?: string,
): string {
  // FORWARD-facing, so not fmtTimeAgo. The clock and the date take the locale; the
  // five words take a translator, with an English fallback for the caller that has
  // no reader — lib/moments/notify.ts is a cron, and that is I18N-001, not an
  // oversight here.
  //
  // `timeZone` is optional for the same reason it is optional on `createFormat`,
  // and NOT for the reason a default usually is: two of the three callers are
  // client components, where the runtime IS the reader and omitting it is the
  // correct answer. The third is that cron, whose output is a PUSH NOTIFICATION
  // — "Get ready: Soccer · Tomorrow", "Leave by 4:00 PM" — and which therefore
  // has to pass one. `lib/server/notifications.ts` resolves the family's zone at
  // its line 77 and simply did not hand it down.
  //
  // THREE things here are zone-sensitive and all three had to move, which is why
  // this is not a one-line change: the clock below, the Today/Tomorrow decision,
  // and the weekday label at the end.
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((d.getTime() - now.getTime()) / 60000);
  if (!allDay && mins >= 0 && mins < 60) {
    if (mins <= 1) return t ? t('moments.startingNow') : 'starting now';
    return t ? t('ambient.inNMin', { minutes: mins }) : `in ${mins} min`;
  }
  if (!allDay && mins >= 60 && mins < 300) {
    const hours = Math.round(mins / 60);
    return t ? t('moments.inNHours', { hours }) : `in ${hours} hours`;
  }
  // Whose day. With a zone bound, both sides are day KEYS in it and the gap is
  // counted in calendar days; with none, the original local-parts arithmetic is
  // kept exactly, which is right in a browser.
  const dayDiff = timeZone
    ? dayIndexInZone(d.getTime(), timeZone) - dayIndexInZone(now.getTime(), timeZone)
    : Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
      - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000);
  const time = allDay ? '' : ` ${fmtClock(startsAt, locale, timeZone)}`;
  if (dayDiff === 0) return `${t ? t('calendar.today') : 'Today'}${time}`;
  if (dayDiff === 1) return `${t ? t('quickCapture.tomorrow') : 'Tomorrow'}${time}`;
  return `${createFormat(locale, undefined, timeZone).fmtDate(d, 'EEE, MMM d')}${time}`;
}
