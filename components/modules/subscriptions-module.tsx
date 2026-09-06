'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Plus, Trash2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { AiInsight } from '@/components/ai/ai-insight';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { SavingsCoachCard } from '@/components/modules/savings-coach-card';
import { usd } from '@/lib/finance/splits';
import {
  CADENCES, SUB_STATUSES, monthlyCostCents, annualCostCents, summarizeSubscriptions, isStale, wastedMonthlyCents, subscriptionUsage,
  type SubLike,
} from '@/lib/finance/subscriptions';
import type { Tables } from '@/lib/database.types';
import { isManager } from '@/lib/constants/roles';
import {
  candidateAlreadyTracked, subscriptionCandidateDraft, subscriptionReviewContextKey,
  type SubscriptionCandidate, type SubscriptionCandidateResponse, type SubscriptionReviewContext, type TrackedCandidateMatch,
} from '@/lib/finance/subscription-candidates';

type Sub = Tables<'subscriptions_tracked'>;

const CATEGORIES = ['Streaming', 'Music', 'Software', 'Gaming', 'News', 'Fitness', 'Cloud', 'Membership', 'Other'];
const blank = () => ({ id: '', name: '', cost: '', cadence: 'monthly', category: 'Streaming', status: 'active', next_charge: '', last_used: '', note: '' });

export function SubscriptionsModule() {
  const { familyId, userId, selfMember } = useApp();
  const context: SubscriptionReviewContext = {
    familyId, userId, memberId: selfMember?.id ?? null, role: selfMember?.role ?? null, active: selfMember?.is_active === true,
  };
  // Remount the entire workspace, including any open Add draft, on access changes.
  return <SubscriptionsWorkspace key={subscriptionReviewContextKey(context)} context={context} />;
}

export function SubscriptionsWorkspace({ context }: { context: SubscriptionReviewContext }) {
  const { familyId, userId } = context;
  const { success, error: toastError } = useToast();

  const { data: subs, loading, error, refresh } = useRealtimeQuery<Sub>({
    table: 'subscriptions_tracked', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('subscriptions_tracked').select('*').eq('family_id', familyId).order('status').order('name'),
  });

  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const [candidateDraft, setCandidateDraft] = useState(false);
  const all = useMemo(() => subs ?? [], [subs]);
  const stats = useMemo(() => summarizeSubscriptions(all as SubLike[]), [all]);
  const usageNow = new Date();
  const reviewMonthly = wastedMonthlyCents(all as SubLike[], 60, usageNow);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !form.name.trim()) return;
    const row = {
      name: form.name.trim(),
      cost_cents: Math.round(parseFloat(form.cost || '0') * 100),
      cadence: form.cadence,
      category: form.category,
      status: form.status,
      next_charge: form.next_charge || null,
      last_used: form.last_used || null,
      note: form.note.trim() || null,
    };
    const supabase = createClient();
    const { error } = form.id
      ? await supabase.from('subscriptions_tracked').update(row).eq('id', form.id)
      : await supabase.from('subscriptions_tracked').insert({ ...row, family_id: familyId, created_by: userId });
    if (error) return toastError(describeDbError(error));
    success(form.id ? 'Updated' : 'Added');
    setForm(null);
  }

  async function markUsed(id: string) {
    const { error } = await createClient().from('subscriptions_tracked').update({ last_used: new Date().toISOString().slice(0, 10) }).eq('id', id);
    if (error) toastError(describeDbError(error)); else success('Marked used today');
  }
  async function setStatus(id: string, status: string) {
    const { error } = await createClient().from('subscriptions_tracked').update({ status }).eq('id', id);
    if (error) toastError(describeDbError(error));
  }
  async function remove(id: string) {
    if (!confirm('Delete this subscription?')) return;
    const { error } = await createClient().from('subscriptions_tracked').delete().eq('id', id);
    if (error) toastError(describeDbError(error)); else success('Deleted');
  }
  function edit(s: Sub) {
    setCandidateDraft(false);
    setForm({ id: s.id, name: s.name, cost: (s.cost_cents / 100).toString(), cadence: s.cadence, category: s.category ?? 'Other', status: s.status, next_charge: s.next_charge ?? '', last_used: s.last_used ?? '', note: s.note ?? '' });
  }

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message="Could not load subscriptions. Refresh and try again." onRetry={refresh} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold"><RefreshCw className="h-4 w-4 text-brand-text" /> Subscription Tracking</h3>
        <div className="flex items-center gap-2">
          <AiInsight kind="subscriptions" />
          <Button onClick={() => { setCandidateDraft(false); setForm(blank()); }}><Plus className="h-4 w-4" /> Add subscription</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-2xl border border-border bg-surface/40 p-4"><p className="text-xs text-muted">Active</p><p className="text-xl font-bold">{stats.active}</p></div>
        <div className="rounded-2xl border border-border bg-surface/40 p-4"><p className="text-xs text-muted">Monthly</p><p className="text-xl font-bold">{usd(stats.monthlyCents)}</p></div>
        <div className="rounded-2xl border border-border bg-surface/40 p-4"><p className="text-xs text-muted">Annual</p><p className="text-xl font-bold">{usd(stats.annualCents)}</p></div>
        <div className="rounded-2xl border border-border bg-surface/40 p-4"><p className="text-xs text-muted">Usage review / mo</p><p className={`text-xl font-bold ${reviewMonthly > 0 ? 'text-amber-500' : ''}`}>{usd(reviewMonthly)}</p></div>
      </div>

      <SavingsCoachCard />

      <SubscriptionCandidateReview key={subscriptionReviewContextKey(context)} context={context} tracked={all} onPrefill={(candidate) => {
        setCandidateDraft(true);
        setForm({ ...blank(), ...subscriptionCandidateDraft(candidate) });
      }} />

      {reviewMonthly > 0 && (
        <div className="flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p>Subscriptions totaling <strong>{usd(reviewMonthly)}/mo</strong> have recorded use more than 60 days ago. Confirm current household use before deciding what to keep. This amount is not confirmed savings.</p>
        </div>
      )}

      <div className="space-y-2">
        {all.length === 0 ? (
          <EmptyState icon={RefreshCw} title="No subscriptions tracked" description="Add streaming, apps and memberships to see your true recurring spend." />
        ) : all.map((s) => {
          const usage = subscriptionUsage(s, usageNow);
          const stale = isStale(s as SubLike, 60, usageNow);
          const canceled = s.status === 'canceled';
          return (
            <div key={s.id} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-surface/40 p-3">
              <div className="min-w-0">
                <p className={`font-medium ${canceled ? 'text-muted line-through' : ''}`}>
                  {s.name} <span className="text-muted">· {usd(s.cost_cents)}/{s.cadence === 'monthly' ? 'mo' : s.cadence === 'yearly' ? 'yr' : s.cadence}</span>
                  {stale && !canceled && <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-500"><AlertTriangle className="h-3 w-3" /> review usage</span>}
                  {s.status === 'trial' && <span className="ml-2 rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] text-blue-400">trial</span>}
                </p>
                <p className="text-xs text-muted">
                  {s.category ?? 'Other'} · {usd(monthlyCostCents(s.cost_cents, s.cadence))}/mo · {usd(annualCostCents(s.cost_cents, s.cadence))}/yr
                  {s.next_charge ? ` · next ${fmtDate(s.next_charge)}` : ''}
                  {usage.state === 'recorded' ? ` · last recorded use ${fmtDate(usage.lastUsed)}`
                    : usage.state === 'unknown' ? ' · usage unknown; Edit to add last use'
                      : usage.state === 'future' ? ' · last-use date is in the future; Edit to correct'
                        : ' · last-use date is invalid; Edit to correct'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs">
                {!canceled && <button onClick={() => markUsed(s.id)} className="inline-flex items-center gap-1 text-muted hover:text-success" title="Mark used today"><CheckCircle2 className="h-4 w-4" /></button>}
                <button onClick={() => setStatus(s.id, canceled ? 'active' : 'canceled')} className="text-muted hover:text-fg hover:underline">{canceled ? 'Reactivate' : 'Cancel'}</button>
                <button onClick={() => edit(s)} className="text-muted hover:text-fg hover:underline">Edit</button>
                <button onClick={() => remove(s.id)} className="text-muted hover:text-danger" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>
          );
        })}
      </div>

      {form && (
        <Modal open onClose={() => setForm(null)} title={form.id ? 'Edit subscription' : 'Add subscription'}
          description={candidateDraft ? 'This draft comes from recorded expenses. Confirm the name, USD cost, cadence and status, then Save. Usage and the next charge are still unknown.' : undefined}>
          <form onSubmit={save} className="space-y-3">
            <Field label="Name">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Netflix, Spotify…" />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Cost ($)">{(id) => <Input id={id} type="number" inputMode="decimal" step="0.01" min="0" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />}</Field>
              <Field label="Billing">{(id) => <Select id={id} value={form.cadence} onChange={(e) => setForm({ ...form, cadence: e.target.value })}>{CADENCES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">{(id) => <Select id={id} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}</Field>
              <Field label="Status">{(id) => <Select id={id} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>{SUB_STATUSES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Next charge">{(id) => <Input id={id} type="date" value={form.next_charge} onChange={(e) => setForm({ ...form, next_charge: e.target.value })} />}</Field>
              <Field label="Last used" hint="Leave blank if usage is unknown; record only actual use.">{(id) => <Input id={id} type="date" value={form.last_used} onChange={(e) => setForm({ ...form, last_used: e.target.value })} />}</Field>
            </div>
            <Field label="Note">{(id) => <Textarea id={id} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit">{candidateDraft ? 'Save subscription' : form.id ? 'Save' : 'Add'}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export function SubscriptionCandidateReview({ context, tracked, onPrefill }: {
  context: SubscriptionReviewContext; tracked: readonly TrackedCandidateMatch[]; onPrefill: (candidate: SubscriptionCandidate) => void;
}) {
  const contextKey = subscriptionReviewContextKey(context);
  const canReview = !!context.userId && !!context.memberId && context.active && isManager(context.role);
  const [review, setReview] = useState<{ contextKey: string; generation: number; loading: boolean; result: SubscriptionCandidateResponse | null; error: string | null }>({ contextKey, generation: 0, loading: false, result: null, error: null });
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  useEffect(() => () => {
    generation.current += 1;
    request.current?.abort();
  }, [contextKey]);
  const visibleReview = review.contextKey === contextKey ? review : { contextKey, generation: generation.current, loading: false, result: null, error: null };

  async function load() {
    if (!canReview || visibleReview.loading) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const scan = ++generation.current;
    const isCurrent = () => !controller.signal.aborted && generation.current === scan && currentContext.current === contextKey;
    setReview({ contextKey, generation: scan, loading: true, result: null, error: null });
    try {
      const response = await fetch('/api/subscriptions/candidates', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!isCurrent()) return;
      const result = await response.json() as SubscriptionCandidateResponse & { error?: string };
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(result.error || 'Recorded expenses could not be reviewed. Try again.');
      if (result.familyId !== context.familyId || !result.context || subscriptionReviewContextKey(result.context) !== contextKey
        || !Array.isArray(result.candidates) || !result.window
        || result.candidates.some((candidate) => candidate.currency !== 'USD' || !Array.isArray(candidate.evidence))) {
        throw new Error('The review did not match the current account or family. Refresh and try again.');
      }
      setReview({ contextKey, generation: scan, loading: false, result, error: null });
    } catch (error) {
      if (isCurrent()) setReview({ contextKey, generation: scan, loading: false, result: null, error: error instanceof Error ? error.message : 'Recorded expenses could not be reviewed. Try again.' });
    }
  }

  const candidates = canReview ? visibleReview.result?.candidates.filter((candidate) => !candidateAlreadyTracked(candidate, tracked)) ?? [] : [];
  return (
    <section aria-label="Recurring expense candidates" className="space-y-3 rounded-2xl border border-border bg-surface/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h4 className="font-semibold">Review recurring expenses</h4>
          <p className="text-sm text-muted">Look for three or more matching recorded expenses. A repeated expense is a candidate, not proof of a subscription.</p>
          <p className="mt-1 text-xs text-muted">Only expenses linked to accessible USD accounts can pre-fill this USD form. Unlinked or other-currency expenses are excluded without conversion.</p>
        </div>
        <Button type="button" disabled={!canReview || visibleReview.loading} onClick={() => { void load(); }}>{visibleReview.loading ? 'Reviewing...' : visibleReview.result || visibleReview.error ? 'Refresh candidates' : 'Find candidates'}</Button>
      </div>
      {!canReview && <p className="text-sm text-muted">A current parent or adult membership is required to review recorded expenses.</p>}
      {visibleReview.loading && <p role="status" className="text-sm text-muted">Reading authorized recorded expenses...</p>}
      {visibleReview.error && <p role="alert" className="text-sm text-danger">{visibleReview.error}</p>}
      {canReview && visibleReview.result && (
        <div className="space-y-3">
          <p role="status" className="text-xs text-muted">Reviewed {visibleReview.result.recordsRead} recorded expenses from {visibleReview.result.window.from} to {visibleReview.result.window.to}.
            {visibleReview.result.limited ? ' History was limited to the 500 most recent records; this is a partial review.' : ''}
            {visibleReview.result.unsupportedCurrencyRecords > 0 ? ` ${visibleReview.result.unsupportedCurrencyRecords} records were excluded because their currency is unknown or unsupported.` : ''}
          </p>
          {candidates.length === 0 ? <p className="text-sm text-muted">No new candidates meet these conservative rules within the reviewed records. You can still add a subscription manually.</p> : candidates.map((candidate) => (
            <details key={candidate.id} className="rounded-xl border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium focus-visible:outline focus-visible:outline-2">Review evidence: {candidate.name} - USD {(candidate.amountCents / 100).toFixed(2)}, approximately {candidate.cadence}</summary>
              <div className="mt-3 space-y-3 text-sm">
                <p>{candidate.explanation}</p>
                <p className="text-muted">Observed window: {candidate.observed.from} to {candidate.observed.to}.</p>
                <ul aria-label={`Recorded expense evidence for ${candidate.name}`} className="space-y-2">
                  {candidate.evidence.map((item) => <li key={item.recordId} className="break-words text-xs text-muted"><time dateTime={item.date}>{item.date}</time> - USD {(item.amountCents / 100).toFixed(2)} - <code className="break-all">transactions/{item.recordId}</code></li>)}
                </ul>
                <p className="text-xs text-muted">Use this evidence to pre-fill an editable Add form. Nothing is saved until you review and choose Save subscription.</p>
                <Button type="button" onClick={() => {
                  if (currentContext.current === contextKey && generation.current === visibleReview.generation && request.current?.signal.aborted !== true) onPrefill(candidate);
                }}>Use in Add form</Button>
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
