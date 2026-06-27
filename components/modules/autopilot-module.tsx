'use client';

// Family Autopilot — "Mission Control". On open it runs a scan that predicts
// what the family needs, auto-handles the high-confidence items, and surfaces
// the rest for one-tap approval or awareness. 100% Supabase-wired via the
// `autopilot_suggestions` table; the prediction logic lives in lib/autopilot.
import { useEffect, useMemo, useState } from 'react';
import {
  Rocket, ShieldCheck, AlertTriangle, Sparkles, Check, X, RefreshCw, Gauge,
  CalendarClock, FileClock, Cake, ShoppingCart, ListChecks, CircleDot,
  CalendarX, Wallet, HeartPulse, Pill, UtensilsCrossed, ShieldCheck as ShieldIcon,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { SkeletonList, EmptyState, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { successProbability, confidenceTier } from '@/lib/autopilot/engine';

type Suggestion = Tables<'autopilot_suggestions'>;

const KIND_ICON: Record<string, typeof Rocket> = {
  document: FileClock, appointment: CalendarClock, chore: ListChecks,
  birthday: Cake, groceries: ShoppingCart, conflict: CalendarX,
  finance: Wallet, wellbeing: HeartPulse, medication: Pill, meal: UtensilsCrossed,
  insurance: ShieldIcon,
};

function iconFor(kind: string) {
  return KIND_ICON[kind] ?? CircleDot;
}

export function AutopilotModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const [scanning, setScanning] = useState(false);
  const [scannedOnce, setScannedOnce] = useState(false);

  const { data, loading, error, refresh } = useRealtimeQuery<Suggestion>({
    table: 'autopilot_suggestions',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('autopilot_suggestions').select('*').eq('family_id', familyId)
        .order('urgency', { ascending: false }).order('confidence', { ascending: false }),
  });

  async function runScan() {
    setScanning(true);
    try {
      const res = await fetch('/api/autopilot/scan', { method: 'POST' });
      const json = (await res.json()) as { autoExecuted?: number; error?: string };
      if (!res.ok) throw new Error(json.error || 'Scan failed');
      if (json.autoExecuted && json.autoExecuted > 0) success(`Autopilot handled ${json.autoExecuted} thing${json.autoExecuted === 1 ? '' : 's'} for you`);
      void refresh();
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  }

  // Auto-scan once when the screen opens.
  useEffect(() => {
    if (!scannedOnce && familyId) {
      setScannedOnce(true);
      void runScan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [familyId, scannedOnce]);

  const open = useMemo(() => data.filter((s) => s.status === 'open'), [data]);
  const handled = useMemo(() => data.filter((s) => s.status === 'auto_executed' || s.status === 'executed' || s.status === 'approved'), [data]);
  const approveItems = open.filter((s) => confidenceTier(s.confidence) === 'approve' || confidenceTier(s.confidence) === 'auto');
  const askItems = open.filter((s) => confidenceTier(s.confidence) === 'ask');

  const probability = useMemo(
    () => successProbability(open.map((s) => ({ urgency: s.urgency as 1 | 2 | 3, confidence: s.confidence } as never))),
    [open],
  );
  const highRisks = open.filter((s) => s.urgency === 3).length;

  async function resolve(s: Suggestion, status: 'approved' | 'executed' | 'dismissed') {
    const supabase = createClient();
    // Approving a "create reminder" writes a real reminder the family sees on the
    // Reminders page (family_reminders, ai_suggested) — the notification cron picks
    // it up via dueFamilyReminderNotices, same as the Front Desk's call reminders.
    if ((status === 'approved' || status === 'executed') && s.action_type === 'create_reminder') {
      const payload = (s.payload ?? {}) as { title?: string; at?: string };
      await supabase.from('family_reminders').insert({
        family_id: familyId,
        created_by: userId,
        title: payload.title ?? s.title,
        notes: s.detail ?? null,
        kind: 'task',
        priority: s.urgency >= 3 ? 'high' : 'normal',
        remind_at: payload.at ?? new Date().toISOString(),
        member_id: s.member_id,
        status: 'pending',
        ai_suggested: true,
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

  if (loading && !scannedOnce) return <SkeletonList />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="module-page">
      <PageHeader
        title="Family Autopilot"
        description="Mission control. Bubaly predicts what your family needs and quietly handles what it can."
        action={
          <Button variant="ghost" onClick={runScan} loading={scanning}>
            <RefreshCw className={cn('h-4 w-4', scanning && 'animate-spin')} /> Re-scan
          </Button>
        }
      />

      {/* Control tower stats */}
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-border bg-gradient-to-br from-brand/10 to-transparent p-5">
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
            <Gauge className="h-4 w-4" /> Today&apos;s success
          </div>
          <p className={cn('text-3xl font-black', probability >= 85 ? 'text-success' : probability >= 60 ? 'text-amber-500' : 'text-danger')}>{probability}%</p>
          <p className="text-xs text-muted">probability the day runs smoothly</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
            <ShieldCheck className="h-4 w-4" /> Handled for you
          </div>
          <p className="text-3xl font-black text-fg">{handled.length}</p>
          <p className="text-xs text-muted">auto-resolved by autopilot</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
            <AlertTriangle className="h-4 w-4" /> Risk alerts
          </div>
          <p className={cn('text-3xl font-black', highRisks > 0 ? 'text-danger' : 'text-success')}>{highRisks}</p>
          <p className="text-xs text-muted">high-urgency items needing you</p>
        </div>
      </div>

      {open.length === 0 && handled.length === 0 ? (
        <EmptyState icon={Rocket} title="All clear ✨"
          description="Autopilot scanned your family and found nothing that needs you right now. We'll keep watching."
          action={<Button onClick={runScan} loading={scanning}><RefreshCw className="h-4 w-4" /> Scan again</Button>} />
      ) : (
        <div className="space-y-6">
          {handled.length > 0 && (
            <Section icon={Sparkles} title="Bubaly already handled it" tone="success">
              {handled.slice(0, 8).map((s) => (
                <HandledRow key={s.id} s={s} />
              ))}
            </Section>
          )}

          {approveItems.length > 0 && (
            <Section icon={ShieldCheck} title="Needs a quick yes" tone="brand">
              {approveItems.map((s) => (
                <SuggestionRow key={s.id} s={s}
                  onApprove={() => resolve(s, 'approved')} onDismiss={() => resolve(s, 'dismissed')} />
              ))}
            </Section>
          )}

          {askItems.length > 0 && (
            <Section icon={AlertTriangle} title="Heads up" tone="muted">
              {askItems.map((s) => (
                <SuggestionRow key={s.id} s={s}
                  onApprove={() => resolve(s, 'approved')} onDismiss={() => resolve(s, 'dismissed')} />
              ))}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ icon: Icon, title, tone, children }: {
  icon: typeof Rocket; title: string; tone: 'success' | 'brand' | 'muted'; children: React.ReactNode;
}) {
  const toneCls = tone === 'success' ? 'text-success' : tone === 'brand' ? 'text-brand' : 'text-muted';
  return (
    <div>
      <h2 className={cn('mb-2.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest', toneCls)}>
        <Icon className="h-3.5 w-3.5" /> {title}
      </h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function HandledRow({ s }: { s: Suggestion }) {
  const Icon = iconFor(s.kind);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-success/20 bg-success/5 px-4 py-3">
      <Icon className="h-4 w-4 flex-shrink-0 text-success" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{s.title}</p>
        {s.detail && <p className="truncate text-xs text-muted">{s.detail}</p>}
      </div>
      <Check className="h-4 w-4 flex-shrink-0 text-success" />
    </div>
  );
}

function SuggestionRow({ s, onApprove, onDismiss }: {
  s: Suggestion; onApprove: () => void; onDismiss: () => void;
}) {
  const Icon = iconFor(s.kind);
  const urgent = s.urgency === 3;
  return (
    <div className={cn('flex items-center gap-3 rounded-xl border px-4 py-3',
      urgent ? 'border-danger/30 bg-danger/5' : 'border-border bg-surface/40')}>
      <Icon className={cn('h-4 w-4 flex-shrink-0', urgent ? 'text-danger' : 'text-brand')} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{s.title}</p>
        {s.detail && <p className="truncate text-xs text-muted">{s.detail}</p>}
      </div>
      <span className="hidden text-[10px] font-medium uppercase tracking-wide text-muted sm:block">{s.confidence}%</span>
      <div className="flex flex-shrink-0 items-center gap-1">
        <button onClick={onApprove}
          className="flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand/90 transition">
          <Check className="h-3.5 w-3.5" /> {s.action_label ?? 'Do it'}
        </button>
        <button onClick={onDismiss} aria-label="Dismiss"
          className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-danger transition">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
