import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isMissingRelationError } from '@/lib/supabase/errors';
import { PageHeader } from '@/components/app/page-header';
import { ErrorState } from '@/components/ui/states';
import { IndependenceModule } from '@/components/modules/independence-module';
import type { Tables } from '@/lib/database.types';
import { getTranslations } from '@/lib/i18n/server';

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

  // Degrades safely before migration 0175 is applied — and ONLY then. The
  // try/catch this replaced could never fire: PostgREST resolves with
  // { data, error } rather than throwing, so every failed read (a timeout, a
  // policy error) rendered as a family with no milestones at all. A missing
  // table is the one error that genuinely means "nothing here yet".
  const { data, error } = await supabase.from('independence_milestones').select('*')
    .eq('family_id', ctx.active.familyId).order('created_at', { ascending: false }).limit(1000);
  if (error && !isMissingRelationError(error)) {
    return (
      <div className="module-page">
        <PageHeader title={t('independence.independence')} description={t('independenceModule.responsibilitiesThatGrowAsYour')} />
        <ErrorState message={t('independence.couldNotLoadYourFamily')} />
      </div>
    );
  }
  const rows = (data ?? []) as Tables<'independence_milestones'>[];

  return (
    <IndependenceModule
      kids={(members ?? []) as { id: string; display_name: string; role: string; birthday: string | null; color: string | null }[]}
      rows={rows}
    />
  );
}
