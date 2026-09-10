'use client';

// "Complete your setup" — the re-onboarding surface for accounts that skipped the
// guided wizard (auto-provisioned) or explicitly reset. It re-runs ONLY the
// questionnaire against the EXISTING family (saveFamilyDetailsAction upserts
// family_onboarding — it never creates a second family), then feeds the marketing
// service exactly like the wizard does. A reset control routes power users back
// through it. Pure renderer over existing, tested server actions.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, RotateCcw, Plus, Minus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { FAMILY_GOALS, REFERRAL_SOURCES } from '@/lib/onboarding/family';
import { saveFamilyDetailsAction, resetOnboardingAction } from '@/app/onboarding/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

// Reuse the wizard's display vocabulary without changing stored option values.
const GOAL_COPY: Record<string, string> = {
  chores: 'ai.choresAllowance', calendar: 'onboardingCopy.goalCalendar', meals: 'pricingContent.mealPlanning',
  groceries: 'onboardingCopy.goalGroceries', budget: 'onboardingCopy.goalBudget', health: 'onboardingCopy.goalHealth',
  school: 'onboardingCopy.goalSchool', activities: 'onboardingCopy.goalActivities',
};
const REFERRAL_COPY: Record<string, string> = {
  search: 'onboardingCopy.referralSearch', friend_family: 'onboardingCopy.referralFriendFamily', social: 'onboardingCopy.referralSocial',
  app_store: 'onboardingCopy.referralAppStore', blog: 'onboardingCopy.referralBlog', ad: 'onboardingCopy.referralAd',
  podcast: 'onboardingCopy.referralPodcast', other: 'onboardingCopy.referralOther',
};

function Stepper({ label, value, onChange, min = 0, max = 20 }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number }) {
  const t = useTranslations();
  return (
    <div className="flex items-center justify-between rounded-xl border border-border bg-bg/40 px-3 py-2.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-center gap-3">
        <button type="button" aria-label={t('onboardingCopy.fewer', { label })} onClick={() => onChange(Math.max(min, value - 1))}
          className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted transition hover:bg-elevated disabled:opacity-40" disabled={value <= min}>
          <Minus className="h-4 w-4" />
        </button>
        <span className="w-5 text-center text-sm font-semibold tabular-nums">{value}</span>
        <button type="button" aria-label={t('onboardingCopy.more', { label })} onClick={() => onChange(Math.min(max, value + 1))}
          className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted transition hover:bg-elevated disabled:opacity-40" disabled={value >= max}>
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function CompleteSetupForm({
  familyId,
  initial,
}: {
  familyId: string;
  initial: { adults: number; children: number; childAges: number[]; goals: string[]; referralSource: string };
}) {
  const t = useTranslations();
  const router = useRouter();
  const { error: toastError, success } = useToast();
  const [adults, setAdults] = useState(Math.max(1, initial.adults || 1));
  const [children, setChildren] = useState(Math.max(0, initial.children || 0));
  const [childAges, setChildAges] = useState<number[]>(initial.childAges ?? []);
  const [goals, setGoals] = useState<string[]>(initial.goals ?? []);
  const [referral, setReferral] = useState(initial.referralSource ?? '');
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  const setKids = (n: number) => {
    setChildren(n);
    setChildAges((prev) => Array.from({ length: n }, (_, i) => prev[i] ?? 0));
  };
  const toggleGoal = (v: string) =>
    setGoals((g) => (g.includes(v) ? g.filter((x) => x !== v) : [...g, v]));

  async function save() {
    setSaving(true);
    const res = await saveFamilyDetailsAction({
      familyId,
      householdAdults: adults,
      householdChildren: children,
      childAges: childAges.filter((n) => n >= 1 && n <= 21),
      goals,
      referralSource: referral || undefined,
    });
    setSaving(false);
    if (!res.ok) { toastError(res.error ?? t('completeSetupCopy.saveError')); return; }
    success(t('completeSetup.setupSavedYourFamilyProfile'));
    router.push('/dashboard');
    router.refresh();
  }

  async function reset() {
    setResetting(true);
    const res = await resetOnboardingAction();
    setResetting(false);
    if (!res.ok) { toastError(res.error ?? t('completeSetupCopy.resetError')); return; }
    success(t('completeSetup.onboardingResetWalkThroughSetup'));
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Stepper label={t('completeSetup.adults')} value={adults} onChange={setAdults} min={1} />
        <Stepper label={t('completeSetup.kids')} value={children} onChange={setKids} />
      </div>
      <p className="-mt-3 text-center text-xs text-muted">{t(adults === 1 ? 'onboardingCopy.adultCountOne' : 'onboardingCopy.adultCountOther', { count: adults })}
        {children > 0 && <> · {t(children === 1 ? 'onboardingCopy.childCountOne' : 'onboardingCopy.childCountOther', { count: children })}</>}</p>

      {children > 0 && (
        <div>
          <span className="mb-2 block text-sm font-medium">{t('completeSetup.kidsAges')} <span className="font-normal text-muted">{t('conciergeCalls.optional')}</span></span>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: children }, (_, i) => (
              <input key={i} inputMode="numeric" placeholder={t('onboardingCopy.age')} aria-label={t('onboardingCopy.childAge', { number: i + 1 })}
                value={childAges[i] ? String(childAges[i]) : ''}
                onChange={(e) => {
                  const n = Math.min(21, Math.max(0, parseInt(e.target.value.replace(/\D/g, ''), 10) || 0));
                  setChildAges((prev) => { const next = [...prev]; next[i] = n; return next; });
                }}
                className="h-10 w-14 rounded-xl border border-border bg-bg text-center text-sm focus-ring" />
            ))}
          </div>
        </div>
      )}

      <div>
        <span className="mb-2 block text-sm font-medium">{t('onboardingCopy.whatDoYouWantHelpWith')} <span className="font-normal text-muted">{t('completeSetup.pickAny')}</span></span>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {FAMILY_GOALS.map((g) => {
            const on = goals.includes(g.value);
            return (
              <button key={g.value} type="button" onClick={() => toggleGoal(g.value)}
                className={cn('flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm transition',
                  on ? 'border-brand bg-brand/10 text-fg' : 'border-border bg-bg/40 text-muted hover:border-brand/40')}>
                <span className="text-base">{g.icon}</span>
                <span className="min-w-0 flex-1 font-medium">{t(GOAL_COPY[g.value])}</span>
                {on && <Check className="h-4 w-4 text-brand-text" />}
              </button>
            );
          })}
        </div>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium">{t('onboardingCopy.howDidYouHearAboutUs')} <span className="font-normal text-muted">{t('conciergeCalls.optional')}</span></span>
        <select value={referral} onChange={(e) => setReferral(e.target.value)}
          className="h-11 w-full rounded-xl border border-border bg-bg px-3 text-sm focus-ring">
          <option value="">{t('completeSetup.selectOne')}</option>
          {REFERRAL_SOURCES.map((r) => <option key={r.value} value={r.value}>{t(REFERRAL_COPY[r.value])}</option>)}
        </select>
      </label>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Button className="sm:flex-1" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {t('completeSetup.saveMySetup')}
        </Button>
        <Button variant="secondary" onClick={reset} disabled={resetting}>
          {resetting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
          {t('completeSetup.resetOnboarding')}
        </Button>
      </div>
    </div>
  );
}
