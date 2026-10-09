// Subscription projection extracted from PR #970, exact source
// 246e7cdc65c162801b63017b02375749bde7846f. Bill payment keeps its own
// confirmed schedule and conditional write in bill-schedule.ts / bills.ts.

export type SubscriptionCadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
const CADENCES: Record<string, SubscriptionCadence> = {
  weekly: 'weekly', biweekly: 'biweekly', fortnightly: 'biweekly', monthly: 'monthly',
  quarterly: 'quarterly', yearly: 'yearly', annually: 'yearly',
};

/** Preserve subscription accounting's monthly fallback for an unknown cadence. */
export function subscriptionCadence(value: string | null | undefined): SubscriptionCadence {
  const name = value?.trim().toLowerCase() ?? '';
  return Object.hasOwn(CADENCES, name) ? CADENCES[name] : 'monthly';
}

function parseDayKey(key: string): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]) - 1, day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month && probe.getUTCDate() === day
    ? [year, month, day] : null;
}

function stepFrom([year, month, day]: [number, number, number], cadence: SubscriptionCadence, step: number): string {
  if (cadence === 'weekly' || cadence === 'biweekly') {
    return new Date(Date.UTC(year, month, day + step * (cadence === 'weekly' ? 7 : 14))).toISOString().slice(0, 10);
  }
  const months = step * (cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12);
  const last = new Date(Date.UTC(year, month + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month + months, Math.min(day, last))).toISOString().slice(0, 10);
}

/** Project the stored anchor without changing it; a charge due today still counts. */
export function nextOccurrenceOnOrAfter(anchor: string, cadence: SubscriptionCadence, today: string): string | null {
  const start = parseDayKey(anchor);
  if (!start) return null;
  const from = anchor.slice(0, 10), end = parseDayKey(today);
  const floor = end ? today.slice(0, 10) : from;
  if (from >= floor || !end) return from;
  const estimate = cadence === 'weekly' || cadence === 'biweekly'
    ? Math.floor(Math.round((Date.UTC(...end) - Date.UTC(...start)) / 86_400_000) / (cadence === 'weekly' ? 7 : 14))
    : Math.floor(((end[0] - start[0]) * 12 + end[1] - start[1]) / (cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12));
  // Jump near today's cycle, then compare; a decades-old anchor needs no walk.
  for (let step = Math.max(1, estimate); step <= Math.max(1, estimate) + 3; step++) {
    const next = stepFrom(start, cadence, step);
    if (next >= floor) return next;
  }
  return null;
}

/** next_charge is a hand-entered series anchor, rather than a date a writer rolls. */
export function projectedNextCharge(nextCharge: string | null | undefined, cadence: string | null | undefined, today: string): string | null {
  return nextCharge ? nextOccurrenceOnOrAfter(nextCharge.slice(0, 10), subscriptionCadence(cadence), today) : null;
}
