import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { OutcomesLauncher, type OutcomePlan } from '@/components/modules/outcomes-launcher';
import { ActivationBeacon } from '@/components/analytics/activation-beacon';
import {
  OUTCOMES, buildOutcomePlan, outcomeUrgencyCount, outcomeFromParam, type OutcomeContext,
} from '@/lib/outcomes/launcher';
import { nextBirthdayDate, daysUntil } from '@/lib/moments/birthdays';
import { loadFamilyContext } from '@/lib/reasoning/context';
import { reasoningInsights } from '@/lib/reasoning/insights';
import { RelationshipInsights } from '@/components/reasoning/relationship-insights';
import { ErrorState } from '@/components/ui/states';
import { countFromResult, countMatchingResult } from '@/lib/outcomes/discovery';
import { dayKeyInTz, zonedDayBoundsMs } from '@/lib/services/scope';

export const metadata: Metadata = { title: 'Outcomes | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function OutcomesPage({ searchParams }: { searchParams?: Promise<{ outcome?: string }> } = {}) {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const selectedOutcome = outcomeFromParam((await searchParams)?.outcome);
  const supabase = await createServer();

  const now = new Date();
  const tz = ctx.active.family.timezone || 'UTC';
  const todayKey = dayKeyInTz(now, tz);
  const day = zonedDayBoundsMs(todayKey, tz);
  const dayStart = new Date(day.start).toISOString();
  const dayEnd = new Date(day.end).toISOString();

  // Real, focused snapshot — all family-scoped, count-only where possible.
  const [eventsRes, overdueRes, groceryRes, membersRes] = await settleAll([
    supabase.from('calendar_events').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).gte('starts_at', dayStart).lt('starts_at', dayEnd),
    supabase.from('todo_items').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('is_done', false).lt('due_date', todayKey),
    supabase.from('grocery_items').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('is_checked', false),
    supabase.from('family_members').select('birthday', { count: 'exact' }).eq('family_id', familyId).eq('is_active', true),
  ]);

  const birthdaysSoon = countMatchingResult(membersRes, (m) => {
    if (!m.birthday) return false;
    const next = nextBirthdayDate(m.birthday, now);
    if (!next) return false;
    const d = daysUntil(next, now);
    return d >= 0 && d <= 14;
  });

  const counts = { eventsToday: countFromResult(eventsRes), overdueTasks: countFromResult(overdueRes), openGrocery: countFromResult(groceryRes), birthdaysSoon };
  const countsUnavailable = Object.values(counts).some((count) => count === null);
  if (countsUnavailable) console.error('[dashboard/outcomes] outcome counts read failed or incomplete', { events: eventsRes.error, tasks: overdueRes.error, grocery: groceryRes.error, members: membersRes.error });

  const context: OutcomeContext = {
    eventsToday: counts.eventsToday ?? 0,
    overdueTasks: counts.overdueTasks ?? 0,
    openGrocery: counts.openGrocery ?? 0,
    birthdaysSoon: counts.birthdaysSoon ?? 0,
  };

  const plans: OutcomePlan[] = OUTCOMES.map((outcome) => ({
    outcome,
    steps: buildOutcomePlan(outcome.id, context),
    urgency: outcomeUrgencyCount(outcome.id, context),
  }));

  // R2: surface Knowledge Graph relationship reasoning alongside the outcomes.
  let reasoning: Awaited<ReturnType<typeof loadFamilyContext>> | null = null;
  let reasoningError = false;
  try {
    reasoning = await loadFamilyContext(supabase, familyId, now);
  } catch (error) {
    reasoningError = true;
    console.error('[dashboard/outcomes] reasoning context read failed', error);
  }
  const insights = reasoning ? reasoningInsights(reasoning) : [];

  return (
    <>
      {countsUnavailable && <p role="status" className="mx-auto mb-4 max-w-5xl px-4 text-sm text-muted">{t('outcomeDiscovery.unavailable')}{' '}<Link href="/dashboard/outcomes" className="underline">{t('outcomeDiscovery.refresh')}</Link></p>}
      {reasoningError && (
        <div className="mx-auto mb-4 max-w-5xl px-4 pt-2">
          <ErrorState message={t('outcomes.relationshipInsightsAreTemporarilyUnavailable')} />
        </div>
      )}
      <ActivationBeacon milestone="first_outcome_viewed" familyId={familyId} userId={ctx.user.id} signupAtIso={ctx.active.family.created_at} />
      {insights.length > 0 && (
        <div className="mx-auto mb-4 max-w-5xl px-4 pt-2">
          <RelationshipInsights insights={insights} />
        </div>
      )}
      <OutcomesLauncher key={selectedOutcome ?? 'default'} plans={plans} initialOutcomeId={selectedOutcome} />
    </>
  );
}
