'use client';

// Super-admin inline plan control for the Admin → Users (families) table.
// Lets an admin comp a family or downgrade to Free without SQL. Calls the
// guarded, audited adminSetFamilyPlanAction and refreshes.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { adminSetFamilyPlanAction } from '@/app/(app)/admin/actions';
import { useToast } from '@/components/ui/toast';

const PLAN_OPTIONS: { id: string; label: string }[] = [
  { id: 'free', label: 'Free' },
  { id: 'basic', label: 'Family Basic' },
  { id: 'basic_annual', label: 'Family Basic (Annual)' },
  { id: 'plus', label: 'Family+' },
  { id: 'plus_annual', label: 'Family+ (Annual)' },
];

export function SetPlanControl({ familyId, familyName, currentPlan }: {
  familyId: string; familyName: string; currentPlan: string | null;
}) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const initial = currentPlan && PLAN_OPTIONS.some((p) => p.id === currentPlan) ? currentPlan : 'free';
  const [value, setValue] = useState(initial);
  const [pending, start] = useTransition();

  function change(plan: string) {
    if (plan === value || pending) return;
    const label = PLAN_OPTIONS.find((p) => p.id === plan)?.label ?? plan;
    if (!window.confirm(`Set ${familyName} to ${label}?`)) return;
    const prev = value;
    setValue(plan); // optimistic
    start(async () => {
      const res = await adminSetFamilyPlanAction({ familyId, plan });
      if (!res.ok) {
        setValue(prev);
        toastError(res.error ?? 'Could not update the plan.');
        return;
      }
      success(`${familyName} → ${label}`);
      router.refresh();
    });
  }

  return (
    <select
      aria-label={`Plan for ${familyName}`}
      value={value}
      onChange={(e) => change(e.target.value)}
      disabled={pending}
      className="rounded-lg border border-border bg-surface/60 px-2 py-1 text-xs focus:border-brand/50 focus:outline-none disabled:opacity-50"
    >
      {PLAN_OPTIONS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
    </select>
  );
}
