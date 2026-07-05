// lib/playbook/server.ts — gathers the real behavior signals the Playbook learns
// from, runs the pure engine, and hides insights the family has already saved.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { learnPlaybook, filterAlreadyKnown, type PlaybookInsight, type PlaybookSignals } from './learn';

type DB = SupabaseClient<Database>;

const DAY_MS = 86_400_000;

/** Load learned, not-yet-saved playbook insights for a family. */
export async function loadPlaybookInsights(supabase: DB, familyId: string, now: Date = new Date()): Promise<PlaybookInsight[]> {
  const since90 = new Date(now.getTime() - 90 * DAY_MS).toISOString();
  const since90date = since90.slice(0, 10);

  const [mealsRes, groceryRes, routinesRes, factsRes] = await Promise.all([
    supabase.from('meal_plans').select('meals(name)').eq('family_id', familyId).eq('meal_type', 'dinner').gte('plan_date', since90date).limit(500),
    supabase.from('grocery_items').select('created_at').eq('family_id', familyId).gte('created_at', since90).limit(1000),
    supabase.from('family_routines').select('title, days_of_week').eq('family_id', familyId).eq('status', 'active').limit(100),
    supabase.from('family_facts').select('label, value').eq('family_id', familyId).limit(1000),
  ]);

  const dinners = (mealsRes.data ?? [])
    .map((r) => (r.meals as { name?: string } | null)?.name)
    .filter((n): n is string => Boolean(n));
  const groceryDays = (groceryRes.data ?? [])
    .map((g) => new Date(g.created_at).getDay())
    .filter((d) => !Number.isNaN(d));
  const routines = (routinesRes.data ?? []).map((r) => ({ title: r.title, daysOfWeek: r.days_of_week ?? [] }));

  const signals: PlaybookSignals = { dinners, groceryDays, routines };
  const insights = learnPlaybook(signals);
  return filterAlreadyKnown(insights, factsRes.data ?? []);
}
