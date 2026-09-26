import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { loadAISettings } from '@/lib/services/ai-settings';
import { nextRelativeFire, scheduleOf } from '@/lib/services/routines';
import { firesOncePerDay, nextCronRun, sameLocalMinute } from '@/lib/services/routines/schedule';
import { createRequest, createRun } from '@/lib/ai/runs/store';
import { kickRun } from '@/lib/ai/runs/continue';
import type { ServiceScope } from '@/lib/services/types';

/** Family id → timezone, read once per tick instead of once per rule.
 *
 * Both loops in this file used to read `families.timezone` INSIDE the loop, so
 * a family with ten routines cost ten identical round trips. That matters here
 * specifically because the tick is deadline-bounded: every wasted round trip is
 * a routine that does not get processed before the worker gives up, and a
 * routine that is not processed does not fire.
 *
 * The error is returned, not swallowed. The reads it replaces destructured
 * `{ data: family }` alone and fell back to 'America/New_York' — so a failed
 * read did not lose precision, it ASSERTED a specific US zone for a family that
 * might be in Tokyo, and filed their routine against the wrong day. A routine
 * that fires late is recoverable; one filed against the wrong wall clock is the
 * bug this file's own DST handling exists to prevent.
 */
async function timezonesFor(
  db: DB,
  rules: readonly { family_id: string }[],
): Promise<{ zones: Map<string, string>; error: unknown }> {
  const ids = [...new Set(rules.map((r) => r.family_id).filter(Boolean))];
  if (ids.length === 0) return { zones: new Map(), error: null };
  const { data, error } = await db.from('families').select('id, timezone').in('id', ids);
  if (error) return { zones: new Map(), error };
  return { zones: new Map((data ?? []).map((f) => [f.id, f.timezone])), error: null };
}

/** The zone for a rule's family, or null when the read failed and we must not guess. */
function zoneFor(zones: Map<string, string>, familyId: string): string {
  // A family row that is genuinely absent or blank keeps the long-standing
  // default. Only a FAILED read is treated as unknown, above.
  return zones.get(familyId) || 'America/New_York';
}

export const runtime = 'nodejs';
export const maxDuration = 120;

// The routine worker (§19, §58): fires "every Sunday, plan our meals" and
// "two days before every trip, make sure we're ready".
//
// WHAT IT DOES NOT DO: execute anything. A due routine files an ai_request and
// hands it to the same continuation worker every other request uses, so the
// planner, the trust gate and `family_ai_settings` all apply exactly as they
// would to a request typed by hand. A schedule is permission to ASK on a
// cadence, never permission to act unreviewed.
//
// FIRING EXACTLY ONCE: `routine_runs` is unique on (rule_id, due_at), so the
// worker reserves the occurrence BEFORE it files anything. Two workers racing
// on the same minute — the retry after a timeout, the overlapping tick — and
// only one insert survives; the loser does nothing. Reserving before filing is
// deliberate: the failure it risks is a missed occurrence, and the failure it
// prevents is a family being told the same thing twice.
const TICK_BUDGET_MS = 85_000;
const MAX_ROUTINES_PER_TICK = 25;

type DB = SupabaseClient<Database>;

/** How long a reservation may sit un-filed before we treat its worker as dead. */
const STALE_RESERVATION_MS = 15 * 60_000;

/** A cron/system scope for one family: no member, no role — the executor's own. */
function systemScope(db: DB, familyId: string, tz: string, now: Date): ServiceScope {
  return { db, familyId, userId: null, memberId: null, role: 'system', actorKind: 'system', tz, now };
}

export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('familyRoutines.unauthorized') }, { status: 401 });
  }

  const startedAt = Date.now();
  const deadline = startedAt + TICK_BUDGET_MS;
  const db = createServiceClient();
  const now = new Date();

  // Arm anything that has no next fire yet.
  //
  // `createRoutine` can only compute a cron's first fire; a relative routine's
  // depends on anchor rows that may not exist yet ("two days before every
  // trip", with no trip on file), so it is stored with `next_run_at: null`.
  // The due query below is `.lte('next_run_at', now)`, which null never
  // matches — so a relative routine was unreachable by construction, and a
  // routine nulled by a pause never came back. This is the pass that arms
  // them, and it is why `next_run_at` is no longer a one-way door.
  const armed = await armPendingRoutines(db, now);

  const { data: due, error } = await db
    .from('family_automation_rules')
    .select('id, family_id, name, action_config, schedule_kind, schedule_expr, anchor_key, offset_days, at_hour, next_run_at, said')
    .not('schedule_kind', 'is', null)
    .eq('is_enabled', true)
    .lte('next_run_at', now.toISOString())
    .order('next_run_at', { ascending: true })
    .limit(MAX_ROUTINES_PER_TICK);
  if (error) {
    console.error('[cron:family-routines] could not read due routines', error);
    return NextResponse.json({ error: t('familyRoutines.couldNotReadRoutines') }, { status: 500 });
  }

  let filed = 0;
  let skipped = 0;
  const problems: string[] = [];

  const { zones, error: zonesError } = await timezonesFor(db, due ?? []);
  if (zonesError) {
    // Every rule in this tick needs a wall clock and none of them has one.
    // Filing them against a guessed zone is the one outcome worse than filing
    // them a tick late, so the tick reports the failure and fires nothing.
    console.error('[cron:family-routines] could not read family timezones', zonesError);
    return NextResponse.json({ error: t('familyRoutines.couldNotReadRoutines') }, { status: 500 });
  }

  for (const rule of due ?? []) {
    if (Date.now() > deadline) break;
    const dueAt = rule.next_run_at;
    if (!dueAt) continue;

    const tz = zoneFor(zones, rule.family_id);

    // Reserve the occurrence first. A duplicate key means another worker has
    // it — not an error, just somebody else's turn.
    const { error: claimError } = await db.from('routine_runs').insert({
      family_id: rule.family_id, rule_id: rule.id, due_at: dueAt, status: 'filed',
    });
    if (claimError) {
      if (claimError.code === '23505') {
        // Somebody else has this occurrence — usually another worker, mid-tick.
        // But a worker that died between reserving and rescheduling leaves the
        // reservation behind forever, and the rule collides on it every tick
        // and never advances. An old reservation that never became a request is
        // that case: step the rule past it so the routine lives again.
        await releaseWedgedOccurrence(db, rule, dueAt, now, tz);
        skipped += 1;
        continue;
      }
      console.error('[cron:family-routines] could not reserve the occurrence', claimError);
      problems.push(rule.id);
      continue;
    }

    const scope = systemScope(db, rule.family_id, tz, now);

    // The family's own switch. A paused Bubaly does not get to file work for
    // itself on a schedule the family set up before pausing it.
    //
    // Read STRICTLY. The forgiving read answered a failed query with the
    // defaults — "Bubaly on" — so one timeout filed a paused family's routine
    // anyway (SEC-009). A switch we cannot read holds the occurrence exactly as
    // a pause does, with a detail that says which of the two it was, and the
    // tick reports it as a problem rather than a quiet skip.
    const read = await loadAISettings(scope);
    const schedule = scheduleOf(rule);
    const held = !read.ok || !read.data.enabled;
    if (held || !schedule) {
      await db.from('routine_runs').update({
        status: 'skipped',
        detail: !held
          ? 'The routine no longer has a readable schedule.'
          : read.ok
            ? 'Bubaly is switched off for this family.'
            : "Bubaly could not read this family's settings, so this occurrence was not filed.",
      }).eq('rule_id', rule.id).eq('due_at', dueAt);
      if (!read.ok) problems.push(rule.id);
      // A pause is not a deletion. Advancing to the next occurrence lets the
      // routine simply resume when the family switches Bubaly back on; nulling
      // it (what this used to do) silently lost every routine a family owned
      // the moment they paused for a week. An unreadable switch is advanced the
      // same way, so a read failure costs this one occurrence and never the
      // routine.
      const after = schedule && held
        ? await nextFireAfter(db, rule.family_id, schedule, now, tz)
        : null;
      // Same field as the reschedule below, so the same risk — though this one
      // self-heals: the skip path files no request, so a stale reservation does
      // eventually reach releaseWedgedOccurrence. That costs the family a
      // STALE_RESERVATION_MS delay on a routine they only paused, which is worth
      // a log line rather than a silent wait.
      const { error: pausedError } = await db.from('family_automation_rules')
        .update({ next_run_at: after ? after.toISOString() : null, last_run_at: now.toISOString() })
        .eq('id', rule.id);
      if (pausedError) console.error('[cron:family-routines] could not reschedule a skipped routine', rule.id, pausedError);
      skipped += 1;
      continue;
    }

    const config = (rule.action_config ?? {}) as { prompt?: unknown };
    const prompt = typeof config.prompt === 'string' && config.prompt.trim() ? config.prompt.trim() : rule.name;

    // The three routine_runs status writes below deliberately keep their results
    // discarded, and it is worth saying why rather than leaving it looking
    // missed. Nothing outside this file reads routine_runs, and the one read
    // inside it — releaseWedgedOccurrence — looks at request_id and created_at,
    // never status. So a refused status write costs an inaccurate internal row
    // and drives no decision; the tick already reports the outcome through
    // `problems`/`filed`. The request_id write is the interesting one, because
    // that column IS read: if it is refused, a later tick treats the reservation
    // as abandoned and steps the rule past the occurrence — which is what the
    // reschedule does anyway, so the outcome matches and the wedge above becomes
    // recoverable rather than permanent.
    const request = await createRequest(scope, { requestText: prompt, kind: 'routine' }, { db });
    if (!request.ok) {
      await db.from('routine_runs').update({ status: 'failed', detail: request.error }).eq('rule_id', rule.id).eq('due_at', dueAt);
      problems.push(rule.id);
    } else {
      const run = await createRun(scope, { requestId: request.data.id, runType: 'routine', summary: prompt, state: 'queued' }, { db });
      await db.from('routine_runs').update({ status: 'filed', request_id: request.data.id }).eq('rule_id', rule.id).eq('due_at', dueAt);
      if (run.ok) kickRun(run.data.id, { budgetMs: 20_000 });
      filed += 1;
    }

    // Schedule the next occurrence. A cron's is arithmetic; a relative
    // routine's is read from its anchor rows, because the trip may have moved.
    let next = schedule.kind === 'cron'
      ? nextCronRun(schedule.expr, now, tz)
      : await nextRelativeFire(db, rule.family_id, schedule, now, tz);

    // The autumn DST transition repeats an hour, so a once-a-day routine's wall
    // clock arrives TWICE. Measured for America/New_York on 2026-11-01: a
    // `30 1 * * *` rule matches 05:30Z and again 06:30Z, and both render as
    // 01:30 to the family. The occurrence key is (rule_id, due_at), and those
    // are two different instants, so the reservation above does not stop it —
    // the routine simply happens twice that night.
    //
    // Only for a FIXED hour. `0 * * * *` also repeats its wall clock across the
    // transition and should run in both, because two real hours pass; the
    // family did not ask for a time of day there, they asked for every hour.
    if (schedule.kind === 'cron' && next && dueAt
        && firesOncePerDay(schedule.expr)
        && sameLocalMinute(next, new Date(dueAt), tz)) {
      next = nextCronRun(schedule.expr, next, tz);
    }
    // This write is the only thing that moves the rule off the occurrence it
    // just handled, and its result was discarded. A refused update leaves
    // next_run_at on the due_at that has already passed, so the next tick picks
    // the same occurrence, collides 23505 on the reservation, and hands it to
    // releaseWedgedOccurrence — which returns immediately, because that guard is
    // for reservations that never became a request and this one did. There is no
    // path out: the routine is wedged for good, counted as filed, on one
    // transient error. The family's routine simply stops happening.
    const { error: rescheduleError } = await db.from('family_automation_rules')
      .update({ next_run_at: next ? next.toISOString() : null, last_run_at: now.toISOString() })
      .eq('id', rule.id);
    if (rescheduleError) {
      console.error('[cron:family-routines] filed the occurrence but could not advance the rule', rule.id, rescheduleError);
      problems.push(rule.id);
    }
  }

  return NextResponse.json({
    ok: problems.length === 0,
    considered: (due ?? []).length,
    armed,
    filed,
    skipped,
    problems: problems.length,
    ms: Date.now() - startedAt,
  });
}

/** The next fire for a schedule of either kind, in one call. */
async function nextFireAfter(
  db: DB,
  familyId: string,
  schedule: NonNullable<ReturnType<typeof scheduleOf>>,
  from: Date,
  tz: string,
): Promise<Date | null> {
  return schedule.kind === 'cron'
    ? nextCronRun(schedule.expr, from, tz)
    : nextRelativeFire(db, familyId, schedule, from, tz);
}

/**
 * Give every armed-but-unscheduled routine a next fire.
 *
 * Bounded, and only ever writes a time: a rule whose schedule cannot be read,
 * or whose anchor has nothing upcoming, is left alone for the next tick rather
 * than repeatedly rewritten. Returns how many were armed, which the response
 * reports so a quiet tick is distinguishable from a broken one.
 */
async function armPendingRoutines(db: DB, now: Date): Promise<number> {
  const { data: pending, error } = await db
    .from('family_automation_rules')
    .select('id, family_id, schedule_kind, schedule_expr, anchor_key, offset_days, at_hour, said, next_run_at')
    .not('schedule_kind', 'is', null)
    .eq('is_enabled', true)
    .is('next_run_at', null)
    .limit(MAX_ROUTINES_PER_TICK);
  if (error) {
    console.error('[cron:family-routines] could not read unscheduled routines', error);
    return 0;
  }

  const { zones, error: zonesError } = await timezonesFor(db, pending ?? []);
  if (zonesError) {
    // Arming writes `next_run_at`, the instant every later tick compares
    // against. Computing it from a guessed zone would bake the wrong wall
    // clock into the rule until something rearms it, so: nothing armed, and
    // the tick says so by returning 0.
    console.error('[cron:family-routines] could not read family timezones while arming', zonesError);
    return 0;
  }

  let armed = 0;
  for (const rule of pending ?? []) {
    const schedule = scheduleOf(rule);
    if (!schedule) continue;
    const tz = zoneFor(zones, rule.family_id);
    const next = await nextFireAfter(db, rule.family_id, schedule, now, tz);
    if (!next) continue;
    // `armed` is returned and reported in the response precisely so a quiet tick
    // reads differently from a broken one, so it may only count writes that
    // landed. A refused update leaves next_run_at NULL — the rule stays
    // unscheduled and never fires — while the tick reported it as armed.
    const { error: armError } = await db.from('family_automation_rules')
      .update({ next_run_at: next.toISOString() }).eq('id', rule.id);
    if (armError) {
      console.error('[cron:family-routines] could not arm routine', rule.id, armError);
      continue;
    }
    armed += 1;
  }
  return armed;
}

/**
 * Step a rule past an occurrence whose reservation was abandoned.
 *
 * Only when the reservation is old AND never became a request — a live worker
 * mid-tick, or one that already filed, is somebody else's turn and is left
 * alone. Without this, one worker dying between the reserve and the reschedule
 * wedged that routine on the same `due_at` forever.
 */
async function releaseWedgedOccurrence(
  db: DB,
  rule: Parameters<typeof scheduleOf>[0] & { id: string; family_id: string },
  dueAt: string,
  now: Date,
  tz: string,
): Promise<void> {
  const { data: reservation } = await db
    .from('routine_runs')
    .select('status, request_id, created_at')
    .eq('rule_id', rule.id)
    .eq('due_at', dueAt)
    .maybeSingle();
  if (!reservation || reservation.request_id) return;
  const age = now.getTime() - Date.parse(String(reservation.created_at ?? ''));
  if (!Number.isFinite(age) || age < STALE_RESERVATION_MS) return;

  const schedule = scheduleOf(rule);
  const next = schedule ? await nextFireAfter(db, rule.family_id, schedule, now, tz) : null;
  const { error: markError } = await db.from('routine_runs')
    .update({ status: 'failed', detail: 'Bubaly stopped before it could file this one.' })
    .eq('rule_id', rule.id).eq('due_at', dueAt);
  if (markError) console.error('[cron:family-routines] could not mark the abandoned reservation', rule.id, markError);
  // This is the un-wedging write. If it is refused the rule stays on the same
  // occurrence and arrives back here every tick — the exact state this function
  // exists to end — so a silent failure turns the recovery into a no-op that
  // looks like it ran.
  const { error: stepError } = await db.from('family_automation_rules')
    .update({ next_run_at: next ? next.toISOString() : null, last_run_at: now.toISOString() })
    .eq('id', rule.id);
  if (stepError) console.error('[cron:family-routines] could not step the wedged rule past its occurrence', rule.id, stepError);
}
