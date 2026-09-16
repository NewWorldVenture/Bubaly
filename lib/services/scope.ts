// Builds a `ServiceScope` from the two contexts that can call a service, and
// owns the timezone arithmetic every service needs.
//
// Why the timezone helpers live here rather than in a shared date module: the
// only reason a service knows about time zones at all is that `scope.tz` says
// which one the family lives in.
//
// They all resolve a `YYYY-MM-DD` day key in the family's zone, because the
// UTC-anchored answer is wrong for "what is today for this family" — a
// household in America/Los_Angeles gets tomorrow's day key for the last seven
// hours of every day. `lib/ai/weekly.ts` used to be the counter-example named
// here, its windows genuinely UTC-anchored; that was the defect, not the
// design, and `weekWindow`/`bucketByDay` now take a `tz` too.
//
// The arithmetic itself lives in `lib/time/zoned.ts` and is re-exported from
// here. This module is `server-only`, and a client component asking "does this
// expire today" has to reach the same answer as the server-rendered page beside
// it, so it imports `dayKeyIn` from there directly.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { requireUserContext } from '@/lib/supabase/auth';
import type { ServiceScope } from './types';
import { dayKeyIn } from '@/lib/time/zoned';

/** Fallback when a family row somehow carries no timezone (0002 defaults it to 'UTC'). */
const DEFAULT_TZ = 'UTC';

/**
 * The scope for a signed-in caller. `ctx.active.member.id` is the
 * `family_members` row id — the value most household tables' `created_by` and
 * `assigned_to` columns actually reference — while `ctx.user.id` is the
 * `auth.users` id. Carrying both is what lets a service pick the right one per
 * column instead of guessing.
 */
export function scopeFromUserContext(
  ctx: Awaited<ReturnType<typeof requireUserContext>>,
  db: SupabaseClient<Database>,
  extra?: Partial<ServiceScope>,
): ServiceScope {
  return {
    db,
    familyId: ctx.active.familyId,
    userId: ctx.user.id,
    memberId: ctx.active.member.id,
    role: ctx.active.role,
    actorKind: 'member',
    tz: ctx.active.family.timezone || DEFAULT_TZ,
    ...extra,
  };
}

/**
 * The scope for a cron or the run executor. There is no human behind it, so
 * `userId`/`memberId` are null and `role` is 'system'; the caller is expected
 * to have passed the service client, which is precisely why every service
 * filters `family_id` itself.
 */
export function scopeForSystem(
  db: SupabaseClient<Database>,
  family: { id: string; timezone?: string | null },
  extra?: Partial<ServiceScope>,
): ServiceScope {
  return {
    db,
    familyId: family.id,
    userId: null,
    memberId: null,
    role: 'system',
    actorKind: 'system',
    tz: family.timezone || DEFAULT_TZ,
    ...extra,
  };
}

/**
 * A system scope for a webhook or a cron that knows only a family id.
 *
 * The timezone read is the point. `scopeForSystem` falls back to `DEFAULT_TZ`
 * when a caller has none, and for anything time-sensitive that fallback is
 * worse than no scope at all: quiet hours evaluated against the wrong zone hold
 * a family's notification at six in the evening and let one through at two in
 * the morning. A caller that does not know the family's zone should ask for it,
 * not assume it.
 *
 * Returns null when the family cannot be read, so a caller fails visibly rather
 * than acting for a household it could not identify.
 */
export async function systemScopeForFamily(
  db: SupabaseClient<Database>,
  familyId: string,
  extra?: Partial<ServiceScope>,
): Promise<ServiceScope | null> {
  const { data, error } = await db.from('families').select('id, timezone').eq('id', familyId).maybeSingle();
  if (error || !data) {
    console.error('[scope] family read failed', { familyId, error });
    return null;
  }
  return scopeForSystem(db, data, extra);
}

/** The scope's clock. Tests inject `now`; production reads the real one. */
export function scopeNow(scope: Pick<ServiceScope, 'now'>): Date {
  return scope.now ? new Date(scope.now.getTime()) : new Date();
}

/**
 * The family's calendar day for an instant, as `YYYY-MM-DD`. `en-CA` is used
 * because it is the one widely-supported locale whose short date format is
 * already ISO-ordered — the same trick `lib/assistant/tools.ts` uses when it
 * compares an event's local day against a requested date.
 */
export function dayKeyInTz(date: Date, tz: string): string {
  // One implementation, in `lib/time/zoned.ts`, because a CLIENT component needs
  // the same answer and this module is `server-only`. "Does this expire today?"
  // has to mean the same day on a server-rendered page and a browser-rendered
  // one, and it only does if both ask about the family's zone.
  return dayKeyIn(date, tz);
}

/**
 * Today, as THIS FAMILY's calendar day, for a server action holding a user
 * context.
 *
 * Six server actions defaulted a date column with
 * `new Date().toISOString().slice(0, 10)` — the host's day, which on a UTC
 * server is tomorrow from 5pm in California. A service record logged in the
 * evening was dated tomorrow; `moment_activations.as_of_date` was written for
 * tomorrow by a function whose own comment says "hide a moment for the rest of
 * TODAY", so the moment stayed on screen and was pre-dismissed the next day.
 *
 * It exists so the `|| DEFAULT_TZ` fallback is written once. Six copies of a
 * defaulting rule is how the seventh gets it wrong.
 *
 * TOTAL on purpose. `active.family` is always present on a real context, but
 * this only supplies a DEFAULT for a date column, and an action that would
 * otherwise have succeeded must not die because the zone could not be read —
 * the same reason `dayKeyInTz` swallows an invalid IANA name rather than taking
 * a household write down with it. Two write-boundary tests caught this: their
 * contexts carry no `family`, and the first version threw.
 */
export function todayKeyFor(
  ctx: { active?: { family?: { timezone?: string | null } | null } | null },
  now: Date = new Date(),
): string {
  return dayKeyInTz(now, ctx?.active?.family?.timezone || DEFAULT_TZ);
}

/** Wall-clock hour (0–23) in the family's zone — the unit quiet-hour prefs use. */
export function hourInTz(date: Date, tz: string): number {
  try {
    const hour = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(date);
    const parsed = Number.parseInt(hour, 10);
    // 'en-US' renders midnight as '24' in some ICU versions; normalise it.
    return Number.isFinite(parsed) ? parsed % 24 : date.getUTCHours();
  } catch {
    return date.getUTCHours();
  }
}

/**
 * The UTC offset of `tz` at `date`, in milliseconds. Derived by formatting the
 * instant in the zone and re-reading those wall-clock fields as if they were
 * UTC: the difference is the offset in force at that moment, which is the only
 * way to get a DST-correct answer without a timezone database.
 */
function tzOffsetMs(date: Date, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date);
    const get = (type: string) => Number.parseInt(parts.find((p) => p.type === type)?.value ?? '', 10);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return Number.isFinite(asUtc) ? asUtc - date.getTime() : 0;
  } catch {
    return 0;
  }
}

/**
 * The instant at which local wall-clock `dayKey` `hh:mm` occurs in `tz`.
 *
 * Two passes are required: the offset itself depends on the instant, so the
 * first pass uses the offset at the naive-UTC guess and the second re-reads it
 * at the corrected instant. That converges for every real zone and is what
 * makes an 09:00 working-hours boundary land at 09:00 on both sides of a DST
 * transition.
 */
export function zonedTimeMs(dayKey: string, hour: number, minute: number, tz: string): number {
  const pad = (n: number) => String(n).padStart(2, '0');
  const guess = Date.parse(`${dayKey}T${pad(hour)}:${pad(minute)}:00Z`);
  if (!Number.isFinite(guess)) return Number.NaN;
  const firstPass = guess - tzOffsetMs(new Date(guess), tz);
  return guess - tzOffsetMs(new Date(firstPass), tz);
}

/** Start (inclusive) and end (exclusive) of a family-local day, as epoch ms. */
export function zonedDayBoundsMs(dayKey: string, tz: string): { start: number; end: number } {
  const start = zonedTimeMs(dayKey, 0, 0, tz);
  // Adding 24h to the previous midnight and re-resolving keeps the bound on a
  // real local midnight across the 23- and 25-hour DST days.
  const nextKey = dayKeyInTz(new Date(start + 36 * 3600_000), tz);
  return { start, end: zonedTimeMs(nextKey, 0, 0, tz) };
}

/** Every family-local day key touched by `[fromMs, toMs)`, in order. */
export function dayKeysBetween(fromMs: number, toMs: number, tz: string): string[] {
  const keys: string[] = [];
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return keys;
  let cursor = fromMs;
  // Guard against a pathological range producing an unbounded loop; a year of
  // day keys is far beyond anything a service window asks for.
  for (let i = 0; i < 400 && cursor < toMs; i += 1) {
    const key = dayKeyInTz(new Date(cursor), tz);
    keys.push(key);
    cursor = zonedDayBoundsMs(key, tz).end;
  }
  return keys;
}

/**
 * Move a `YYYY-MM-DD` day key by whole calendar days.
 *
 * Deliberately string-in, string-out: it never touches an instant, so it cannot
 * be knocked off by a DST transition. `new Date(d.getTime() + 7 * 86_400_000)`
 * is the idiom this replaces, and it is wrong twice a year — the week that
 * crosses a spring-forward is 167 hours long, so adding seven fixed days lands
 * on 23:00 the previous evening and formats as the day before.
 */
export function addDaysToDayKey(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split('-').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return dayKey;
  // UTC arithmetic on a date-only value is exact: no zone is involved, so the
  // usual DST hazards of Date arithmetic do not apply here.
  const moved = new Date(Date.UTC(y, m - 1, d + days));
  return moved.toISOString().slice(0, 10);
}

/**
 * The Monday on or before `dayKey`, as a day key. Weeks in this product start
 * on Monday (the meal planner, the chore week and the kitchen page all agree).
 */
export function weekStartDayKey(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return dayKey;
  const at = new Date(Date.UTC(y, m - 1, d));
  // getUTCDay(): 0=Sun … 6=Sat. Shift so Monday is 0.
  const fromMonday = (at.getUTCDay() + 6) % 7;
  return addDaysToDayKey(dayKey, -fromMonday);
}
