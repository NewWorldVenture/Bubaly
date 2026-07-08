import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { OutcomesLauncher, type OutcomePlan } from '@/components/modules/outcomes-launcher';
import { ActivationBeacon } from '@/components/analytics/activation-beacon';
import {
  OUTCOMES, buildOutcomePlan, outcomeUrgencyCount, type OutcomeContext,
} from '@/lib/outcomes/launcher';
import { nextBirthdayDate, daysUntil } from '@/lib/moments/birthdays';
import { loadFamilyContext } from '@/lib/reasoning/context';
import { reasoningInsights } from '@/lib/reasoning/insights';
import { RelationshipInsights } from '@/components/reasoning/relationship-insights';

export const metadata: Metadata = { title: 'Outcomes | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function OutcomesPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const dayStart = `${todayKey}T00:00:00Z`;
  const dayEnd = `${new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`;

  // Real, focused snapshot — all family-scoped, count-only where possible.
  const [eventsRes, overdueRes, groceryRes, membersRes] = await Promise.all([
    supabase.from('calendar_events').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).gte('starts_at', dayStart).lt('starts_at', dayEnd),
    supabase.from('todo_items').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('is_done', false).lt('due_date', todayKey),
    supabase.from('grocery_items').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('is_checked', false),
    supabase.from('family_members').select('birthday').eq('family_id', familyId),
  ]);

  const birthdaysSoon = (membersRes.data ?? []).filter((m) => {
    if (!m.birthday) return false;
    const next = nextBirthdayDate(m.birthday, now);
    if (!next) return false;
    const d = daysUntil(next, now);
    return d >= 0 && d <= 14;
  }).length;

  const context: OutcomeContext = {
    eventsToday: eventsRes.count ?? 0,
    overdueTasks: overdueRes.count ?? 0,
    openGrocery: groceryRes.count ?? 0,
    birthdaysSoon,
  };

  const plans: OutcomePlan[] = OUTCOMES.map((outcome) => ({
    outcome,
    steps: buildOutcomePlan(outcome.id, context),
    urgency: outcomeUrgencyCount(outcome.id, context),
  }));

  // R2: surface Knowledge Graph relationship reasoning alongside the outcomes.
  const reasoning = await loadFamilyContext(supabase, familyId, now).catch(() => null);
  const insights = reasoning ? reasoningInsights(reasoning) : [];

  return (
    <>
      <ActivationBeacon milestone="first_outcome_viewed" familyId={familyId} userId={ctx.user.id} signupAtIso={ctx.active.family.created_at} />
      {insights.length > 0 && (
        <div className="mx-auto mb-4 max-w-5xl px-4 pt-2">
          <RelationshipInsights insights={insights} />
        </div>
      )}
      <OutcomesLauncher plans={plans} />
    </>
  );
}
