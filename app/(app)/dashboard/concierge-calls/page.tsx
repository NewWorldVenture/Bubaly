import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { getTranslations } from '@/lib/i18n/server';
import { ErrorState } from '@/components/ui/states';
import { ConciergeCallsModule } from '@/components/modules/concierge-calls-module';
import type { Tables } from '@/lib/database.types';

export const metadata: Metadata = { title: 'AI Calls' };
export const dynamic = 'force-dynamic';

/** Outbound concierge calls: the family writes the request, Bubaly writes the
 *  call plan, and the row carries what is actually known about the call. Any
 *  family member can see the queue; the module shows the brief, the persisted
 *  state and the outcome. */
export default async function ConciergeCallsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const { data, error } = await supabase
    .from('concierge_calls')
    .select('*')
    .eq('family_id', ctx.active.familyId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    // Fail closed: an empty queue after a failed read would tell a parent
    // nothing is waiting when something might be.
    console.error('[dashboard/concierge-calls] calls read failed', error);
    return <ErrorState message={t('conciergeCalls.couldNotLoadYourCallRequests')} />;
  }

  return (
    <ConciergeCallsModule
      familyId={ctx.active.familyId}
      initialCalls={(data ?? []) as Tables<'concierge_calls'>[]}
    />
  );
}
