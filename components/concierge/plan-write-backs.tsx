'use client';

// Concierge deeper write-back — one-tap "materialize this plan" into real records
// across surfaces (calendar · reminder · prep task). Each apply goes through the
// server action (which writes the record + logs concierge_plan_actions), so it's
// idempotent and shows what's already been done.

import { useEffect, useState, useTransition } from 'react';
import { CalendarPlus, BellPlus, ListPlus, Check, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { planWriteBacks, type WriteBackKind, type PlanForApply } from '@/lib/concierge/apply';
import { applyConciergePlanAction } from '@/app/(app)/dashboard/concierge/actions';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

const ICON: Record<WriteBackKind, React.ComponentType<{ className?: string }>> = {
  calendar: CalendarPlus, reminder: BellPlus, task: ListPlus,
};

export function PlanWriteBacks({ planId, plan }: { planId: string; plan: PlanForApply }) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [applied, setApplied] = useState<Set<WriteBackKind>>(new Set());
  const [busy, setBusy] = useState<WriteBackKind | null>(null);
  const [, startTransition] = useTransition();

  // Load what's already been materialized for this plan.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const sb = createClient();
        const { data } = await sb.from('concierge_plan_actions').select('action_kind').eq('plan_id', planId);
        if (active && data) setApplied(new Set(data.map((r) => r.action_kind as WriteBackKind)));
      } catch { /* table not applied yet → no applied state */ }
    })();
    return () => { active = false; };
  }, [planId]);

  const options = planWriteBacks(plan);

  const apply = (kind: WriteBackKind) => {
    setBusy(kind);
    startTransition(async () => {
      const res = await applyConciergePlanAction(planId, [kind]);
      setBusy(null);
      if (!res.ok) { toastError(res.error); return; }
      if (res.applied.length) {
        setApplied((prev) => new Set(prev).add(kind));
        success(kind === 'calendar' ? 'Added to your calendar' : kind === 'reminder' ? 'Reminder set' : 'Prep task added');
      } else {
        setApplied((prev) => new Set(prev).add(kind)); // already applied
      }
    });
  };

  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{t('planWriteBacks.makeItHappen')}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const Icon = ICON[o.kind];
          const done = applied.has(o.kind);
          const disabled = !o.available || done || busy === o.kind;
          return (
            <button
              key={o.kind}
              type="button"
              onClick={() => apply(o.kind)}
              disabled={disabled}
              title={o.available ? undefined : o.reason}
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold transition',
                done ? 'text-green-400'
                  : o.available ? 'bg-brand/10 text-brand-text hover:bg-brand/20'
                  : 'cursor-not-allowed text-muted/50',
              )}
            >
              {busy === o.kind ? <Loader2 className="h-3 w-3 animate-spin" />
                : done ? <Check className="h-3 w-3" />
                : <Icon className="h-3 w-3" />}
              {done ? (o.kind === 'calendar' ? 'On calendar' : o.kind === 'reminder' ? 'Reminder set' : 'Task added') : o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
