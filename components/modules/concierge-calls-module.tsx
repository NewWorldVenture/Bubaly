'use client';

// AI Concierge Calls — "Bubaly calls for you." Mobile-first: a prominent request
// composer up top, then a live list of calls with status pills and an expandable
// AI brief + outcome. 100% Supabase (realtime on concierge_calls); all writes go
// through the server actions (family-scoped RLS).
import { useMemo, useState, useEffect } from 'react';
import {
  PhoneCall, Sparkles, ChevronDown, Plus, Loader2, X, RotateCcw, Check, Clock, AlertTriangle, PhoneOutgoing,
} from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { createClient } from '@/lib/supabase/client';
import { PageHeader } from '@/components/app/page-header';
import { StatTile, MiniEmpty } from '@/components/family/shell';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import {
  CALL_TASK_LABEL, CALL_STATUS_LABEL, callStatusTone,
  type CallBrief, type CallStatus, type CallTaskKind,
} from '@/lib/concierge-calls/brief';
import { requestCallAction, cancelCallAction, requeueCallAction } from '@/app/(app)/dashboard/concierge-calls/actions';
import type { Tables } from '@/lib/database.types';

type Call = Tables<'concierge_calls'>;

const inputCls = 'h-11 w-full rounded-xl border border-border bg-bg px-3 text-sm focus-ring';
const TASK_KINDS: CallTaskKind[] = ['book', 'reschedule', 'cancel', 'confirm', 'inquire', 'follow_up', 'other'];
const CATEGORIES = ['medical', 'dental', 'school', 'restaurant', 'service', 'utility', 'retail', 'government', 'other'] as const;

const TONE_CLS: Record<ReturnType<typeof callStatusTone>, string> = {
  neutral: 'bg-surface text-muted border-border',
  info: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  success: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  danger: 'bg-danger/15 text-danger border-danger/30',
  warn: 'bg-amber-500/15 text-amber-500 border-amber-500/30',
};
const STATUS_ICON: Record<string, typeof Check> = {
  completed: Check, calling: PhoneOutgoing, queued: Clock, failed: X, action_needed: AlertTriangle, draft: Clock, cancelled: X,
};

export function ConciergeCallsModule({ familyId, initialCalls }: { familyId: string; initialCalls: Call[] }) {
  const { success, error: toastError } = useToast();
  const [calls, setCalls] = useState<Call[]>(initialCalls);
  const [composerOpen, setComposerOpen] = useState(initialCalls.length === 0);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Realtime: reflect status changes (queued → calling → completed) live.
  useEffect(() => {
    const supabase = createClient();
    const ch = supabase.channel(`concierge_calls:${familyId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'concierge_calls', filter: `family_id=eq.${familyId}` },
        async () => {
          const { data } = await supabase.from('concierge_calls').select('*')
            .eq('family_id', familyId).order('created_at', { ascending: false }).limit(100);
          if (data) setCalls(data as Call[]);
        })
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [familyId]);

  const stats = useMemo(() => ({
    active: calls.filter((c) => ['queued', 'calling'].includes(c.status)).length,
    needsYou: calls.filter((c) => c.status === 'action_needed').length,
    done: calls.filter((c) => c.status === 'completed').length,
  }), [calls]);

  async function onCancel(id: string) {
    const res = await cancelCallAction(id);
    if (!res.ok) toastError(res.error); else success('Call cancelled');
  }
  async function onRequeue(id: string) {
    const res = await requeueCallAction(id);
    if (!res.ok) toastError(res.error); else success('Back in the queue');
  }

  return (
    <div className="space-y-5 pb-24">
      <PageHeader
        title="AI Calls"
        description="Bubaly makes the call for you — booking, rescheduling, confirming, chasing things down."
        action={
          <Button size="sm" onClick={() => setComposerOpen((v) => !v)}>
            <Plus className="h-4 w-4" /> Request a call
          </Button>
        }
      />

      <div className="grid grid-cols-3 gap-3">
        <StatTile label="In progress" value={stats.active} icon={PhoneOutgoing} accent="bg-blue-600" />
        <StatTile label="Needs you" value={stats.needsYou} icon={AlertTriangle} accent="bg-amber-600" />
        <StatTile label="Completed" value={stats.done} icon={Check} accent="bg-emerald-600" />
      </div>

      {composerOpen && (
        <Composer
          onClose={() => setComposerOpen(false)}
          onCreated={() => { setComposerOpen(false); success('On it — Bubaly will make the call.'); }}
        />
      )}

      <div className="space-y-2.5">
        {calls.length === 0 && !composerOpen && (
          <MiniEmpty icon={PhoneCall} text="No calls yet — ask Bubaly to make one for you." />
        )}
        {calls.map((c) => {
          const brief = (c.brief ?? {}) as Partial<CallBrief>;
          const tone = callStatusTone(c.status as CallStatus);
          const Icon = STATUS_ICON[c.status] ?? Clock;
          const open = expanded === c.id;
          return (
            <div key={c.id} className="rounded-2xl border border-border bg-surface/40 p-4">
              <button type="button" onClick={() => setExpanded(open ? null : c.id)} className="flex w-full items-start gap-3 text-left">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand">
                  <PhoneCall className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold">{c.callee_name}</span>
                    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide', TONE_CLS[tone])}>
                      <Icon className="h-3 w-3" /> {CALL_STATUS_LABEL[c.status as CallStatus] ?? c.status}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {CALL_TASK_LABEL[c.task_kind as CallTaskKind] ?? c.task_kind} · {c.goal}
                  </span>
                </span>
                <ChevronDown className={cn('mt-1 h-4 w-4 shrink-0 text-muted transition', open && 'rotate-180')} />
              </button>

              {open && (
                <div className="mt-3 space-y-3 border-t border-border pt-3 text-sm">
                  {c.outcome && (
                    <div className={cn('rounded-xl border p-3', TONE_CLS[tone])}>
                      <p className="text-xs font-semibold uppercase tracking-wide opacity-80">Outcome</p>
                      <p className="mt-1">{c.outcome}</p>
                      {c.transcript_summary && <p className="mt-1.5 text-xs opacity-80">{c.transcript_summary}</p>}
                    </div>
                  )}

                  <div className="rounded-xl border border-brand/25 bg-brand/5 p-3">
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-brand">
                      <Sparkles className="h-3.5 w-3.5" /> Bubaly’s call plan
                    </p>
                    {brief.opening && <p className="mt-2 text-sm italic text-fg/90">“{brief.opening}”</p>}
                    {!!brief.keyPoints?.length && (
                      <ul className="mt-2 space-y-1 text-xs text-muted">
                        {brief.keyPoints.map((k, i) => <li key={i} className="flex gap-1.5"><Check className="mt-0.5 h-3 w-3 shrink-0 text-brand" /><span>{k}</span></li>)}
                      </ul>
                    )}
                    {!!brief.questions?.length && (
                      <div className="mt-2">
                        <p className="text-[11px] font-semibold text-fg/70">Questions to get answered</p>
                        <ul className="mt-1 space-y-1 text-xs text-muted">
                          {brief.questions.map((q, i) => <li key={i}>• {q}</li>)}
                        </ul>
                      </div>
                    )}
                    {brief.successCriteria && <p className="mt-2 text-[11px] text-muted"><span className="font-semibold text-fg/70">Success:</span> {brief.successCriteria}</p>}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {['draft', 'queued', 'action_needed'].includes(c.status) && (
                      <button type="button" onClick={() => void onCancel(c.id)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted transition hover:text-danger hover:border-danger/40">
                        <X className="h-3.5 w-3.5" /> Cancel
                      </button>
                    )}
                    {['failed', 'action_needed', 'draft'].includes(c.status) && (
                      <button type="button" onClick={() => void onRequeue(c.id)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold transition hover:bg-elevated">
                        <RotateCcw className="h-3.5 w-3.5" /> Try again
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

function Composer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
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
        <p className="flex items-center gap-2 text-sm font-bold"><PhoneCall className="h-4 w-4 text-brand" /> Request a call</p>
        <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-elevated"><X className="h-4 w-4" /></button>
      </div>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">What to do</span>
            <select value={taskKind} onChange={(e) => setTaskKind(e.target.value as CallTaskKind)} className={inputCls}>
              {TASK_KINDS.map((k) => <option key={k} value={k}>{CALL_TASK_LABEL[k]}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Type of place</span>
            <select value={calleeCategory} onChange={(e) => setCalleeCategory(e.target.value)} className={inputCls}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
            </select>
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Who to call <span className="text-brand">*</span></span>
          <input value={calleeName} onChange={(e) => setCalleeName(e.target.value)} placeholder="Bright Smiles Dental" className={inputCls} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Phone <span className="font-normal">(to auto-dial)</span></span>
            <input value={calleePhone} onChange={(e) => setCalleePhone(e.target.value)} inputMode="tel" placeholder="+1 555 010 0000" className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">For whom</span>
            <input value={memberName} onChange={(e) => setMemberName(e.target.value)} placeholder="Emma" className={inputCls} />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Goal <span className="text-brand">*</span></span>
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} placeholder="Book a cleaning, ideally a weekday morning in the next two weeks."
            className="w-full resize-y rounded-xl border border-border bg-bg px-3 py-2 text-sm focus-ring" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Preferred times</span>
            <input value={preferredTimes} onChange={(e) => setPreferredTimes(e.target.value)} placeholder="Weekday mornings" className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Reference #</span>
            <input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} placeholder="Account / booking #" className={inputCls} />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Anything else</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Don't agree to anything over $150." className={inputCls} />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={() => void submit()} disabled={saving || calleeName.trim().length < 2 || goal.trim().length < 4}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Ask Bubaly to call
          </Button>
        </div>
      </div>
    </div>
  );
}
