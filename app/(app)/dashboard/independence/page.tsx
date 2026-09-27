import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { ErrorState } from '@/components/ui/states';
import { IndependenceModule } from '@/components/modules/independence-module';
import type { Tables } from '@/lib/database.types';
import { getTranslations } from '@/lib/i18n/server';
import { isMissingRelationError } from '@/lib/supabase/errors';

export const metadata: Metadata = { title: 'Independence' };
export const dynamic = 'force-dynamic';

/** Age-banded growth ladder: responsibilities that grow as kids mature. */
export default async function IndependencePage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const { data: members, error: membersError } = await supabase.from('family_members')
    .select('id, display_name, role, birthday, color')
    .eq('family_id', ctx.active.familyId).eq('is_active', true)
    .in('role', ['child', 'teen']);

  // With no kids the module renders "Add a child or teen to the family to start
  // their independence ladder." A failed read reaches that same branch, so a
  // parent with three children is told they have none and every milestone they
  // have recorded disappears with them.
  if (membersError) {
    return (
      <div className="module-page">
        <PageHeader title={t('independence.independence')} description={t('independenceModule.responsibilitiesThatGrowAsYour')} />
        <ErrorState message={t('independence.couldNotLoadYourFamily')} />
      </div>
    );
  }

  // Degrades safely before migration 0175 is applied — but ONLY for that.
  //
  // The `try/catch` here described a guard that was not there. A supabase-js
  // query RESOLVES with `{ data, error }` for anything the database answers,
  // including a refused read; it rejects only when the request never completed
  // (DNS, TCP, TLS, an aborted fetch — see lib/supabase/settle.ts). So the catch
  // never saw an RLS refusal or a query error, and `data ?? []` turned one into
  // an empty ladder.
  //
  // That is worse here than on a plain list page, for two reasons. First, the
  // `members` read immediately above IS guarded, with a comment describing this
  // exact hazard — so the roster renders correctly beside a ladder that has
  // silently emptied, which reads as "this child has achieved nothing" rather
  // than as a failure. Second, it is DESTRUCTIVE: the parent's natural response
  // is to tap Start on a rung, and `startMilestoneAction` upserts
  // `status: 'in_progress'` on `(family_id, member_id, domain, title)` with no
  // read of its own — so a milestone the child had already ACHIEVED is silently
  // reverted to in-progress, one tap at a time.
  //
  // A genuinely missing relation still degrades, because that is what the
  // original comment was for. Anything else fails closed, matching the sibling
  // read's own convention on this page. Audit C1-S9-27.
  let rows: Tables<'independence_milestones'>[] = [];
  const milestones = await supabase.from('independence_milestones').select('*')
    .eq('family_id', ctx.active.familyId).order('created_at', { ascending: false }).limit(1000);
  if (milestones.error && !isMissingRelationError(milestones.error)) {
    return (
      <div className="module-page">
        <PageHeader title={t('independence.independence')} description={t('independenceModule.responsibilitiesThatGrowAsYour')} />
        <ErrorState message={t('independence.couldNotLoadYourFamily')} />
      </div>
    );
  }
  rows = (milestones.data ?? []) as Tables<'independence_milestones'>[];

  return (
    <IndependenceModule
      kids={(members ?? []) as { id: string; display_name: string; role: string; birthday: string | null; color: string | null }[]}
      rows={rows}
    />
  );
}
