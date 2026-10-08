import { ImportedSourceValidationError, validateImportedSourceRule, type SourceTime } from '@/lib/calendar/imported-source';

export interface CivilDateTime { year: number; month: number; day: number; hour: number; minute: number; second: number }
export interface SourceRuleOccurrence { original: SourceTime; instant: number }
export interface SourceRuleOptions {
  start: SourceTime;
  rule: string;
  /** Generated wall clocks: null means a nonexistent local time. */
  resolve: (civil: CivilDateTime) => number | null;
  /** The original DTSTART is explicit source data, including valid gap syntax.
   * Supply the clock's explicit resolver; it is never used for later slots. */
  resolveStart?: (civil: CivilDateTime) => number | null;
  /** Inclusive instant coverage, not a request to finish an infinite rule. */
  through: number;
  maxWork?: number;
  maxOccurrences?: number;
  /** Optional outer budget shared across multiple rules/clocks. */
  consumeWork?: () => void;
}
const DAY = 86_400_000;
const OFFSET_BOUND = 2 * DAY;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const FREQUENCIES = ['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
function fail(message: string): never { throw new ImportedSourceValidationError(`recurrence ${message}`); }
function timestamp(civil: CivilDateTime): number {
  const date = new Date(0);
  date.setUTCFullYear(civil.year, civil.month - 1, civil.day);
  date.setUTCHours(civil.hour, civil.minute, civil.second, 0);
  return date.getTime();
}
function civil(value: number): CivilDateTime {
  const date = new Date(value);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
}
function midnight(year: number, month = 1, day = 1): number { return timestamp({ year, month, day, hour: 0, minute: 0, second: 0 }); }
function token(value: CivilDateTime, dateOnly: boolean): string {
  const pad = (number: number, size = 2) => String(number).padStart(size, '0');
  return `${pad(value.year, 4)}${pad(value.month)}${pad(value.day)}${dateOnly ? '' : `T${pad(value.hour)}${pad(value.minute)}${pad(value.second)}`}`;
}
function parseToken(value: string): CivilDateTime {
  return { year: +value.slice(0, 4), month: +value.slice(4, 6), day: +value.slice(6, 8), hour: +(value.slice(9, 11) || 0), minute: +(value.slice(11, 13) || 0), second: +(value.slice(13, 15) || 0) };
}
function monthDays(year: number, month: number): number { return (midnight(year, month + 1) - midnight(year, month)) / DAY; }
function weekday(day: number): number { return new Date(day).getUTCDay(); }
function weekStart(day: number, wkst: number): number { return day - ((weekday(day) - wkst + 7) % 7) * DAY; }
function firstWeek(year: number, wkst: number): number { return weekStart(midnight(year, 1, 4), wkst); }
function signedMatch(value: number, length: number, selections: readonly number[]): boolean {
  return selections.some(selection => value === (selection > 0 ? selection : length + selection + 1));
}

/** Bounded Gregorian candidate expansion, following RFC5545 section3.3.10's
 * expand/limit table. This does not apply RDATE/EXDATE, overrides or durations.
 * An unqualified clock, undefined DTSTART pattern, unsupported leap-second
 * stepping, or exhausted bound throws; no incomplete prefix is returned.
 */
export function expandSourceRule(options: SourceRuleOptions): SourceRuleOccurrence[] {
  const { start, rule, resolve, through } = options;
  if (typeof rule !== 'string' || typeof resolve !== 'function' || options.resolveStart !== undefined && typeof options.resolveStart !== 'function') fail('needs a rule and qualified resolver');
  if (!start || !['date', 'utc', 'zoned', 'floating'].includes(start.kind) || typeof start.value !== 'string') fail('needs a typed DTSTART');
  const anchor = parseToken(start.value), dateOnly = start.kind === 'date';
  const expectedToken = token(anchor, dateOnly) + (start.kind === 'utc' ? 'Z' : '');
  if (expectedToken !== start.value || anchor.year < 1 || anchor.year > 9999 || anchor.month < 1 || anchor.month > 12 || anchor.day < 1 || anchor.day > monthDays(anchor.year, anchor.month) || anchor.hour > 23 || anchor.minute > 59 || anchor.second > 60) fail('invalid DTSTART');
  validateImportedSourceRule(rule, start);
  const parts = new Map(rule.toUpperCase().split(';').map(part => { const [key, value] = part.split('='); return [key, value]; }));
  const frequency = FREQUENCIES.indexOf(parts.get('FREQ')!);
  if ((dateOnly && frequency < 3) || anchor.second === 60 || (!dateOnly && parts.get('BYSECOND')?.split(',').includes('60'))) fail('subdaily DATE or leap-second stepping is not qualified');
  if (!Number.isFinite(through) || Math.abs(through) > 8.64e15) fail('needs a finite instant horizon');
  const maxWork = options.maxWork ?? 1_000_000, maxOccurrences = options.maxOccurrences ?? 20_000;
  if (!Number.isSafeInteger(maxWork) || maxWork < 1 || maxWork > 10_000_000 || !Number.isSafeInteger(maxOccurrences) || maxOccurrences < 1 || maxOccurrences > 100_000) fail('invalid work/output bound');
  let work = 0;
  const consume = () => { options.consumeWork?.(); if (++work > maxWork) fail('work bound exhausted; result is incomplete'); };
  const list = (key: string): number[] | null => parts.has(key) ? [...new Set(parts.get(key)!.split(',').map(Number))].sort((left, right) => left - right) : null;
  const months = list('BYMONTH'), monthdays = list('BYMONTHDAY'), yeardays = list('BYYEARDAY'), weeknos = list('BYWEEKNO'), positions = list('BYSETPOS');
  const timeSelectors = new Map(['BYHOUR', 'BYMINUTE', 'BYSECOND'].map(key => [key, list(key)]));
  const days = parts.get('BYDAY')?.split(',').map(value => { const match = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(value)!; return { ordinal: match[1] ? +match[1] : null, weekday: WEEKDAYS.indexOf(match[2]) }; }) ?? null;
  const wkst = WEEKDAYS.indexOf(parts.get('WKST') ?? 'MO');
  const interval = +(parts.get('INTERVAL') ?? '1'), count = +(parts.get('COUNT') ?? 'Infinity'), until = parts.get('UNTIL');
  const untilInstant = until?.endsWith('Z') ? timestamp(parseToken(until)) : null;
  const periodHorizon = Math.min(through, until ? untilInstant ?? timestamp(parseToken(until)) : Infinity);
  if (until?.slice(13, 15) === '60') fail('leap-second UNTIL comparison is not qualified');
  const times = (key: string, rank: number, current: number, fallback: number): number[] => {
    if (dateOnly) return [0];
    const selected = timeSelectors.get(key)!;
    return frequency > rank ? selected ?? [fallback] : !selected || selected.includes(current) ? [current] : [];
  };
  const startDay = midnight(anchor.year, anchor.month, anchor.day), startPseudo = timestamp(anchor);
  let period = frequency === 6 ? midnight(anchor.year) : frequency === 5 ? midnight(anchor.year, anchor.month) : frequency === 4 ? weekStart(startDay, wkst) : frequency === 3 ? startDay : frequency === 2 ? startPseudo - (anchor.minute * 60 + anchor.second) * 1000 : frequency === 1 ? startPseudo - anchor.second * 1000 : startPseudo;
  const output: SourceRuleOccurrence[] = [];
  let total = 0, anchorSelected = false;
  const resolveChecked = (value: CivilDateTime, resolver = resolve): number | null => {
    consume();
    const result = resolver({ ...value });
    if (result !== null && (!Number.isFinite(result) || !Number.isInteger(result) || Math.abs(result - timestamp(value)) > OFFSET_BOUND)) fail('clock returned invalid instant or offset outside qualified bound');
    return result;
  };
  for (let index = 0; ; index++) {
    consume();
    // A week-year can begin in December, before its January period anchor.
    if (!Number.isFinite(period) || period > periodHorizon + OFFSET_BOUND + (frequency === 6 && weeknos ? 7 * DAY : 0)) break;
    const base = civil(period);
    if (base.year < 1 || base.year > 9999) fail('calendar year coverage exhausted');
    let end: number, next: number, fromDay: number;
    if (frequency === 6) {
      fromDay = weeknos ? firstWeek(base.year, wkst) : period;
      end = weeknos ? firstWeek(base.year + 1, wkst) : midnight(base.year + 1);
      next = midnight(base.year + interval);
    } else if (frequency === 5) { fromDay = period; end = midnight(base.year, base.month + 1); next = midnight(base.year, base.month + interval); }
    else if (frequency === 4) { fromDay = period; end = period + 7 * DAY; next = period + interval * 7 * DAY; }
    else { fromDay = midnight(base.year, base.month, base.day); end = fromDay + DAY; next = period + interval * [1000, 60_000, 3_600_000, DAY][frequency]; }
    const candidates: SourceRuleOccurrence[] = [];
    for (let day = fromDay; day < end; day += DAY) {
      consume();
      const date = civil(day), length = monthDays(date.year, date.month);
      if (months && !months.includes(date.month)) continue;
      if (weeknos && !signedMatch(Math.floor((day - firstWeek(base.year, wkst)) / (7 * DAY)) + 1, (firstWeek(base.year + 1, wkst) - firstWeek(base.year, wkst)) / (7 * DAY), weeknos)) continue;
      if (yeardays && (frequency === 6 && date.year !== base.year || !signedMatch((day - midnight(date.year)) / DAY + 1, (midnight(date.year + 1) - midnight(date.year)) / DAY, yeardays))) continue;
      if (monthdays && !signedMatch(date.day, length, monthdays)) continue;
      if (days && !days.some(selected => {
        if (weekday(day) !== selected.weekday) return false;
        if (selected.ordinal === null) return true;
        const first = frequency === 5 || months ? midnight(date.year, date.month) : midnight(date.year);
        const last = frequency === 5 || months ? midnight(date.year, date.month + 1) : midnight(date.year + 1);
        return selected.ordinal > 0 ? Math.floor((day - first) / (7 * DAY)) + 1 === selected.ordinal : -(Math.floor((last - DAY - day) / (7 * DAY)) + 1) === selected.ordinal;
      })) continue;
      if (frequency === 6 && !yeardays && !monthdays && !days && !weeknos && (date.day !== anchor.day || !months && date.month !== anchor.month)) continue;
      if (frequency === 6 && weeknos && !days && weekday(day) !== weekday(startDay)) continue;
      if (frequency === 5 && !monthdays && !days && date.day !== anchor.day) continue;
      if (frequency === 4 && !days && weekday(day) !== weekday(startDay)) continue;
      const hours = times('BYHOUR', 2, base.hour, anchor.hour), minutes = times('BYMINUTE', 1, base.minute, anchor.minute), seconds = times('BYSECOND', 0, base.second, anchor.second);
      for (const hour of hours) for (const minute of minutes) for (const second of seconds) {
        consume();
        const value = { ...date, hour, minute, second };
        const original: SourceTime = { ...start, value: token(value, dateOnly) + (start.kind === 'utc' ? 'Z' : '') };
        const generated = resolveChecked(value);
        let instant = generated;
        if (original.value === start.value && options.resolveStart) {
          instant = resolveChecked(value, options.resolveStart);
          if (instant !== null && generated === null && positions) fail('explicit gap DTSTART with BYSETPOS requires separate qualification');
        }
        if (instant === null) continue; // Generated gaps removed before positions/count; explicit seed is distinct.
        if (candidates.length >= 100_000) fail('period candidate bound exhausted; result is incomplete');
        candidates.push({ original, instant });
      }
    }
    candidates.sort((left, right) => left.original.value.localeCompare(right.original.value));
    const selected = positions ? [...new Set(positions.map(position => position > 0 ? position - 1 : candidates.length + position).filter(position => position >= 0 && position < candidates.length))].sort((left, right) => left - right).map(position => candidates[position]) : candidates;
    if (index === 0) {
      anchorSelected = selected.some(candidate => candidate.original.value === start.value);
      if (!anchorSelected) fail('DTSTART does not match qualified generated rule pattern');
    }
    for (const candidate of selected) {
      if (candidate.original.value < start.value) continue;
      if (until && (untilInstant === null ? candidate.original.value > until : candidate.instant > untilInstant)) continue;
      if (++total > count) return output;
      if (candidate.instant <= through) {
        if (output.length >= maxOccurrences) fail('output bound exhausted; result is incomplete');
        output.push(candidate);
      }
      if (total === count) return output;
    }
    period = next;
  }
  return output;
}
