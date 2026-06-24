import { NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { resolveProvider } from '@/lib/ai/provider';
import { buildCoachPrompt, parseCoachResponse, type HabitStat } from '@/lib/habits/ai';
import {
  currentStreak, longestStreak, completionRate, isDoneToday, toISODate, type HabitLike,
} from '@/lib/habits/streaks';

// AI Life Coach for the Habit Tracker: reads the family's active habits + the
// last 90 days of check-ins, computes streak stats, and asks the configured AI
// provider for encouragement + concrete nudges. Auth-gated to the active family.
export async function POST() {
  try {
    const ctx = await requireUserContext();
    const { familyId } = ctx.active;
    const supabase = await createServer();
    const today = toISODate(new Date());
    const since = toISODate(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));

    const [{ data: habits }, { data: logs }] = await Promise.all([
      supabase
        .from('habits')
        .select('id, title, cadence, target_per_period, weekdays')
        .eq('family_id', familyId)
        .eq('is_active', true)
        .limit(50),
      supabase
        .from('habit_logs')
        .select('habit_id, log_date')
        .eq('family_id', familyId)
        .gte('log_date', since)
        .limit(5000),
    ]);

    if (!habits || habits.length === 0) {
      return NextResponse.json({ error: 'Add a habit first, then I can coach you.' }, { status: 400 });
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
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const coaching = parseCoachResponse(completion.text || '');
    if (!coaching.headline && coaching.nudges.length === 0) {
      return NextResponse.json({ error: 'Could not generate coaching right now. Please try again.' }, { status: 502 });
    }

    return NextResponse.json({ coaching });
  } catch (err) {
    console.error('Habit coach error:', err);
    return NextResponse.json({ error: 'Failed to generate coaching' }, { status: 500 });
  }
}
