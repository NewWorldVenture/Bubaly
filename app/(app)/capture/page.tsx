import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { planLevel } from '@/lib/constants/plans';
import { CaptureShell } from '@/components/capture/capture-shell';

export const metadata: Metadata = { title: 'Capture' };

export default async function CapturePage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  // Resolve the family's plan level so Capture only offers tier-accessible
  // quick-jump buttons by default (locked features are never shown).
  const { data: sub } = await supabase
    .from('subscriptions')
    .select('plan, status')
    .eq('family_id', ctx.active.familyId)
    .in('status', ['active', 'trialing'])
    .maybeSingle();
  const level = planLevel(sub?.plan ?? null);

  return <CaptureShell planLevel={level} />;
}
