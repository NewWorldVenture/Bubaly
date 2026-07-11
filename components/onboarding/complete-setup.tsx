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
import { FAMILY_GOALS, REFERRAL_SOURCES, householdSummary } from '@/lib/onboarding/family';
import { saveFamilyDetailsAction, resetOnboardingAction } from '@/app/onboarding/actions';

function Stepper({ label, value, onChange, min = 0, max = 20 }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-border bg-bg/40 px-3 py-2.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-center gap-3">
        <button type="button" aria-label={`Fewer ${label}`} onClick={() => onChange(Math.max(min, value - 1))}
          className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted transition hover:bg-elevated disabled:opacity-40" disabled={value <= min}>
          <Minus className="h-4 w-4" />
        </button>
        <span className="w-5 text-center text-sm font-semibold tabular-nums">{value}</span>
        <button type="button" aria-label={`More ${label}`} onClick={() => onChange(Math.min(max, value + 1))}
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
    if (!res.ok) { toastError(res.error ?? 'Could not save your setup'); return; }
    success('Setup saved — your family profile is complete.');
    router.push('/dashboard');
    router.refresh();
  }

  async function reset() {
    setResetting(true);
    const res = await resetOnboardingAction();
    setResetting(false);
    if (!res.ok) { toastError(res.error ?? 'Could not reset onboarding'); return; }
    success('Onboarding reset — walk through setup again below.');
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3">
        <Stepper label="Adults" value={adults} onChange={setAdults} min={1} />
        <Stepper label="Kids" value={children} onChange={setKids} />
      </div>
      <p className="-mt-3 text-center text-xs text-muted">{householdSummary(adults, children)}</p>

      {children > 0 && (
        <div>
          <span className="mb-2 block text-sm font-medium">Kids’ ages <span className="font-normal text-muted">(optional)</span></span>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: children }, (_, i) => (
              <input key={i} inputMode="numeric" placeholder="Age" aria-label={`Child ${i + 1} age`}
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
        <span className="mb-2 block text-sm font-medium">What do you want help with? <span className="font-normal text-muted">(pick any)</span></span>
        <div className="grid grid-cols-2 gap-2">
          {FAMILY_GOALS.map((g) => {
            const on = goals.includes(g.value);
            return (
              <button key={g.value} type="button" onClick={() => toggleGoal(g.value)}
                className={cn('flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm transition',
                  on ? 'border-brand bg-brand/10 text-fg' : 'border-border bg-bg/40 text-muted hover:border-brand/40')}>
                <span className="text-base">{g.icon}</span>
                <span className="flex-1 truncate font-medium">{g.label}</span>
                {on && <Check className="h-4 w-4 text-brand" />}
              </button>
            );
          })}
        </div>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium">How did you hear about us? <span className="font-normal text-muted">(optional)</span></span>
        <select value={referral} onChange={(e) => setReferral(e.target.value)}
          className="h-11 w-full rounded-xl border border-border bg-bg px-3 text-sm focus-ring">
          <option value="">Select one…</option>
          {REFERRAL_SOURCES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </label>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Button className="flex-1" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Save my setup
        </Button>
        <Button variant="secondary" onClick={reset} disabled={resetting}>
          {resetting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
          Reset onboarding
        </Button>
      </div>
    </div>
  );
}
