import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { createServer } from '@/lib/supabase/server';
import { PaperworkModule } from '@/components/modules/paperwork-module';
import type { Tables } from '@/lib/database.types';

export const metadata: Metadata = { title: 'Paperwork Inbox' };
export const dynamic = 'force-dynamic';

/**
 * Paperwork Inbox — one triage surface for the paper that floods families:
 * permission slips, school notices, medical forms, bills, flyers. AI-triaged on
 * capture; every extracted action materializes one-tap into a real calendar
 * event or reminder.
 */
export default async function PaperworkPage() {
  const ctx = await requireUserContext();
  await requireAal2(ctx, 'documents', '/dashboard/paperwork');
  const supabase = await createServer();

  // Degrades safely before migration 0169 (renders an empty inbox).
  let items: Tables<'paperwork_items'>[] = [];
  try {
    const { data } = await supabase
      .from('paperwork_items').select('*')
      .eq('family_id', ctx.active.familyId)
      .order('created_at', { ascending: false })
      .limit(500);
    items = (data ?? []) as Tables<'paperwork_items'>[];
  } catch { /* table not applied yet */ }

  return <PaperworkModule items={items} />;
}
