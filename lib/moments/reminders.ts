// lib/moments/reminders.ts — WHEN a moment reminder should fire.
//
// A reminder is only valuable if it arrives at the right time: "pack the bag"
// the night before, "buy snacks" a couple days out, "gift" earlier still, "take
// photos" at the event itself. Previously every non-leave-by step fired at a
// blanket ~20h/2h — so the nudges bunched up and lost meaning. This pure module
// picks a sensible lead time per prep domain and clamps everything to the future.
// No I/O; the view/actions just call reminderTimeFor(). Tested.

import type { PrepDomain } from '@/lib/moments/prep';

/** How far ahead of the event each kind of prep is worth nudging (minutes). */
const LEAD_MINUTES: Partial<Record<PrepDomain, number>> = {
  packing: 14 * 60,   // the night before
  shopping: 48 * 60,  // a couple days out, time to shop
  budget: 48 * 60,    // plan spend ahead
  health: 3 * 60,     // morning of / a few hours before
  photo: 0,           // at the event itself
  weather: 12 * 60,   // check + dress the night before
  calendar: 20 * 60,
};
const DEFAULT_LEAD_MINUTES = 20 * 60;

/** Minutes before the event to nudge for a given prep domain. */
export function reminderLeadMinutes(domain: PrepDomain): number {
  return LEAD_MINUTES[domain] ?? DEFAULT_LEAD_MINUTES;
}

/**
 * The ISO time a step's reminder should fire.
 * - The leave-by step fires exactly at the leave time.
 * - Everything else fires `reminderLeadMinutes(domain)` before the event start.
 * Always clamped to at least `now + 1 min`, so we never create a past reminder
 * (e.g. for a same-day moment whose ideal lead has already passed).
 */
export function reminderTimeFor(
  args: { domain: PrepDomain; stepId: string; eventStartsAtISO: string; leaveByISO?: string | null },
  now: Date = new Date(),
): string {
  const floor = now.getTime() + 60_000;
  if (args.stepId === 'leave-by' && args.leaveByISO) {
    const t = Date.parse(args.leaveByISO);
    return new Date(Number.isFinite(t) ? Math.max(t, floor) : floor).toISOString();
  }
  const start = Date.parse(args.eventStartsAtISO);
  if (!Number.isFinite(start)) return new Date(floor).toISOString();
  const target = start - reminderLeadMinutes(args.domain) * 60_000;
  return new Date(Math.max(target, floor)).toISOString();
}
