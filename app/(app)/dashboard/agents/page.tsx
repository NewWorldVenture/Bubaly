import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { AgentsModule } from '@/components/modules/agents-module';
import { runAllAgents, type AgentContext, type AgentItem } from '@/lib/agents/roster';
import { loadFamilyContext } from '@/lib/reasoning/context';
import { reasoningInsights } from '@/lib/reasoning/insights';
import { nextBirthdayDate, daysUntil } from '@/lib/moments/birthdays';
import type { Tables } from '@/lib/database.types';

export const metadata: Metadata = { title: 'Family Assistant | Bubaly' };
export const dynamic = 'force-dynamic';

const HOUR = 3_600_000;

/** Count-only query → number (0 on any error, so a missing table never breaks the page). */
async function count(q: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  const { count: n, error } = await q;
  return error ? 0 : (n ?? 0);
}

export default async function AgentsPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const now = new Date();
  const iso = now.toISOString();
  const todayKey = iso.slice(0, 10);
  const dayStart = `${todayKey}T00:00:00Z`;
  const weekEnd = new Date(now.getTime() + 7 * 86_400_000);
  const in14 = new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
  const in30 = new Date(now.getTime() + 30 * 86_400_000).toISOString();

  const [
    weekEvents, mealPlans, members, activityRows,
    openGrocery, billsDueSoon, subscriptions, overdueChores, expiringDocs, maintenanceDue,
    upcomingTrips, pendingApprovals, newMemories,
  ] = await Promise.all([
    supabase.from('calendar_events').select('id, title, starts_at, ends_at, all_day, assignee_id, category')
      .eq('family_id', familyId).gte('starts_at', dayStart).lte('starts_at', weekEnd.toISOString()).order('starts_at').limit(500),
    supabase.from('meal_plans').select('plan_date, meal_type').eq('family_id', familyId)
      .gte('plan_date', todayKey).lt('plan_date', weekEnd.toISOString().slice(0, 10)),
    supabase.from('family_members').select('birthday').eq('family_id', familyId),
    supabase.from('agent_activity').select('*').eq('family_id', familyId).eq('status', 'active').order('created_at', { ascending: false }).limit(200),
    count(supabase.from('grocery_items').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('is_checked', false)),
    count(supabase.from('bills').select('id', { count: 'exact', head: true }).eq('family_id', familyId).neq('status', 'paid').lte('due_date', in14)),
    count(supabase.from('subscriptions_tracked').select('id', { count: 'exact', head: true }).eq('family_id', familyId).in('status', ['active', 'trial'])),
    count(supabase.from('chore_assignments').select('id', { count: 'exact', head: true }).eq('family_id', familyId).in('status', ['todo', 'in_progress']).lt('due_at', iso)),
    count(supabase.from('documents').select('id', { count: 'exact', head: true }).eq('family_id', familyId).not('expires_at', 'is', null).gte('expires_at', iso).lte('expires_at', in30)),
    count(supabase.from('maintenance_tasks').select('id', { count: 'exact', head: true }).eq('family_id', familyId).lt('due_at', iso)),
    count(supabase.from('vacations').select('id', { count: 'exact', head: true }).eq('family_id', familyId).gte('start_date', todayKey)),
    count(supabase.from('approval_requests').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('status', 'pending')),
    count(supabase.from('family_photos').select('id', { count: 'exact', head: true }).eq('family_id', familyId).gte('created_at', new Date(now.getTime() - 14 * 86_400_000).toISOString())),
  ]);

  // Knowledge graph → relationship-level reasoning for the Chief of Staff, via the
  // ONE shared reasoning engine (R1 context + R2 insights) — the same one Calm folds
  // in. Best-effort: a missing graph yields no insights, never an error.
  const reasoning = await loadFamilyContext(supabase, familyId, now).catch(() => null);
  const graphItems: AgentItem[] = reasoning
    ? reasoningInsights(reasoning).map((i) => ({ title: i.title, detail: i.detail, href: i.href, severity: i.severity }))
    : [];

  const events = weekEvents.data ?? [];
  const eventsToday = events.filter((e) => e.starts_at.slice(0, 10) === todayKey).length;
  const unassignedEvents = events.filter((e) => !e.assignee_id).length;
  const upcomingAppointments = events.filter((e) => e.category === 'appointment').length;

  // Overlapping timed events (same window) → conflicts.
  const timed = events.filter((e) => !e.all_day);
  let conflicts = 0;
  for (let i = 0; i < timed.length; i++) {
    const aS = new Date(timed[i].starts_at).getTime();
    const aE = timed[i].ends_at ? new Date(timed[i].ends_at!).getTime() : aS + HOUR;
    for (let j = i + 1; j < timed.length; j++) {
      const bS = new Date(timed[j].starts_at).getTime();
      if (bS >= aE) break;
      const bE = timed[j].ends_at ? new Date(timed[j].ends_at!).getTime() : bS + HOUR;
      if (bS < aE && aS < bE) conflicts++;
    }
  }

  const plannedDinners = new Set((mealPlans.data ?? []).filter((m) => m.meal_type === 'dinner').map((m) => m.plan_date));
  const unplannedDinners = Array.from({ length: 7 }, (_, i) => new Date(now.getTime() + i * 86_400_000).toISOString().slice(0, 10))
    .filter((d) => !plannedDinners.has(d)).length;

  const birthdaysSoon = (members.data ?? []).filter((m) => {
    if (!m.birthday) return false;
    const next = nextBirthdayDate(m.birthday, now);
    return next ? daysUntil(next, now) >= 0 && daysUntil(next, now) <= 14 : false;
  }).length;

  const context: AgentContext = {
    eventsToday, conflicts, unassignedEvents, unplannedDinners, openGrocery,
    billsDueSoon, subscriptions, overdueChores, expiringDocs, maintenanceDue,
    homeworkDue: 0, medsDue: 0, upcomingAppointments, upcomingTrips, birthdaysSoon,
    newMemories, unreadMessages: 0, pendingApprovals,
  };

  const briefings = runAllAgents(context, graphItems);
  return <AgentsModule briefings={briefings} activity={(activityRows.data ?? []) as Tables<'agent_activity'>[]} />;
}
