// lib/trips/departure.ts — Smart Departure engine. PURE + tested.
//
// Answers the product's "when do we need to head out?" question for any
// calendar event that has a location. Given the event time and the moving
// parts of getting there — time to get ready, real driving time, parking, plus
// live traffic and weather penalties — it computes a single, trustworthy
// leave-by moment and a status the UI can react to in real time.
//
// It is intentionally pure: the route/UI fetches live driving time (OSRM) and
// weather (Open-Meteo), this module turns those numbers into a plan. No clock
// access beyond the `now` you pass, so it is fully deterministic and testable.

export type DepartureStatus = 'plenty' | 'soon' | 'now' | 'overdue' | 'arrived';

export interface DepartureInput {
  /** ISO timestamp the event starts (when you need to BE there). */
  eventStartISO: string;
  /** Real driving time in seconds (e.g. from OSRM). */
  driveSeconds: number;
  /** Minutes to get ready before walking out the door. */
  prepMinutes: number;
  /** Minutes to park + walk in at the destination. */
  parkMinutes: number;
  /** Multiplier on drive time for live traffic (1 = free-flow). Clamped 1–3. */
  trafficFactor?: number;
  /** Extra minutes of weather penalty (rain/snow). */
  weatherDelayMinutes?: number;
  /** Safety cushion so you arrive a few minutes early. */
  bufferMinutes?: number;
  /** Current time. */
  now: string | Date;
}

export interface DeparturePlan {
  /** When to walk out the door. */
  leaveByISO: string;
  /** When to start getting ready (leaveBy − prep). */
  getReadyByISO: string;
  /** Whole minutes from `now` until you must leave (negative = already late). */
  minutesUntilLeave: number;
  /** Total door-to-seat travel minutes (drive×traffic + weather + park + buffer). */
  totalTravelMinutes: number;
  /** Adjusted driving minutes after the traffic multiplier. */
  driveMinutesAdjusted: number;
  status: DepartureStatus;
  breakdown: { label: string; minutes: number }[];
}

const MIN_TRAFFIC = 1;
const MAX_TRAFFIC = 3;

function clampTraffic(f: number | undefined): number {
  if (f == null || !Number.isFinite(f)) return 1;
  return Math.min(MAX_TRAFFIC, Math.max(MIN_TRAFFIC, f));
}

/**
 * Live-traffic multiplier for a departure time. Models typical metro rush-hour
 * congestion: weekday morning (7–9am) and evening (4–7pm) peaks slow you down,
 * late nights are free-flowing. Weekends are lighter. Hour is taken in the
 * given IANA timezone offset minutes (pass the destination's tz offset), else
 * local. Returns a multiplier in [1, ~1.5].
 */
export function trafficFactorForTime(when: string | Date, dayOfWeek?: number, hour?: number): number {
  const d = typeof when === 'string' ? new Date(when) : when;
  if (Number.isNaN(d.getTime())) return 1;
  const dow = dayOfWeek ?? d.getDay(); // 0=Sun..6=Sat
  const h = hour ?? d.getHours();
  const isWeekend = dow === 0 || dow === 6;

  // Peak windows (free-flow = 1.0).
  const morningPeak = h >= 7 && h < 9;
  const middayBump = h >= 11 && h < 14;
  const eveningPeak = h >= 16 && h < 19;

  if (isWeekend) {
    // Weekends: only a mild midday/afternoon bump.
    if (h >= 11 && h < 17) return 1.15;
    return 1.0;
  }
  if (morningPeak) return 1.45;
  if (eveningPeak) return 1.5;
  if (middayBump) return 1.2;
  if (h >= 22 || h < 6) return 1.0; // overnight
  return 1.1; // general daytime
}

/**
 * Extra travel minutes to budget for weather. Uses the WMO weather code and an
 * optional precipitation probability. Rain/snow/fog all slow driving; heavier
 * conditions add more. Returns whole minutes ≥ 0.
 */
export function weatherDelayMinutes(weatherCode: number | null | undefined, precipProb?: number | null): number {
  if (weatherCode == null) return 0;
  const code = weatherCode;
  let base = 0;
  if ([45, 48].includes(code)) base = 5;                       // fog
  else if ([51, 53, 55, 56, 57].includes(code)) base = 3;      // drizzle
  else if ([61, 63, 80, 81].includes(code)) base = 6;          // rain
  else if ([65, 82].includes(code)) base = 12;                 // heavy rain
  else if ([66, 67].includes(code)) base = 14;                 // freezing rain
  else if ([71, 73, 77, 85].includes(code)) base = 12;         // snow
  else if ([75, 86].includes(code)) base = 20;                 // heavy snow
  else if ([95, 96, 99].includes(code)) base = 15;             // thunderstorm

  // Scale slightly by precipitation probability when available.
  if (precipProb != null && precipProb > 70 && base > 0) base += 3;
  return base;
}

function status(minutesUntilLeave: number, totalTravelMinutes: number): DepartureStatus {
  // If the event has effectively passed (you'd arrive well after start).
  if (minutesUntilLeave <= -Math.max(15, totalTravelMinutes)) return 'arrived';
  if (minutesUntilLeave < 0) return 'overdue';
  if (minutesUntilLeave <= 5) return 'now';
  if (minutesUntilLeave <= 30) return 'soon';
  return 'plenty';
}

/**
 * Compute the full departure plan. Works backward from the event start:
 *   arrive_by = eventStart − buffer
 *   leave_by  = arrive_by − parkMinutes − driveMinutes(adjusted) − weatherDelay
 *   ready_by  = leave_by − prepMinutes
 */
export function computeDeparture(input: DepartureInput): DeparturePlan {
  const now = typeof input.now === 'string' ? new Date(input.now) : input.now;
  const eventStart = new Date(input.eventStartISO);

  const traffic = clampTraffic(input.trafficFactor);
  const weatherDelay = Math.max(0, Math.round(input.weatherDelayMinutes ?? 0));
  const buffer = Math.max(0, Math.round(input.bufferMinutes ?? 5));
  const prep = Math.max(0, Math.round(input.prepMinutes));
  const park = Math.max(0, Math.round(input.parkMinutes));

  const driveMinutesRaw = Math.max(0, input.driveSeconds) / 60;
  const driveMinutesAdjusted = Math.round(driveMinutesRaw * traffic);

  const totalTravelMinutes = driveMinutesAdjusted + park + weatherDelay + buffer;

  const arriveByMs = eventStart.getTime() - buffer * 60_000;
  const leaveByMs = arriveByMs - (park + weatherDelay) * 60_000 - driveMinutesAdjusted * 60_000;
  const readyByMs = leaveByMs - prep * 60_000;

  const minutesUntilLeave = Math.round((leaveByMs - now.getTime()) / 60_000);

  const breakdown = [
    { label: 'Get ready', minutes: prep },
    { label: 'Drive', minutes: driveMinutesAdjusted },
    { label: 'Park & walk in', minutes: park },
  ];
  if (weatherDelay > 0) breakdown.push({ label: 'Weather delay', minutes: weatherDelay });
  if (buffer > 0) breakdown.push({ label: 'Arrive-early buffer', minutes: buffer });

  return {
    leaveByISO: new Date(leaveByMs).toISOString(),
    getReadyByISO: new Date(readyByMs).toISOString(),
    minutesUntilLeave,
    totalTravelMinutes,
    driveMinutesAdjusted,
    status: status(minutesUntilLeave, totalTravelMinutes),
    breakdown,
  };
}

/** Friendly "leave in 25 min" / "leave now" / "12 min ago" label. */
export function leaveByLabel(minutesUntilLeave: number): string {
  if (minutesUntilLeave <= -1) return `${Math.abs(minutesUntilLeave)} min ago`;
  if (minutesUntilLeave <= 0) return 'Leave now';
  if (minutesUntilLeave < 60) return `Leave in ${minutesUntilLeave} min`;
  const h = Math.floor(minutesUntilLeave / 60);
  const m = minutesUntilLeave % 60;
  return m === 0 ? `Leave in ${h}h` : `Leave in ${h}h ${m}m`;
}

const STATUS_COPY: Record<DepartureStatus, { label: string; tone: 'ok' | 'warn' | 'urgent' | 'muted' }> = {
  plenty: { label: 'Plenty of time', tone: 'ok' },
  soon: { label: 'Heads up — leaving soon', tone: 'warn' },
  now: { label: 'Time to go', tone: 'urgent' },
  overdue: { label: 'Running late', tone: 'urgent' },
  arrived: { label: 'Event passed', tone: 'muted' },
};

export function departureStatusCopy(s: DepartureStatus): { label: string; tone: 'ok' | 'warn' | 'urgent' | 'muted' } {
  return STATUS_COPY[s];
}
