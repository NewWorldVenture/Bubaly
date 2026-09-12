// A scheduled post carries an absolute instant and an explicit display zone.
// Bare datetime-local values are resolved before they reach the server action.
export type ScheduleTimeResult =
  | { ok: true; scheduledFor: string; timezone: string }
  | { ok: false; key: 'socialSchedule.invalidTime' | 'socialSchedule.invalidZone' | 'socialSchedule.pastTime' | 'socialSchedule.clockChange' };

export function scheduleTimezone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return null;
  try { return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone; }
  catch { return null; }
}

function wallFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
}

function wallParts(formatter: Intl.DateTimeFormat, ms: number): string {
  const parts = formatter.formatToParts(ms);
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}

/** Reject calendar normalization, missing times and repeated DST wall times. */
export function resolveScheduleTime(local: string, zone: string, now = Date.now()): ScheduleTimeResult {
  const timezone = scheduleTimezone(zone);
  if (!timezone) return { ok: false, key: 'socialSchedule.invalidZone' };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) || !Number.isFinite(now)) return { ok: false, key: 'socialSchedule.invalidTime' };
  const wall = `${local}:00`;
  const guess = Date.parse(`${wall}Z`);
  if (!Number.isFinite(guess) || new Date(guess).toISOString().slice(0, 19) !== wall) return { ok: false, key: 'socialSchedule.invalidTime' };
  const formatter = wallFormatter(timezone);
  // Collect offsets on both sides of the intended date, then verify every
  // candidate by round-trip. This includes non-hour changes and date-line gaps.
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 3) {
    const instant = guess + hours * 3_600_000;
    offsets.add(Date.parse(`${wallParts(formatter, instant)}Z`) - instant);
  }
  const candidates = [...offsets].map(offset => guess - offset)
    .filter(instant => Number.isFinite(instant) && wallParts(formatter, instant) === wall);
  if (candidates.length !== 1) return { ok: false, key: 'socialSchedule.clockChange' };
  if (candidates[0] <= now) return { ok: false, key: 'socialSchedule.pastTime' };
  return { ok: true, scheduledFor: new Date(candidates[0]).toISOString(), timezone };
}

/** Server contract: only an explicit ISO instant, never process-local parsing. */
export function validateScheduleInstant(value: string, zone: string, now = Date.now()): ScheduleTimeResult {
  const timezone = scheduleTimezone(zone);
  if (!timezone) return { ok: false, key: 'socialSchedule.invalidZone' };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(now)) return { ok: false, key: 'socialSchedule.invalidTime' };
  const instant = Date.parse(value);
  const canonical = value.length === 20 ? `${value.slice(0, -1)}.000Z` : value;
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== canonical) return { ok: false, key: 'socialSchedule.invalidTime' };
  if (instant <= now) return { ok: false, key: 'socialSchedule.pastTime' };
  return { ok: true, scheduledFor: new Date(instant).toISOString(), timezone };
}

/** Legacy rows without a saved zone display explicitly in UTC. */
export function scheduleDisplayTimezone(metadata: unknown): string {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata) && 'schedule_timezone' in metadata) {
    return scheduleTimezone(metadata.schedule_timezone) ?? 'UTC';
  }
  return 'UTC';
}

export function formatScheduledTime(value: string, zone: string, locale = 'en-GB'): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  const timezone = scheduleTimezone(zone) ?? 'UTC';
  return `${new Intl.DateTimeFormat(locale, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(ms)} (${timezone})`;
}

export function scheduledDay(value: string, zone: string): string | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return wallParts(wallFormatter(scheduleTimezone(zone) ?? 'UTC'), ms).slice(0, 10);
}

/** Presentation only: public metadata never grants permission to publish. */
export function scheduleStatusKey(metadata: unknown): string {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'socialSchedule.legacyUnverified';
  const fields = metadata as Record<string, unknown>;
  if (fields.schedule_phase === 'dispatching' || fields.schedule_phase === 'unknown') return 'socialSchedule.awaitingConfirmation';
  if (fields.schedule_phase === 'approval_required') return 'socialSchedule.approvalRequired';
  const allowedErrors = ['invalid', 'unsupported', 'accessUnavailable', 'permissionDenied', 'storageUnavailable',
    'approvalRequired', 'changed', 'reconnectRequired', 'awaitingConfirmation', 'legacyUnverified', 'saveUnconfirmed'];
  if (typeof fields.schedule_error === 'string' && allowedErrors.some(key => fields.schedule_error === `socialSchedule.${key}`)) return fields.schedule_error;
  switch (fields.schedule_phase) {
    case 'queued': return 'socialSchedule.queued';
    case 'unarmed': return 'socialSchedule.saveUnconfirmed';
    case 'failed': return 'socialSchedule.changed';
    case 'completed': return '';
    default: return 'socialSchedule.legacyUnverified';
  }
}
