import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, Circle, Sparkles } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { SectionCard, ScoreRing } from '@/components/family/shell';
import { resolveCompleteness } from '@/lib/server/onboarding-progress';
import { CompleteSetupForm } from '@/components/onboarding/complete-setup';

export const metadata: Metadata = { title: 'Complete your setup' };
export const dynamic = 'force-dynamic';

/**
 * The re-onboarding / "finish setting up" surface. Every signed-in account has a
 * family (auto-provisioned if they skipped the wizard), so this ALWAYS renders —
 * showing a live completeness score, the concrete pieces still to do, and the
 * questionnaire so the auto-provisioned / reset cohort can finish. Writes go
 * through the existing, tested saveFamilyDetailsAction (upserts family_onboarding
 * for the CURRENT family — never creates a second one).
 */
export default async function CompleteSetupPage() {
  const ctx = await requireUserContext();
  const admin = createServiceClient();
  const familyId = ctx.active.familyId;

  const { result, progress } = await resolveCompleteness(admin, ctx.user.id, familyId);

  // Pre-fill the questionnaire from any existing family_onboarding row.
  let initial = { adults: 1, children: 0, childAges: [] as number[], goals: [] as string[], referralSource: '' };
  const { data: fo } = await admin
    .from('family_onboarding')
    .select('household_adults, household_children, child_ages, goals, referral_source')
    .eq('family_id', familyId)
    .maybeSingle();
  if (fo) {
    initial = {
      adults: fo.household_adults ?? 1,
      children: fo.household_children ?? 0,
      childAges: Array.isArray(fo.child_ages) ? fo.child_ages : [],
      goals: Array.isArray(fo.goals) ? fo.goals : [],
      referralSource: fo.referral_source ?? '',
    };
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={result.headline}
        description="Finish a few details so Bubaly fits how your family runs — and unlock the full experience."
      />

      <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
        <div className="space-y-5">
          <SectionCard title="Setup progress">
            <div className="flex flex-col items-center gap-4">
              <ScoreRing pct={result.score} label={result.isComplete ? 'Complete' : 'Set up'} />
              <p className="text-center text-xs text-muted">
                {result.isComplete
                  ? 'Your family profile is complete. Nice work!'
                  : progress?.source === 'auto_provision'
                    ? 'You skipped guided setup when you signed up — finish it here.'
                    : 'A few quick things and you’re fully set up.'}
              </p>
            </div>
          </SectionCard>

          <SectionCard title="What’s left">
            {result.missing.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" /> Nothing left — you’re all set.
              </p>
            ) : (
              <ul className="space-y-2">
                {result.missing.map((m) => (
                  <li key={m.key}>
                    <Link href={m.href}
                      className="flex items-center gap-2.5 rounded-xl border border-border bg-bg/40 px-3 py-2.5 text-sm transition hover:border-brand/40">
                      <Circle className="h-4 w-4 shrink-0 text-muted" />
                      <span className="flex-1 font-medium">{m.label}</span>
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>

        <SectionCard
          title="About your family"
          description="Tell us your household makeup and what you want help with. This tailors your dashboard and never creates a second family."
        >
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-brand/30 bg-brand/5 px-3 py-2.5 text-xs text-muted">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-brand-text" />
            <span>Saved to your existing family — <span className="font-medium text-fg">{ctx.active.family.name}</span>.</span>
          </div>
          <CompleteSetupForm familyId={familyId} initial={initial} />
        </SectionCard>
      </div>
    </div>
  );
}
