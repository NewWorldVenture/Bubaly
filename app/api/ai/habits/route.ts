import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { readAll } from '@/lib/supabase/read-all';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { requireUserContext } from '@/lib/supabase/auth';
import { resolveProvider } from '@/lib/ai/provider';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { buildCoachPrompt, parseCoachResponse, type HabitStat } from '@/lib/habits/ai';
import {
  currentStreak, longestStreak, completionRate, isDoneToday, toISODate, type HabitLike,
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
    const limited = await enforceAIRateLimit(supabase, `ai-habits:${ctx.user.id}`, { limit: 15 });
    if (!limited.ok) return NextResponse.json(
      { error: t('habits.tooManyHabitCoachRequests') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
    const today = toISODate(new Date());
    const since = toISODate(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));

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
      readAll<{ habit_id: string; log_date: string }>((from, to) => supabase
        .from('habit_logs')
        .select('habit_id, log_date')
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

    const logsByHabit = new Map<string, string[]>();
    for (const l of logs ?? []) {
      const arr = logsByHabit.get(l.habit_id) ?? [];
      arr.push(l.log_date);
      logsByHabit.set(l.habit_id, arr);
    }

    const stats: HabitStat[] = habits.map((h) => {
      const habit: HabitLike = { cadence: h.cadence, target_per_period: h.target_per_period, weekdays: h.weekdays };
      const dates = logsByHabit.get(h.id) ?? [];
      return {
        title: h.title,
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
          system,
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
