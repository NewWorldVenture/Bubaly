import { canonicalZone, IcsClock, invalid, readWall, validDay, type WallTime } from './ics-time';

export interface IcsProperty { name: string; params: Record<string, string>; value: string }
export interface IcsComponent { name: string; properties: IcsProperty[]; children: IcsComponent[] }

export function property(component: IcsComponent, name: string, required = false): IcsProperty | undefined {
  const values = component.properties.filter(item => item.name === name);
  if (values.length > 1 || (required && values.length !== 1)) return invalid('invalidCalendar');
  return values[0];
}

interface AnnualRule { month: number; monthDay?: number; ordinal?: number; weekday?: number; until?: number }
interface Observance { start: WallTime; from: number; to: number; rule?: AnnualRule; dates: WallTime[] }
interface Transition { at: number; from: number; to: number }
interface Definition { observances: Observance[] }

function offset(value: string): number {
  const match = /^([+-])([0-9]{2})([0-9]{2})([0-9]{2})?$/.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59) return invalid('unsupportedTimezone');
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0);
  if (seconds === 0 && match[1] === '-') return invalid('unsupportedTimezone');
  return seconds * 1000 * (match[1] === '-' ? -1 : 1);
}

function annualRule(value: string, start: WallTime): AnnualRule {
  const fields = new Map<string, string>();
  for (const item of value.split(';')) {
    const pair = item.split('=');
    if (pair.length !== 2 || fields.has(pair[0]) || !pair[1]) return invalid('unsupportedTimezone');
    fields.set(pair[0], pair[1]);
  }
  if (fields.get('FREQ') !== 'YEARLY' || (fields.has('INTERVAL') && fields.get('INTERVAL') !== '1')
    || [...fields.keys()].some(key => !['FREQ', 'INTERVAL', 'BYMONTH', 'BYMONTHDAY', 'BYDAY', 'UNTIL'].includes(key))) return invalid('unsupportedTimezone');
  const monthValue = fields.get('BYMONTH') ?? start.day.slice(5, 7);
  if (!/^[0-9]{1,2}$/.test(monthValue)) return invalid('unsupportedTimezone');
  const month = Number(monthValue);
  if (month < 1 || month > 12) return invalid('unsupportedTimezone');
  const result: AnnualRule = { month };
  if (fields.has('BYDAY')) {
    if (fields.has('BYMONTHDAY')) return invalid('unsupportedTimezone');
    const match = /^([+-]?[1-5])(SU|MO|TU|WE|TH|FR|SA)$/.exec(fields.get('BYDAY')!);
    if (!match) return invalid('unsupportedTimezone');
    result.ordinal = Number(match[1]); result.weekday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].indexOf(match[2]);
  } else {
    const value = fields.get('BYMONTHDAY') ?? start.day.slice(8);
    if (!/^[+-]?[0-9]{1,2}$/.test(value) || Number(value) === 0 || Math.abs(Number(value)) > 31) return invalid('unsupportedTimezone');
    result.monthDay = Number(value);
  }
  if (fields.has('UNTIL')) {
    const value = fields.get('UNTIL')!;
    if (!value.endsWith('Z')) return invalid('unsupportedTimezone');
    result.until = readWall(value.slice(0, -1)).ms;
  }
  return result;
}

function readDefinition(component: IcsComponent): Definition {
  if (!component.children.length || component.children.length > 128) return invalid('unsupportedTimezone');
  const observances = component.children.map(child => {
    if (!['STANDARD', 'DAYLIGHT'].includes(child.name) || child.children.length
      || child.properties.some(item => !['DTSTART', 'TZOFFSETFROM', 'TZOFFSETTO', 'RRULE', 'RDATE', 'TZNAME', 'COMMENT'].includes(item.name)
        && !item.name.startsWith('X-'))) return invalid('unsupportedTimezone');
    const startProperty = property(child, 'DTSTART', true)!;
    if (Object.keys(startProperty.params).some(key => key !== 'VALUE')
      || (startProperty.params.VALUE && startProperty.params.VALUE !== 'DATE-TIME')) return invalid('unsupportedTimezone');
    const start = readWall(startProperty.value);
    const from = offset(property(child, 'TZOFFSETFROM', true)!.value);
    const to = offset(property(child, 'TZOFFSETTO', true)!.value);
    const ruleProperty = property(child, 'RRULE');
    const dates = child.properties.filter(item => item.name === 'RDATE').flatMap(item => {
      if (Object.keys(item.params).some(key => key !== 'VALUE') || (item.params.VALUE && item.params.VALUE !== 'DATE-TIME')) return invalid('unsupportedTimezone');
      return item.value.split(',').map(readWall);
    });
    if (dates.length > 1000) return invalid('unsupportedTimezone');
    const rule = ruleProperty ? annualRule(ruleProperty.value, start) : undefined;
    if (rule?.until !== undefined && rule.until < start.ms - from) return invalid('unsupportedTimezone');
    return { start, from, to, dates, ...(rule ? { rule } : {}) };
  });
  return { observances };
}

function occurrence(observance: Observance, year: number): Transition | null {
  if (!observance.rule || year < 1 || year > 9999) return null;
  const rule = observance.rule;
  const prefix = String(year).padStart(4, '0') + '-' + String(rule.month).padStart(2, '0') + '-';
  const first = new Date(prefix + '01T12:00:00Z');
  const lastDate = new Date(first);
  lastDate.setUTCMonth(lastDate.getUTCMonth() + 1, 0);
  const last = lastDate.getUTCDate();
  let day: number;
  if (rule.monthDay !== undefined) day = rule.monthDay > 0 ? rule.monthDay : last + rule.monthDay + 1;
  else if (rule.ordinal! > 0) day = 1 + (rule.weekday! - first.getUTCDay() + 7) % 7 + (rule.ordinal! - 1) * 7;
  else day = last - (lastDate.getUTCDay() - rule.weekday! + 7) % 7 + (rule.ordinal! + 1) * 7;
  const dayKey = prefix + String(day).padStart(2, '0');
  if (day < 1 || day > last || !validDay(dayKey)) return null;
  const at = Date.parse(dayKey + 'T00:00:00Z') + observance.start.hour * 3_600_000
    + observance.start.minute * 60_000 + observance.start.second * 1000 - observance.from;
  if (at < observance.start.ms - observance.from || (rule.until !== undefined && at > rule.until)) return null;
  return { at, from: observance.from, to: observance.to };
}

function transitions(definition: Definition, year: number): Transition[] {
  const result: Transition[] = [];
  for (const observance of definition.observances) {
    result.push({ at: observance.start.ms - observance.from, from: observance.from, to: observance.to });
    for (const date of observance.dates) result.push({ at: date.ms - observance.from, from: observance.from, to: observance.to });
    const untilYear = observance.rule?.until === undefined ? year : Math.min(year, new Date(observance.rule.until).getUTCFullYear());
    const years = Array.from({ length: 9 }, (_, ago) => [year - ago, untilYear - ago]).flat();
    for (const candidate of new Set([...years, year + 1])) {
      const transition = occurrence(observance, candidate);
      if (transition) result.push(transition);
    }
  }
  result.sort((a, b) => a.at - b.at);
  for (let i = 1; i < result.length; i++) {
    if (result[i].at === result[i - 1].at && (result[i].from !== result[i - 1].from || result[i].to !== result[i - 1].to)) return invalid('unsupportedTimezone');
  }
  return result;
}

/** Validate applicable supplied IANA transitions, with bounded interval consistency checks. */
export class IcsZones {
  readonly clock = new IcsClock();
  private definitions = new Map<string, Definition>();
  private ranges = new Map<string, { start: number; end: number; points: Set<number> }>();

  constructor(components: IcsComponent[]) {
    if (components.length > 128) return invalid('unsupportedTimezone');
    for (const component of components) {
      const name = property(component, 'TZID', true)!.value;
      // A familiar suffix on a custom identifier is never a trustworthy alias.
      const canonical = canonicalZone(name);
      if (this.definitions.has(canonical)) return invalid('unsupportedTimezone');
      const location = property(component, 'X-LIC-LOCATION');
      if (location && canonicalZone(location.value) !== canonicalZone(name)) return invalid('unsupportedTimezone');
      this.definitions.set(canonical, readDefinition(component));
    }
  }

  resolve(wall: WallTime, zone: string): number {
    const at = this.clock.resolve(wall, zone);
    this.note(zone, at);
    return at;
  }

  note(zone: string, at: number): void {
    const canonical = canonicalZone(zone);
    const range = this.ranges.get(canonical);
    if (range) {
      range.start = Math.min(range.start, at); range.end = Math.max(range.end, at); range.points.add(at);
    } else this.ranges.set(canonical, { start: at, end: at, points: new Set([at]) });
  }

  verify(): void {
    for (const [zone, range] of this.ranges) {
      const definition = this.definitions.get(canonicalZone(zone));
      if (!definition) continue; // Common IANA-only exports use the runtime's timezone data.
      const startYear = new Date(range.start).getUTCFullYear(), endYear = new Date(range.end).getUTCFullYear();
      if (endYear - startYear > 200) return invalid('unsupportedTimezone');
      const all = new Map<number, Transition>();
      for (let year = startYear - 1; year <= endYear + 1; year++) for (const transition of transitions(definition, year)) {
        const previous = all.get(transition.at);
        if (previous && (previous.from !== transition.from || previous.to !== transition.to)) return invalid('unsupportedTimezone');
        all.set(transition.at, transition);
      }
      const ordered = [...all.values()].sort((a, b) => a.at - b.at);
      const atStart = ordered.filter(item => item.at <= range.start).at(-1);
      if (!atStart || atStart.to !== this.clock.offsetAt(range.start, zone)) return invalid('unsupportedTimezone');
      // The preceding transition is relevant even for a point event: a false
      // TZOFFSETFROM can otherwise masquerade as a valid gap/fold declaration.
      for (const transition of ordered.filter(item => item.at >= atStart.at && item.at <= range.end)) {
        if (this.clock.offsetAt(transition.at - 1000, zone) !== transition.from
          || this.clock.offsetAt(transition.at, zone) !== transition.to) return invalid('unsupportedTimezone');
      }
      const atEnd = ordered.filter(item => item.at <= range.end).at(-1)!;
      if (atEnd.to !== this.clock.offsetAt(range.end, zone)) return invalid('unsupportedTimezone');
      // Check every imported endpoint and nominal-duration resolution, including
      // intermediate events that may fall between the coarse interval samples.
      let pointIndex = ordered.findIndex(item => item.at === atStart.at);
      for (const point of [...range.points].sort((a, b) => a - b)) {
        while (pointIndex + 1 < ordered.length && ordered[pointIndex + 1].at <= point) pointIndex++;
        const applicable = ordered[pointIndex];
        if (applicable.to !== this.clock.offsetAt(point, zone)
          || this.clock.offsetAt(applicable.at - 1000, zone) !== applicable.from
          || this.clock.offsetAt(applicable.at, zone) !== applicable.to) return invalid('unsupportedTimezone');
      }
      // Detect omitted seasonal cycles. This is a bounded consistency check,
      // not an exhaustive validator of arbitrary historical timezone data.
      let index = ordered.findIndex(item => item.at === atStart.at);
      for (let at = range.start; at <= range.end; at += 7 * 86_400_000) {
        while (index + 1 < ordered.length && ordered[index + 1].at <= at) index++;
        if (ordered[index].to !== this.clock.offsetAt(at, zone)) return invalid('unsupportedTimezone');
      }
    }
  }
}
