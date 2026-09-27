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
    const [{ data: habits }, { rows: logs, error: logsError }] = await Promise.all([
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

    // A streak counted over a prefix of the log is a lower streak, stated as
    // a fact to someone who kept the habit. readAll reports the truncation;
    // discarding it is what turns that into coaching.
    if (logsError) {
      console.error('[ai/habits] habit-log read failed', logsError);
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
