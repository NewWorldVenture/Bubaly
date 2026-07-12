import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { ConciergeCallsModule } from '@/components/modules/concierge-calls-module';
import type { Tables } from '@/lib/database.types';

export const metadata: Metadata = { title: 'AI Calls' };
export const dynamic = 'force-dynamic';

/** "Bubaly calls for you" — outbound AI concierge calls. Any family member can
 *  request a call; the module shows the AI brief, live status, and outcomes. */
export default async function ConciergeCallsPage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const { data } = await supabase
    .from('concierge_calls')
    .select('*')
    .eq('family_id', ctx.active.familyId)
    .order('created_at', { ascending: false })
    .limit(100);

  return (
    <ConciergeCallsModule
      familyId={ctx.active.familyId}
      initialCalls={(data ?? []) as Tables<'concierge_calls'>[]}
    />
  );
}
