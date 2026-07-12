import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { IndependenceModule } from '@/components/modules/independence-module';
import type { Tables } from '@/lib/database.types';

export const metadata: Metadata = { title: 'Independence' };
export const dynamic = 'force-dynamic';

/** Age-banded growth ladder: responsibilities that grow as kids mature. */
export default async function IndependencePage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const { data: members } = await supabase.from('family_members')
    .select('id, display_name, role, birthday, color')
    .eq('family_id', ctx.active.familyId).eq('is_active', true)
    .in('role', ['child', 'teen']);

  // Degrades safely before migration 0167 is applied.
  let rows: Tables<'independence_milestones'>[] = [];
  try {
    const { data } = await supabase.from('independence_milestones').select('*')
      .eq('family_id', ctx.active.familyId).order('created_at', { ascending: false }).limit(1000);
    rows = (data ?? []) as Tables<'independence_milestones'>[];
  } catch { /* table not applied yet */ }

  return (
    <IndependenceModule
      kids={(members ?? []) as { id: string; display_name: string; role: string; birthday: string | null; color: string | null }[]}
      rows={rows}
    />
  );
}
