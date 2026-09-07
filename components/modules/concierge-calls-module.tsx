'use client';

// Outbound concierge calls. Mobile-first: a prominent request composer up top,
// then a live list of call requests with a status pill and an expandable call
// plan + outcome. 100% Supabase (realtime on concierge_calls); all writes go
// through the server actions (family-scoped RLS).
//
// HONESTY. Every word about a call's state comes from `callDisplayState()`,
// which reads the persisted `status` AND `provider_ref`. Bubaly has no outbound
// voice integration, so no row carries a provider confirmation today and the
// pill never says "Calling…" or "Called"; it says what is true — queued, waiting
// for a person to call, or done and logged by hand. If a provider is integrated
// later and writes `provider_ref`, the same function starts saying so, from the
// row, with no copy change here. tests/concierge-calls-honesty.test.ts pins it.
import { useMemo, useState, useEffect } from 'react';
import {
  PhoneCall, Sparkles, ChevronDown, Plus, Loader2, X, RotateCcw, Check, Clock, AlertTriangle, PhoneOutgoing, ClipboardCheck,
} from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { createClient } from '@/lib/supabase/client';
import { isRealtimePublished } from '@/lib/realtime/published-tables';
import { PageHeader } from '@/components/app/page-header';
import { StatTile, MiniEmpty } from '@/components/family/shell';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import {
  CALL_TASK_LABEL_KEY, CALL_CATEGORY_LABEL_KEY, CALL_DISPLAY_LABEL, callDisplayState, callDisplayTone, canLogOutcome,
  type CallBrief, type CallCategory, type CallDisplayState, type CallTaskKind,
} from '@/lib/concierge-calls/brief';
import {
  requestCallAction, cancelCallAction, requeueCallAction, logCallOutcomeAction,
} from '@/app/(app)/dashboard/concierge-calls/actions';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Call = Tables<'concierge_calls'>;

const inputCls = 'h-11 w-full rounded-xl border border-border bg-bg px-3 text-sm focus-ring';
const TASK_KINDS: CallTaskKind[] = ['book', 'reschedule', 'cancel', 'confirm', 'inquire', 'follow_up', 'other'];
const CATEGORIES: CallCategory[] = ['medical', 'dental', 'school', 'restaurant', 'service', 'utility', 'retail', 'government', 'other'];

const TONE_CLS: Record<ReturnType<typeof callDisplayTone>, string> = {
  neutral: 'bg-surface text-muted border-border',
  info: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  success: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  danger: 'bg-danger/15 text-danger border-danger/30',
  warn: 'bg-amber-500/15 text-amber-500 border-amber-500/30',
};
const STATE_ICON: Record<CallDisplayState, typeof Check> = {
  draft: Clock, queued: Clock, calling: PhoneOutgoing, called: Check, logged: ClipboardCheck,
  failed: X, needs_person: AlertTriangle, needs_you: AlertTriangle, cancelled: X,
};

export function ConciergeCallsModule({ familyId, initialCalls }: { familyId: string; initialCalls: Call[] }) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [calls, setCalls] = useState<Call[]>(initialCalls);
  const [composerOpen, setComposerOpen] = useState(initialCalls.length === 0);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Realtime: reflect persisted state changes live. A failed refresh keeps the
  // list already on screen rather than replacing it with a false empty.
  useEffect(() => {
    if (!isRealtimePublished('concierge_calls')) return;
    const supabase = createClient();
    const ch = supabase.channel(`concierge_calls:${familyId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'concierge_calls', filter: `family_id=eq.${familyId}` },
        async () => {
          const { data, error } = await supabase.from('concierge_calls').select('*')
            .eq('family_id', familyId).order('created_at', { ascending: false }).limit(100);
          if (error) { console.error('[concierge-calls] refresh read failed', error); return; }
          if (data) setCalls(data as Call[]);
        })
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [familyId]);

  const stats = useMemo(() => {
    const states = calls.map((c) => callDisplayState(c));
    return {
      queued: states.filter((s) => s === 'queued' || s === 'calling').length,
      needsYou: states.filter((s) => s === 'needs_person' || s === 'needs_you').length,
      done: states.filter((s) => s === 'called' || s === 'logged').length,
    };
  }, [calls]);

  async function onCancel(id: string) {
    const res = await cancelCallAction(id);
    if (!res.ok) toastError(res.error); else success(t('conciergeCallsModule.callCancelled'));
  }
  async function onRequeue(id: string) {
    const res = await requeueCallAction(id);
    if (!res.ok) toastError(res.error); else success(t('conciergeCallsModule.backInTheQueue'));
  }

  return (
    <div className="space-y-5 pb-24">
      <PageHeader
        title={t('conciergeCalls.aiCalls')}
        description={t('conciergeCallsModule.planTheCallQueueIt')}
        action={
          <Button size="sm" onClick={() => setComposerOpen((v) => !v)}>
            <Plus className="h-4 w-4" /> {t('conciergeCalls.requestACall')}
          </Button>
        }
      />

      <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>{t('conciergeCallsModule.noPhoneProviderIsConnected')}</p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatTile label={t('conciergeCalls.queued')} value={stats.queued} icon={Clock} accent="bg-blue-600" />
        <StatTile label={t('conciergeCalls.needsYou')} value={stats.needsYou} icon={AlertTriangle} accent="bg-amber-600" />
        <StatTile label={t('conciergeCalls.completed')} value={stats.done} icon={Check} accent="bg-emerald-600" />
      </div>

      {composerOpen && (
        <Composer
          onClose={() => setComposerOpen(false)}
          onCreated={() => { setComposerOpen(false); success(t('conciergeCallsModule.callPlanSaved')); }}
        />
      )}

      <div className="space-y-2.5">
        {calls.length === 0 && !composerOpen && (
          <MiniEmpty icon={PhoneCall} text={t('conciergeCallsModule.noCallRequestsYetAdd')} />
        )}
        {calls.map((c) => {
          const brief = (c.brief ?? {}) as Partial<CallBrief>;
          const state = callDisplayState(c);
          const tone = callDisplayTone(state);
          const Icon = STATE_ICON[state];
          const open = expanded === c.id;
          const taskKey = CALL_TASK_LABEL_KEY[c.task_kind as CallTaskKind];
          return (
            <div key={c.id} className="rounded-2xl border border-border bg-surface/40 p-4">
              <button type="button" onClick={() => setExpanded(open ? null : c.id)} className="flex w-full items-start gap-3 text-left">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand-text">
                  <PhoneCall className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold">{c.callee_name}</span>
                    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide', TONE_CLS[tone])}>
                      <Icon className="h-3 w-3" /> {t(CALL_DISPLAY_LABEL[state].labelKey)}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {taskKey ? t(taskKey) : c.task_kind} · {c.goal}
                  </span>
                </span>
                <ChevronDown className={cn('mt-1 h-4 w-4 shrink-0 text-muted transition', open && 'rotate-180')} />
              </button>

              {open && (
                <div className="mt-3 space-y-3 border-t border-border pt-3 text-sm">
                  {state === 'needs_person' && (
                    <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
                      {t('conciergeCalls.noPhoneProviderConnectedA')}
                    </p>
                  )}
                  {c.outcome && state !== 'needs_person' && (
                    <div className={cn('rounded-xl border p-3', TONE_CLS[tone])}>
                      <p className="text-xs font-semibold uppercase tracking-wide opacity-80">{t('conciergeCalls.outcome')}</p>
                      <p className="mt-1">{c.outcome}</p>
                      {c.transcript_summary && <p className="mt-1.5 text-xs opacity-80">{c.transcript_summary}</p>}
                    </div>
                  )}

                  <div className="rounded-xl border border-brand/25 bg-brand/5 p-3">
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-brand-text">
                      <Sparkles className="h-3.5 w-3.5" /> {t('conciergeCalls.bubalysCallPlan')}
                    </p>
                    {brief.opening && <p className="mt-2 text-sm italic text-fg/90">“{brief.opening}”</p>}
                    {!!brief.keyPoints?.length && (
                      <ul className="mt-2 space-y-1 text-xs text-muted">
                        {brief.keyPoints.map((k, i) => <li key={i} className="flex gap-1.5"><Check className="mt-0.5 h-3 w-3 shrink-0 text-brand-text" /><span>{k}</span></li>)}
                      </ul>
                    )}
                    {!!brief.questions?.length && (
                      <div className="mt-2">
                        <p className="text-[11px] font-semibold text-fg/70">{t('conciergeCalls.questionsToGetAnswered')}</p>
                        <ul className="mt-1 space-y-1 text-xs text-muted">
                          {brief.questions.map((q, i) => <li key={i}>• {q}</li>)}
                        </ul>
                      </div>
                    )}
                    {brief.successCriteria && <p className="mt-2 text-[11px] text-muted"><span className="font-semibold text-fg/70">{t('conciergeCalls.success')}</span> {brief.successCriteria}</p>}
                  </div>

                  {canLogOutcome(state) && <LogOutcome id={c.id} onLogged={() => success(t('conciergeCallsModule.outcomeLogged'))} />}

                  <div className="flex flex-wrap gap-2">
                    {['draft', 'queued', 'needs_person', 'needs_you'].includes(state) && (
                      <button type="button" onClick={() => void onCancel(c.id)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted transition hover:text-danger hover:border-danger/40">
                        <X className="h-3.5 w-3.5" /> {t('conciergeCalls.cancel')}
                      </button>
                    )}
                    {/* Re-queueing a row the queue parked for lack of a provider would only park it again, so that state offers logging instead. */}
                    {['failed', 'needs_you', 'draft'].includes(state) && (
                      <button type="button" onClick={() => void onRequeue(c.id)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold transition hover:bg-elevated">
                        <RotateCcw className="h-3.5 w-3.5" /> {t('conciergeCalls.tryAgain')}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A parent made the call; this records what happened on the row. */
function LogOutcome({ id, onLogged }: { id: string; onLogged: () => void }) {
  const t = useTranslations();
  const { error: toastError } = useToast();
  const [outcome, setOutcome] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    const res = await logCallOutcomeAction(id, outcome);
    setSaving(false);
    if (!res.ok) { toastError(res.error); return; }
    setOutcome('');
    onLogged();
  }

  return (
    <div className="rounded-xl border border-border bg-bg/60 p-3">
      <label className="block">
        <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-fg/80"><ClipboardCheck className="h-3.5 w-3.5" /> {t('conciergeCalls.logWhatHappened')}</span>
        <textarea value={outcome} onChange={(e) => setOutcome(e.target.value)} rows={2} placeholder={t('conciergeCalls.whatHappenedOnTheCall')}
          className="w-full resize-y rounded-xl border border-border bg-bg px-3 py-2 text-sm focus-ring" />
      </label>
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="outline" onClick={() => void submit()} disabled={saving || outcome.trim().length < 2}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {t('conciergeCalls.saveOutcome')}
        </Button>
      </div>
    </div>
  );
}

function Composer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const tr = useTranslations();
  const t = useTranslations();
  const { error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [taskKind, setTaskKind] = useState<CallTaskKind>('book');
  const [calleeName, setCalleeName] = useState('');
  const [calleePhone, setCalleePhone] = useState('');
  const [calleeCategory, setCalleeCategory] = useState<string>('medical');
  const [goal, setGoal] = useState('');
  const [memberName, setMemberName] = useState('');
  const [preferredTimes, setPreferredTimes] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [notes, setNotes] = useState('');

  async function submit() {
    setSaving(true);
    const res = await requestCallAction({
      taskKind, calleeName, calleePhone: calleePhone || undefined, calleeCategory, goal,
      details: {
        memberName: memberName || undefined, preferredTimes: preferredTimes || undefined,
        referenceNumber: referenceNumber || undefined, notes: notes || undefined,
      },
    });
    setSaving(false);
    if (!res.ok) { toastError(res.error); return; }
    onCreated();
  }

  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm font-bold"><PhoneCall className="h-4 w-4 text-brand-text" /> {t('conciergeCalls.requestACall')}</p>
        <button type="button" onClick={onClose} aria-label={t('conciergeCalls.close')} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-elevated"><X className="h-4 w-4" /></button>
      </div>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">{t('conciergeCalls.whatToDo')}</span>
            <select value={taskKind} onChange={(e) => setTaskKind(e.target.value as CallTaskKind)} className={inputCls}>
              {TASK_KINDS.map((k) => <option key={k} value={k}>{t(CALL_TASK_LABEL_KEY[k])}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">{t('conciergeCalls.typeOfPlace')}</span>
            <select value={calleeCategory} onChange={(e) => setCalleeCategory(e.target.value)} className={inputCls}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{t(CALL_CATEGORY_LABEL_KEY[c])}</option>)}
            </select>
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">{t('conciergeCalls.whoToCall')} <span className="text-brand-text">*</span></span>
          <input value={calleeName} onChange={(e) => setCalleeName(e.target.value)} placeholder={t('conciergeCalls.brightSmilesDental')} className={inputCls} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">{t('conciergeCalls.phone')} <span className="font-normal">{t('conciergeCalls.optional')}</span></span>
            <input value={calleePhone} onChange={(e) => setCalleePhone(e.target.value)} inputMode="tel" placeholder="+1 555 010 0000" className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">{t('conciergeCalls.forWhom')}</span>
            <input value={memberName} onChange={(e) => setMemberName(e.target.value)} placeholder={t('conciergeCalls.emma')} className={inputCls} />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">{t('conciergeCalls.goal')} <span className="text-brand-text">*</span></span>
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} placeholder={t('conciergeCalls.bookACleaningIdeallyAWeekday')}
            className="w-full resize-y rounded-xl border border-border bg-bg px-3 py-2 text-sm focus-ring" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">{t('conciergeCalls.preferredTimes')}</span>
            <input value={preferredTimes} onChange={(e) => setPreferredTimes(e.target.value)} placeholder={t('conciergeCalls.weekdayMornings')} className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">{t('conciergeCalls.reference')}</span>
            <input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} placeholder={t('conciergeCalls.accountBooking')} className={inputCls} />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">{t('conciergeCalls.anythingElse')}</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={tr('conciergeCalls.dontAgreeToAnythingOver150')} className={inputCls} />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>{t('conciergeCalls.cancel')}</Button>
          <Button size="sm" onClick={() => void submit()} disabled={saving || calleeName.trim().length < 2 || goal.trim().length < 4}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {t('conciergeCalls.saveTheCallPlan')}
          </Button>
        </div>
      </div>
    </div>
  );
}
