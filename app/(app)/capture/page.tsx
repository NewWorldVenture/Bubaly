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
  // quick-jump buttons by default (locked features are never shown), and load
  // the user's saved customization (synced across devices via user_preferences).
  const [{ data: sub }, { data: prefs }] = await Promise.all([
    supabase.from('subscriptions').select('plan, status')
      .eq('family_id', ctx.active.familyId).in('status', ['active', 'trialing']).maybeSingle(),
    supabase.from('user_preferences').select('ui_prefs').eq('user_id', ctx.user.id).maybeSingle(),
  ]);

  const level = planLevel(sub?.plan ?? null);
  const ui = (prefs?.ui_prefs && typeof prefs.ui_prefs === 'object' ? prefs.ui_prefs : {}) as Record<string, unknown>;
  const saved = Array.isArray(ui.captureQuickRoutes)
    ? (ui.captureQuickRoutes as unknown[]).filter((k): k is string => typeof k === 'string')
    : null;

  return <CaptureShell planLevel={level} savedRouteKeys={saved} familyId={ctx.active.familyId} userId={ctx.user.id} />;
}
