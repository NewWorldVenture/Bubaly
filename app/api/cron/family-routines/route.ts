import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { getAISettings } from '@/lib/services/ai-settings';
import { nextRelativeFire, scheduleOf } from '@/lib/services/routines';
import { nextCronRun } from '@/lib/services/routines/schedule';
import { createRequest, createRun } from '@/lib/ai/runs/store';
import { kickRun } from '@/lib/ai/runs/continue';
import type { ServiceScope } from '@/lib/services/types';

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

  for (const rule of due ?? []) {
    if (Date.now() > deadline) break;
    const dueAt = rule.next_run_at;
    if (!dueAt) continue;

    const { data: family } = await db.from('families').select('timezone').eq('id', rule.family_id).maybeSingle();
    const tz = family?.timezone ?? 'America/New_York';

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
    const settings = await getAISettings(scope);
    const schedule = scheduleOf(rule);
    if (!settings.enabled || !schedule) {
      await db.from('routine_runs').update({
        status: 'skipped',
        detail: settings.enabled ? 'The routine no longer has a readable schedule.' : 'Bubaly is switched off for this family.',
      }).eq('rule_id', rule.id).eq('due_at', dueAt);
      // A pause is not a deletion. Advancing to the next occurrence lets the
      // routine simply resume when the family switches Bubaly back on; nulling
      // it (what this used to do) silently lost every routine a family owned
      // the moment they paused for a week.
      const after = schedule && !settings.enabled
        ? await nextFireAfter(db, rule.family_id, schedule, now, tz)
        : null;
      await db.from('family_automation_rules')
        .update({ next_run_at: after ? after.toISOString() : null, last_run_at: now.toISOString() })
        .eq('id', rule.id);
      skipped += 1;
      continue;
    }

    const config = (rule.action_config ?? {}) as { prompt?: unknown };
    const prompt = typeof config.prompt === 'string' && config.prompt.trim() ? config.prompt.trim() : rule.name;

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
    const next = schedule.kind === 'cron'
      ? nextCronRun(schedule.expr, now, tz)
      : await nextRelativeFire(db, rule.family_id, schedule, now, tz);
    await db.from('family_automation_rules')
      .update({ next_run_at: next ? next.toISOString() : null, last_run_at: now.toISOString() })
      .eq('id', rule.id);
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

  let armed = 0;
  for (const rule of pending ?? []) {
    const schedule = scheduleOf(rule);
    if (!schedule) continue;
    const { data: family } = await db.from('families').select('timezone').eq('id', rule.family_id).maybeSingle();
    const tz = family?.timezone ?? 'America/New_York';
    const next = await nextFireAfter(db, rule.family_id, schedule, now, tz);
    if (!next) continue;
    await db.from('family_automation_rules').update({ next_run_at: next.toISOString() }).eq('id', rule.id);
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
  await db.from('routine_runs')
    .update({ status: 'failed', detail: 'Bubaly stopped before it could file this one.' })
    .eq('rule_id', rule.id).eq('due_at', dueAt);
  await db.from('family_automation_rules')
    .update({ next_run_at: next ? next.toISOString() : null, last_run_at: now.toISOString() })
    .eq('id', rule.id);
}
