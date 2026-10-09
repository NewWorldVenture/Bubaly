import { validDay } from '../onboarding/ics-time';

const NS_PER_MS = 1_000_000n;
export type ExactInterval = { start: string; end: string };

/** Exact absolute clock, including PostgreSQL microseconds. No floating epoch
 * arithmetic, host-zone reads or modification of the original stored string. */
export function parseExactInstant(value: unknown): bigint {
  if (typeof value !== 'string') throw new Error('Missing calendar instant');
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match || !validDay(match[1]) || +match[2] > 23 || +match[3] > 59 || +match[4] > 59
    || match[7] !== undefined && (+match[7] > 23 || +match[8] > 59)) throw new Error('Invalid calendar instant');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error('Invalid calendar instant');
  const fraction = (match[5] ?? '').padEnd(9, '0');
  return BigInt(milliseconds) * NS_PER_MS + BigInt(fraction.slice(3));
}

/** Whole milliseconds are only a compatibility/Intl projection. */
export function exactInstantMilliseconds(instant: bigint): number {
  const floor = instant / NS_PER_MS - (instant < 0n && instant % NS_PER_MS !== 0n ? 1n : 0n);
  const result = Number(floor);
  if (!Number.isSafeInteger(result) || !Number.isFinite(new Date(result).getTime())) throw new Error('Invalid calendar instant');
  return result;
}

export function formatExactInstant(instant: bigint): string {
  const milliseconds = exactInstantMilliseconds(instant);
  const iso = new Date(milliseconds).toISOString();
  // The public native clock grammar has four-digit years.
  if (!/^\d{4}-/.test(iso)) throw new Error('Calendar instant outside supported years');
  const remainder = instant - BigInt(milliseconds) * NS_PER_MS;
  if (remainder === 0n) return iso;
  const fraction = (iso.slice(20, 23) + remainder.toString().padStart(6, '0')).replace(/0+$/, '');
  return iso.slice(0, 20) + fraction + 'Z';
}

export function compareExactInstants(a: string, b: string): number {
  const left = parseExactInstant(a), right = parseExactInstant(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function addExactMilliseconds(value: string, milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds)) throw new Error('Invalid calendar duration');
  return formatExactInstant(parseExactInstant(value) + BigInt(milliseconds) * NS_PER_MS);
}

/** Inclusive calendar bounds historically cover the final millisecond. Keep
 * that policy for legacy clocks; finer clocks cover only their declared unit.
 * Inspect the original token before canonical formatting trims trailing zeros. */
export function inclusiveInstantStep(value: string): bigint {
  parseExactInstant(value);
  const digits = /T\d{2}:\d{2}:\d{2}\.(\d+)/.exec(value)?.[1].length ?? 0;
  return 10n ** BigInt(9 - Math.max(3, digits));
}

/** UTC normalization that retains the caller's declared fractional unit. */
export function normalizeExactInstant(value: string): string {
  const normalized = formatExactInstant(parseExactInstant(value));
  const digits = /T\d{2}:\d{2}:\d{2}\.(\d+)/.exec(value)?.[1].length ?? 0;
  return normalized.slice(0, 20) + normalized.slice(20, -1).padEnd(Math.max(3, digits), '0') + 'Z';
}

/** Runtime readers supply exact endpoints. Legacy integer-ms fixtures retain a
 * compatibility path; an exact interval is never reconstructed from floats. */
export function exactIntervalOf(value: {
  exactInterval?: ExactInterval; interval: { start: number; end: number };
  actualStartsAt?: string; actualEndsAt?: string | null; starts_at?: string; ends_at?: string | null;
}): ExactInterval {
  if (value.exactInterval !== undefined) {
    const { start, end } = value.exactInterval;
    if (parseExactInstant(end) < parseExactInstant(start)) throw new Error('Invalid exact interval');
    return { start, end };
  }
  for (const clock of [value.actualStartsAt, value.actualEndsAt, value.starts_at, value.ends_at]) {
    if (typeof clock === 'string' && parseExactInstant(clock) % NS_PER_MS !== 0n) throw new Error('Missing precise interval');
  }
  const { start, end } = value.interval;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) throw new Error('Invalid legacy interval');
  return { start: formatExactInstant(BigInt(start) * NS_PER_MS), end: formatExactInstant(BigInt(end) * NS_PER_MS) };
}
