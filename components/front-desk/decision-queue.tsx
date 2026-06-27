'use client';

// The Front Desk "Executive Dashboard": shows parents only what needs a decision
// today, with one-tap approval for routine actions. 100% Supabase-wired via the
// `autopilot_suggestions` table — the same store Family Autopilot writes to — so
// approving here executes the action and clears it everywhere. Reversible
// reminder execution mirrors the Autopilot module so the two stay consistent.
import { useMemo } from 'react';
import {
  ShieldCheck, AlertTriangle, Check, X, Sparkles, CircleDot,
  CalendarClock, FileClock, Cake, ShoppingCart, ListChecks, CalendarX,
  Wallet, HeartPulse, Pill, UtensilsCrossed,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { LoadingBlock } from '@/components/ui/states';
import { confidenceTier } from '@/lib/autopilot/engine';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';

type Suggestion = Tables<'autopilot_suggestions'>;

const KIND_ICON: Record<string, typeof CircleDot> = {
  document: FileClock, appointment: CalendarClock, chore: ListChecks,
  birthday: Cake, groceries: ShoppingCart, conflict: CalendarX,
  finance: Wallet, wellbeing: HeartPulse, medication: Pill, meal: UtensilsCrossed,
  insurance: ShieldCheck,
};
const iconFor = (kind: string) => KIND_ICON[kind] ?? CircleDot;

function startOfToday(): string {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString();
}

export function DecisionQueue() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const { data, loading, error, refresh } = useRealtimeQuery<Suggestion>({
    table: 'autopilot_suggestions',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('autopilot_suggestions').select('*').eq('family_id', familyId)
        .order('urgency', { ascending: false }).order('confidence', { ascending: false }),
  });

  const open = useMemo(() => data.filter((s) => s.status === 'open'), [data]);
  const decideItems = useMemo(
    () => open.filter((s) => ['auto', 'approve', 'ask'].includes(confidenceTier(s.confidence))),
    [open],
  );
  const todayStart = startOfToday();
  const handledToday = useMemo(
    () => data.filter((s) =>
      ['auto_executed', 'executed', 'approved'].includes(s.status) &&
      s.resolved_at != null && s.resolved_at >= todayStart),
    [data, todayStart],
  );

  async function resolve(s: Suggestion, status: 'approved' | 'executed' | 'dismissed') {
    const supabase = createClient();
    // Reversible execution for reminders the family approves (mirrors Autopilot).
    if ((status === 'approved' || status === 'executed') && s.action_type === 'create_reminder') {
      const payload = (s.payload ?? {}) as { title?: string; at?: string };
      await supabase.from('reminders').insert({
        family_id: familyId,
        title: payload.title ?? s.title,
        remind_at: payload.at ?? new Date().toISOString(),
        member_id: s.member_id,
        related_type: s.source_kind === 'appointments' ? 'appointment' : 'renewal',
        related_id: s.source_id,
        created_by: userId,
      });
      status = 'executed';
    }
    const { error: upErr } = await supabase.from('autopilot_suggestions')
      .update({ status, resolved_at: new Date().toISOString(), resolved_by: userId })
      .eq('id', s.id);
    if (upErr) return toastError(describeDbError(upErr));
    success(status === 'dismissed' ? 'Dismissed' : 'Done — Bubaly handled it');
    void refresh();
  }

  if (loading) return <LoadingBlock />;
  if (error) {
    return <p className="rounded-2xl border border-border bg-surface/40 p-6 text-sm text-muted">Couldn’t load your decision queue right now.</p>;
  }

  const urgent = decideItems.filter((s) => s.urgency === 3).length;

  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-5 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <ShieldCheck className="h-5 w-5 text-brand" /> What needs you today
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            Only the decisions that are actually yours to make — one tap each.
          </p>
        </div>
        {handledToday.length > 0 && (
          <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-400 sm:flex">
            <Sparkles className="h-3.5 w-3.5" /> {handledToday.length} handled today
          </span>
        )}
      </div>

      {decideItems.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] py-10 text-center">
          <ShieldCheck className="h-10 w-10 text-emerald-400/80" />
          <p className="mt-3 text-sm font-semibold">You’re all caught up</p>
          <p className="mt-1 max-w-sm text-xs text-muted">
            Nothing needs a decision right now. Your front desk is watching the inbound — calls, email,
            forms, and schedules — and will only surface what’s truly yours to decide.
          </p>
          {handledToday.length > 0 && (
            <p className="mt-3 text-xs font-medium text-emerald-400">
              Bubaly already handled {handledToday.length} thing{handledToday.length === 1 ? '' : 's'} for you today.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {urgent > 0 && (
            <p className="flex items-center gap-1.5 text-xs font-semibold text-rose-400">
              <AlertTriangle className="h-3.5 w-3.5" /> {urgent} urgent
            </p>
          )}
          {decideItems.map((s) => {
            const Icon = iconFor(s.kind);
            const isUrgent = s.urgency === 3;
            return (
              <div key={s.id}
                className={cn('flex items-center gap-3 rounded-xl border px-4 py-3',
                  isUrgent ? 'border-rose-500/30 bg-rose-500/[0.05]' : 'border-border bg-surface/30')}>
                <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg',
                  isUrgent ? 'bg-rose-500/15 text-rose-400' : 'bg-brand/10 text-brand')}>
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{s.title}</p>
                  {s.detail && <p className="truncate text-xs text-muted">{s.detail}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button onClick={() => resolve(s, 'approved')}
                    className="flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-brand/90">
                    <Check className="h-3.5 w-3.5" /> {s.action_label ?? 'Do it'}
                  </button>
                  <button onClick={() => resolve(s, 'dismissed')} aria-label="Dismiss"
                    className="rounded-lg p-1.5 text-muted transition hover:bg-elevated hover:text-rose-400">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
