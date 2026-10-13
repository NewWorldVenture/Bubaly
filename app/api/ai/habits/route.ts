import { NextResponse } from 'next/server';
import { refuseClosedOrTrialEnded } from '@/lib/server/account-standing';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { readAll } from '@/lib/supabase/read-all';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { dayKeyIn } from '@/lib/time/zoned';
import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { fenceUntrusted, UNTRUSTED_CONTENT_RULE } from '@/lib/ai/safety/untrusted';
import { doneDates } from '@/lib/habits/presets';
import { requireUserContext } from '@/lib/supabase/auth';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { buildCoachPrompt, parseCoachResponse, type HabitStat } from '@/lib/habits/ai';
import {
  currentStreak, longestStreak, completionRate, isDoneToday, addDays, type HabitLike,
} from '@/lib/habits/streaks';

// AI Life Coach for the Habit Tracker: reads the family's active habits + the
// last 90 days of check-ins, computes streak stats, and asks the configured AI
// provider for encouragement + concrete nudges. Auth-gated to the active family.
export async function POST() {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const { familyId } = ctx.active;
    const supabase = await createServer();
    // A closed or trial-ended family is refused before any work: see lib/server/account-standing.ts.
    const closed = await refuseClosedOrTrialEnded(supabase, familyId);
    if (closed) return closed;
    // No key: say so before any work, rather than let the provider's throw
    // reach the catch below as a generic failure.
    if (!(await isAIConfigured())) return NextResponse.json({ error: t('ai.theAiEngineIsnT'), code: 'not_configured' }, { status: 503 });
    // The page in front of this is feature-gated; this endpoint was not, and it
    // calls a model. Same resolver, so the two cannot disagree.
    const refused = await refuseUnlessEntitled(supabase, familyId, ['/dashboard/habits']);
    if (refused) return refused;
    const limited = await enforceAIRateLimit(supabase, `ai-habits:${ctx.user.id}`, { limit: 15 });
    if (!limited.ok) return NextResponse.json(
      { error: t('habits.tooManyHabitCoachRequests') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
    // The FAMILY's day, the one the module writes `habit_logs.log_date` in.
    // Greenwich's day told a Los Angeles evening that today's check-ins had not
    // happened, and a Tokyo morning that yesterday's were today's.
    const today = dayKeyIn(new Date(), ctx.active.family?.timezone || 'UTC');
    const since = addDays(today, -90);

    // `.limit(5000)` used to stand here and was never 5,000: PostgREST caps a
    // response at db-max-rows whatever the client asks for, so a household with
    // 6,500 logs in the window had its streaks computed from 1,000 of them —
    // measured, on seeded data. `max` is the same ceiling, actually honoured.
    // `Promise.all` rather than `settleAll` only because `readAll` already
    // answers `{ rows, error }` for a transport failure instead of rejecting —
    // the same guarantee, in the shape this destructuring needs.
    const [habitsResult, logsResult] = await Promise.all([
      supabase
        .from('habits')
        .select('id, title, cadence, target_per_period, weekdays')
        .eq('family_id', familyId)
        .eq('is_active', true)
        .limit(50),
      readAll<{ habit_id: string; log_date: string; count: number }>((from, to) => supabase
        .from('habit_logs')
        .select('habit_id, log_date, count')
        .eq('family_id', familyId)
        .gte('log_date', since)
        .order('id')
        .range(from, to), { max: 5000 }),
    ]);
    // The comment above explains the truncation hazard and the fix for it, and
    // then both errors were destructured away — including the one `readAll`
    // raises for exactly that hazard. It sets `error` BOTH for a failed page and
    // for a read that exceeds `max`, and hands back the partial rows either way
    // (see the `probe` reasoning in lib/supabase/read-all.ts). So a household
    // past the ceiling, or one whose read simply failed, had its streaks,
    // longest-streak and 30-day completion rate computed from a PREFIX and
    // returned at HTTP 200 as fact — "current streak 0" to someone who has not
    // missed a day.
    //
    // This repository has already fixed this exact shape twice with this exact
    // helper — `api/ai/wallet/child/[childId]` (C4-S4-02, "refuse rather than
    // invent a number") and `api/sync/feeds/[token]` (C4-S4-06, "refusing to
    // publish a partial calendar"). Third time, same answer. Audit C1-S9-25.
    const { data: habits, error: habitsError } = habitsResult;
    const { rows: logs, error: logsError } = logsResult;
    if (habitsError || logsError) {
      console.error('[ai/habits] habit read failed or was truncated', {
        familyId, habits: habitsError?.message, logs: logsError?.message,
      });
      return NextResponse.json({ error: t('habits.couldNotGenerateCoachingRight') }, { status: 503 });
    }

    if (!habits || habits.length === 0) {
      return NextResponse.json({ error: t('habits.addAHabitFirstThen') }, { status: 400 });
    }

    // A day counts once the habit's daily target is met, as the module counts
    // it (doneDates): a half-finished "8 cups of water" day is not done, and
    // the coach and the screen must agree on the streak.
    const logsByHabit = new Map<string, string[]>();
    for (const h of habits) logsByHabit.set(h.id, doneDates(logs ?? [], h.id, h.cadence === 'daily' ? h.target_per_period : 1));

    const stats: HabitStat[] = habits.map((h) => {
      const habit: HabitLike = { cadence: h.cadence, target_per_period: h.target_per_period, weekdays: h.weekdays };
      const dates = logsByHabit.get(h.id) ?? [];
      return {
        // Every member writes habit titles, and one member's title reaches the
        // coaching another reads: household text, fenced (and capped) as data.
        title: fenceUntrusted('habit', h.title),
        cadence: h.cadence,
        currentStreak: currentStreak(habit, dates, today),
        longestStreak: longestStreak(habit, dates),
        completionRate: completionRate(habit, dates, today, 30),
        doneToday: isDoneToday(dates, today),
      };
    });

    const firstName = ctx.active.member?.display_name?.split(' ')[0] ?? 'there';
    const { system, user } = buildCoachPrompt(stats, firstName);
    const coaching = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'habits.coach', text: 'Habit coaching' },
      async (obs) => {
        const provider = await resolveProvider();
        const done = await provider.complete({
          system: `${system}\n\n${UNTRUSTED_CONTENT_RULE}`,
          messages: [{ role: 'user', content: user }],
          tools: [],
          maxTokens: 600,
        });
        obs.used(done.model ?? 'unknown', done.usage);
        const parsed = parseCoachResponse(done.text || '');
        if (!parsed.headline && parsed.nudges.length === 0) {
          obs.failed(new Error('The model returned no usable headline or nudges.'));
          return null;
        }
        return parsed;
      },
    );

    if (!coaching) {
      return NextResponse.json({ error: t('habits.couldNotGenerateCoachingRight') }, { status: 502 });
    }

    return NextResponse.json({ coaching });
  } catch (err) {
    console.error('Habit coach error:', err);
    return NextResponse.json({ error: t('habits.failedToGenerateCoaching') }, { status: 500 });
  }
}
