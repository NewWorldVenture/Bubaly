import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';
import {
  selectAbandonedOnboarding, selectAbandonedDemoLeads,
  type OnboardingJourney, type DemoLead,
} from '@/lib/marketing/journey-recovery';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

export const runtime = 'nodejs';

// Abandoned-journey recovery beyond checkout. Sweeps the OTHER first-run
// journeys that stalled and fires their follow-up workflow:
//   • onboarding started but never finished  → `onboarding_abandoned`
//   • demo tried but never became a customer → `demo_abandoned`
// Enrollment is deduped per subject (the automation engine's unique
// (workflow_id, subject_key) index), and each record is only eligible inside a
// bounded [grace, maxAge] window, so a journey is re-swept a few times at most
// before it ages out — no schema change / marker column needed. If no workflow
// is active for a trigger, firing is a cheap no-op. Runs a few times a day.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('journeyRecovery.unauthorized') }, { status: 401 });
  }

  const supabase = createServiceClient();
  const now = Date.now();
  let onboardingFired = 0;
  let demoFired = 0;
  let failed = 0;

  // ── Abandoned onboarding ──────────────────────────────────────────────────
  try {
    const { data, error } = await supabase
      .from('onboarding_progress')
      .select('user_id, status, completed_at, reset_at, created_at, updated_at')
      .eq('status', 'in_progress')
      .limit(2000);
    if (error) throw error;
    const stalled = selectAbandonedOnboarding((data ?? []) as OnboardingJourney[], now);
    for (const r of stalled) {
      // The contact's email lives on their profile — resolve best-effort.
      const { data: profile, error: profileError } = await supabase.from('profiles').select('email').eq('id', r.user_id).maybeSingle();
      if (profileError) {
        console.error(`onboarding profile read failed for ${r.user_id}:`, profileError);
        failed++;
        continue;
      }
      const email = profile?.email ?? null;
      if (!email) continue;
      try {
        await fireAutomationEvent(supabase, {
          trigger: 'onboarding_abandoned',
          email,
          subjectKey: eventSubjectKey('onboarding_abandoned', [r.user_id]),
          context: { userId: r.user_id },
        });
        onboardingFired += 1;
      } catch (e) { failed++; console.error(`onboarding_abandoned fire failed for ${r.user_id}:`, e); }
    }
  } catch (e) { failed++; console.error('journey-recovery: onboarding sweep failed', e); }

  // ── Abandoned demo leads ──────────────────────────────────────────────────
  try {
    const { data, error } = await supabase
      .from('crm_contacts')
      .select('email, lead_source, lifecycle_stage, created_at')
      .eq('lead_source', 'demo')
      .neq('lifecycle_stage', 'customer')
      .limit(2000);
    if (error) throw error;
    const stalled = selectAbandonedDemoLeads((data ?? []) as DemoLead[], now);
    for (const l of stalled) {
      try {
        await fireAutomationEvent(supabase, {
          trigger: 'demo_abandoned',
          email: l.email!,
          subjectKey: eventSubjectKey('demo_abandoned', [l.email]),
          context: { source: 'demo' },
        });
        demoFired += 1;
      } catch (e) { failed++; console.error(`demo_abandoned fire failed for ${l.email}:`, e); }
    }
  } catch (e) { failed++; console.error('journey-recovery: demo sweep failed', e); }

  return NextResponse.json({ onboardingFired, demoFired, failed }, { status: failed === 0 ? 200 : 502 });
}
