'use client';

// Family Autopilot — "Mission Control". On open it runs a scan that predicts
// what the family needs, auto-handles the high-confidence items, and surfaces
// the rest for one-tap approval or awareness. 100% Supabase-wired via the
// `autopilot_suggestions` table; the prediction logic lives in lib/autopilot.
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Rocket, ShieldCheck, AlertTriangle, Sparkles, Check, X, RefreshCw, Gauge,
  CalendarClock, FileClock, Cake, ShoppingCart, ListChecks, CircleDot,
  CalendarX, Wallet, HeartPulse, Pill, UtensilsCrossed, ShieldCheck as ShieldIcon,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { resolveAutopilotSuggestionAction } from '@/app/(app)/dashboard/autopilot/actions';
import { acceptPolicySuggestionAction } from '@/app/(app)/dashboard/trust/actions';
import { suggestionAction } from '@/lib/autopilot/resolution';
import type { ResolutionResult } from '@/lib/services/autopilot';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { SkeletonList, EmptyState, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { successProbability, confidenceTier } from '@/lib/autopilot/engine';
import { WhyThis } from '@/components/ai/why-this';
import { explainAutopilot } from '@/lib/ai/explanation';
import { useTranslations } from '@/components/i18n/locale-provider';

type Suggestion = Tables<'autopilot_suggestions'>;

const KIND_ICON: Record<string, typeof Rocket> = {
  document: FileClock, appointment: CalendarClock, chore: ListChecks,
  birthday: Cake, groceries: ShoppingCart, conflict: CalendarX,
  finance: Wallet, wellbeing: HeartPulse, medication: Pill, meal: UtensilsCrossed,
  insurance: ShieldIcon, policy: ShieldIcon,
};

function iconFor(kind: string) {
  return KIND_ICON[kind] ?? CircleDot;
}

export function AutopilotModule() {
  const { familyId, userId, role, selfMember } = useApp();
  const owner = `${userId}:${familyId}:${selfMember?.id ?? ''}:${role}`;
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  return <FamilyAutopilot key={owner} owner={owner} currentOwner={currentOwner} />;
}

function FamilyAutopilot({ owner, currentOwner }: { owner: string; currentOwner: { current: string } }) {
  const t = useTranslations();
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const [scanning, setScanning] = useState(false);
  const [scannedOnce, setScannedOnce] = useState(false);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, ResolutionResult>>({});
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  const isCurrent = () => mounted.current && currentOwner.current === owner;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const { data, loading, error, refresh } = useRealtimeQuery<Suggestion>({
    table: 'autopilot_suggestions',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('autopilot_suggestions').select('*').eq('family_id', familyId)
        .order('urgency', { ascending: false }).order('confidence', { ascending: false }),
  });

  async function runScan() {
    if (!isCurrent()) return;
    setScanning(true);
    try {
      const res = await fetch('/api/autopilot/scan', { method: 'POST' });
      const json = (await res.json()) as { autoExecuted?: number; error?: string };
      if (!isCurrent()) return;
      if (!res.ok) throw new Error(json.error || t('autopilotModule.scanFailed'));
      if (json.autoExecuted && json.autoExecuted > 0) success(t('autopilotResolution.scanRecorded', { count: json.autoExecuted }));
      void refresh();
    } catch (err) {
      if (isCurrent()) toastError(describeDbError(err, t('autopilotModule.scanFailed')));
    } finally {
      if (isCurrent()) setScanning(false);
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

  const open = useMemo(() => data.filter((s) => s.family_id === familyId && s.status === 'open'), [data, familyId]);
  const handled = useMemo(() => data.filter((s) => s.family_id === familyId && (s.status === 'auto_executed' || s.status === 'executed')), [data, familyId]);
  const approved = useMemo(() => data.filter((s) => s.family_id === familyId && s.status === 'approved'), [data, familyId]);
  const approveItems = open.filter((s) => confidenceTier(s.confidence) === 'approve' || confidenceTier(s.confidence) === 'auto');
  const askItems = open.filter((s) => confidenceTier(s.confidence) === 'ask');

  const probability = useMemo(
    () => successProbability(open.map((s) => ({ urgency: s.urgency as 1 | 2 | 3, confidence: s.confidence } as never))),
    [open],
  );
  const highRisks = open.filter((s) => s.urgency === 3).length;

  async function resolve(s: Suggestion, dismiss = false) {
    if (!isCurrent() || s.family_id !== familyId || inFlight.current.has(s.id)) return;
    const action = suggestionAction(s);
    if (!dismiss && action.kind !== 'policy' && action.kind !== 'reminder') return;
    inFlight.current.add(s.id);
    setBusyIds([...inFlight.current]);
    try {
      if (!dismiss && action.kind === 'policy') {
        // Standing permission remains a separate, manager-checked trust action.
        const accepted = await acceptPolicySuggestionAction({ suggestionId: s.id });
        if (!isCurrent()) return;
        if (!accepted.ok) return toastError(accepted.error ?? t('autopilotModule.couldNotSaveThatPolicy'));
        success(t('autopilotModule.policyAccepted'));
      } else {
        const result = await resolveAutopilotSuggestionAction({
          suggestionId: s.id, updatedAt: s.updated_at, action: dismiss ? 'dismiss' : 'reminder',
          expectedFamilyId: familyId, expectedUserId: userId,
        });
        if (!isCurrent()) return;
        setOutcomes((previous) => isCurrent() ? { ...previous, [s.id]: result } : previous);
        if (!result.ok) return;
        success(t(result.status === 'dismissed' ? 'autopilotResolution.dismissed' : 'autopilotResolution.reminderSaved'));
      }
      if (isCurrent()) void refresh();
    } catch (error) {
      if (isCurrent()) {
        console.error('[autopilot] action failed', error);
        setOutcomes((previous) => isCurrent() ? { ...previous, [s.id]: { ok: false, code: 'unavailable' } } : previous);
      }
    } finally {
      inFlight.current.delete(s.id);
      if (isCurrent()) setBusyIds([...inFlight.current]);
    }
  }

  async function refreshSuggestion(id: string) {
    if (!isCurrent()) return;
    try {
      await refresh();
      if (isCurrent()) setOutcomes((previous) => {
        if (!isCurrent()) return previous;
        const next = { ...previous }; delete next[id]; return next;
      });
    } catch {
      if (isCurrent()) toastError(t('autopilotResolution.unavailable'));
    }
  }

  if (loading && !scannedOnce) return <SkeletonList />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="module-page">
      <PageHeader
        title={t('autopilot.familyAutopilot')}
        description={t('autopilotModule.missionControlBubalyPredictsWhat')}
        action={
          <Button variant="ghost" onClick={runScan} loading={scanning}>
            <RefreshCw className={cn('h-4 w-4', scanning && 'animate-spin')} /> {t('autopilotResolution.rescan')}
          </Button>
        }
      />

      {/* Control tower stats */}
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-border bg-gradient-to-br from-brand/10 to-transparent p-5">
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
            <Gauge className="h-4 w-4" /> {t('autopilot.todayAposSSuccess')}
          </div>
          <p className={cn('text-3xl font-black', probability >= 85 ? 'text-success' : probability >= 60 ? 'text-amber-500' : 'text-danger')}>{probability}%</p>
          <p className="text-xs text-muted">{t('autopilot.probabilityTheDayRunsSmoothly')}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
            <ShieldCheck className="h-4 w-4" /> {t('autopilotResolution.recordedExecutions')}
          </div>
          <p className="text-3xl font-black text-fg">{handled.length}</p>
          <p className="text-xs text-muted">{t('autopilotResolution.executionMethod')}
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
            <AlertTriangle className="h-4 w-4" /> {t('autopilot.riskAlerts')}
          </div>
          <p className={cn('text-3xl font-black', highRisks > 0 ? 'text-danger' : 'text-success')}>{highRisks}</p>
          <p className="text-xs text-muted">{t('autopilot.highUrgencyItemsNeedingYou')}</p>
        </div>
      </div>

      {open.length === 0 && handled.length === 0 && approved.length === 0 ? (
        <EmptyState icon={Rocket} title={t('autopilot.allClear')}
          description={t('autopilotModule.autopilotScannedYourFamilyAnd')}
          action={<Button onClick={runScan} loading={scanning}><RefreshCw className="h-4 w-4" /> {t('autopilot.scanAgain')}</Button>} />
      ) : (
        <div className="space-y-6">
          {handled.length > 0 && (
            <Section icon={Sparkles} title={t('autopilotResolution.recordedExecutions')} tone="success">
              {handled.slice(0, 8).map((s) => (
                <HandledRow key={s.id} s={s} />
              ))}
            </Section>
          )}

          {approved.length > 0 && (
            <Section icon={CircleDot} title={t('autopilotResolution.previouslyApproved')} tone="muted">
              <p className="text-sm text-muted">{t('autopilotResolution.completionUnknown')}</p>
              {approved.map((s) => <SuggestionRow key={s.id} s={s} busy={busyIds.includes(s.id)} outcome={outcomes[s.id]} onRefresh={() => refreshSuggestion(s.id)}
                onApprove={() => resolve(s)} onDismiss={() => resolve(s, true)} />)}
            </Section>
          )}

          {approveItems.length > 0 && (
            <Section icon={ShieldCheck} title={t('autopilotResolution.nextSteps')} tone="brand">
              {approveItems.map((s) => (
                <SuggestionRow key={s.id} s={s} busy={busyIds.includes(s.id)} outcome={outcomes[s.id]} onRefresh={() => refreshSuggestion(s.id)}
                  onApprove={() => resolve(s)} onDismiss={() => resolve(s, true)} />
              ))}
            </Section>
          )}

          {askItems.length > 0 && (
            <Section icon={AlertTriangle} title={t('autopilot.headsUp')} tone="muted">
              {askItems.map((s) => (
                <SuggestionRow key={s.id} s={s} busy={busyIds.includes(s.id)} outcome={outcomes[s.id]} onRefresh={() => refreshSuggestion(s.id)}
                  onApprove={() => resolve(s)} onDismiss={() => resolve(s, true)} />
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
  const toneCls = tone === 'success' ? 'text-success' : tone === 'brand' ? 'text-brand-text' : 'text-muted';
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

function SuggestionRow({ s, onApprove, onDismiss, busy, outcome, onRefresh }: {
  s: Suggestion; onApprove: () => void; onDismiss: () => void; busy: boolean; outcome?: ResolutionResult; onRefresh: () => void;
}) {
  const t = useTranslations();
  const Icon = iconFor(s.kind);
  const urgent = s.urgency === 3;
  const action = suggestionAction(s);
  return (
    <div className={cn('rounded-xl border px-4 py-3',
      urgent ? 'border-danger/30 bg-danger/5' : 'border-border bg-surface/40')}>
      <div className="flex items-center gap-3">
        <Icon className={cn('h-4 w-4 flex-shrink-0', urgent ? 'text-danger' : 'text-brand-text')} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{s.title}</p>
          {s.detail && <p className="truncate text-xs text-muted">{s.detail}</p>}
        </div>
        <span className="hidden text-[10px] font-medium uppercase tracking-wide text-muted sm:block">{s.confidence}%</span>
        <div className="flex flex-shrink-0 items-center gap-1">
          {action.kind === 'review' ? <Link href={action.href} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white">{t(action.labelKey)}</Link>
            : action.kind === 'unavailable' ? <span className="max-w-40 text-xs text-muted">{t(action.labelKey)}</span>
            : <button onClick={onApprove} disabled={busy || !!(outcome && !outcome.ok && outcome.code === 'sourceChanged')}
            className="flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand/90 transition">
            <Check className="h-3.5 w-3.5" /> {t(outcome && !outcome.ok && outcome.code === 'resolutionPending' ? 'autopilotResolution.retryStatus' : action.labelKey)}
          </button>}
          <button onClick={onDismiss} disabled={busy} aria-label={t('autopilot.dismiss')}
            className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-danger transition">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {action.kind === 'review' && <p className="mt-2 text-xs text-muted">{t('autopilotResolution.reviewDoesNotComplete')}</p>}
      {outcome && !outcome.ok && <div role="status" className="mt-2 text-sm text-danger">
        <p>{t(`autopilotResolution.${outcome.code}`)}</p>
        {outcome.saved && <Link href="/dashboard/reminders" className="underline">{t('autopilotResolution.openReminders')}</Link>}
        {['changed', 'sourceChanged', 'contextChanged'].includes(outcome.code) && <button type="button" onClick={onRefresh} className="ml-3 underline">{t('autopilotResolution.refresh')}</button>}
      </div>}
      <div className="mt-1.5 pl-7">
        <WhyThis
          surface="autopilot" refId={s.id} refKind={s.kind}
          explanation={explainAutopilot({
            kind: s.kind, title: s.title, detail: s.detail,
            confidence: s.confidence, urgency: s.urgency,
            source_kind: s.source_kind, action_label: s.action_label,
          })}
        />
      </div>
    </div>
  );
}
