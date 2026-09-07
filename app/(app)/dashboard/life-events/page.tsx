import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { LifeEventsModule } from '@/components/modules/life-events-module';
import { detectLifeEvents, SCHOOL_START_WINDOW_DAYS, type LifeEventSuggestion } from '@/lib/life-events/detect';

export const metadata: Metadata = { title: 'Life & Milestones | Bubaly' };
export const dynamic = 'force-dynamic';

/** School events whose title reads like the start of a term or a school year. */
const TERM_START_RE = /\b(term|semester|school year|first day|back[- ]to[- ]school|start of school|orientation)\b/i;

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * M34: the "Coming up" proposals are computed on the SERVER so the read
 * boundary is honest — a failed read hands the module `unavailable` and it
 * renders a retryable error, rather than an empty section that reads as
 * "nothing is coming up".
 */
export default async function LifeEventsPage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  const now = new Date();
  const todayKey = dayKey(now);
  const termHorizon = dayKey(new Date(now.getTime() + SCHOOL_START_WINDOW_DAYS * 86_400_000));
  const petSince = dayKey(new Date(now.getTime() - 8 * 86_400_000));

  const [termsRes, petsRes, projectsRes, factsRes, plansRes] = await Promise.all([
    supabase.from('school_events').select('title, starts_at').eq('family_id', familyId)
      .gte('starts_at', `${todayKey}T00:00:00Z`).lte('starts_at', `${termHorizon}T23:59:59Z`).limit(50),
    supabase.from('pets').select('name, created_at').eq('family_id', familyId)
      .gte('created_at', `${petSince}T00:00:00Z`).limit(20),
    supabase.from('home_projects').select('title, status').eq('family_id', familyId)
      .in('status', ['idea', 'planning', 'quoting']).limit(20),
    supabase.from('family_facts').select('label, value').eq('family_id', familyId).limit(100),
    // ACTIVE only. `activePlanKeys` suppresses a proposal, so a completed plan
    // in this set would silence the transition for good: a family who ran "The
    // Holidays" in 2026 and ticked it off would never be offered it again in
    // 2027, and the same for school_start and camp — the recurring transitions
    // this detector exists to catch. Completed and archived are both history.
    supabase.from('life_event_plans').select('template_key').eq('family_id', familyId).eq('status', 'active').limit(50),
  ]);

  const readError = termsRes.error ?? petsRes.error ?? projectsRes.error ?? factsRes.error ?? plansRes.error;
  let suggestions: LifeEventSuggestion[] = [];
  if (readError) {
    // Fail closed: never render "nothing is coming up" because a read broke.
    console.error('[dashboard/life-events] life-event signal read failed', readError);
  } else {
    suggestions = detectLifeEvents({
      todayKey,
      termStarts: (termsRes.data ?? [])
        .filter((e) => TERM_START_RE.test(e.title ?? ''))
        .map((e) => ({ label: e.title, startKey: String(e.starts_at).slice(0, 10) })),
      pets: (petsRes.data ?? []).map((p) => ({ name: p.name, createdKey: String(p.created_at).slice(0, 10) })),
      homeProjects: (projectsRes.data ?? []).map((p) => ({ title: p.title, status: p.status })),
      facts: (factsRes.data ?? []).map((f) => ({ label: f.label, value: f.value })),
      activePlanKeys: (plansRes.data ?? []).map((p) => p.template_key),
    });
  }

  return <LifeEventsModule suggestions={suggestions} suggestionsUnavailable={Boolean(readError)} />;
}
