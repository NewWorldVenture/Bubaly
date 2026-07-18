'use client';

import { useMemo, useState } from 'react';
import { Vote, Plus, Trash2, Check, Trophy, Lock, Plane, Sparkles, DollarSign, MapPin, AlertTriangle, Leaf } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { AiInsight } from '@/components/ai/ai-insight';
import { fmtDate } from '@/lib/utils/format';
import { tallyPoll, voterCount, memberSelections, isPollClosed, type VoteLike, type OptionLike } from '@/lib/voting/polls';
import { facilitateConsensus, budgetCapForCategory, type ConsensusOption } from '@/lib/voting/consensus';
import { WhyThis } from '@/components/ai/why-this';
import { explainConsensus } from '@/lib/ai/explanation';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';

type Poll = Tables<'family_polls'>;
type Option = Tables<'family_poll_options'>;
type VoteRow = Tables<'family_poll_votes'>;
type BudgetRow = Pick<Tables<'budgets'>, 'category' | 'amount'>;
type VacationLite = { id: string; title: string };

type OptionDraft = { label: string; cost: string; travel: string; tags: string };
const blankOption = (): OptionDraft => ({ label: '', cost: '', travel: '', tags: '' });
const blank = () => ({
  question: '', description: '', kind: 'single', vacation_id: '', closes_at: '',
  decision_category: 'general', budget: '', required_tags: '',
  options: [blankOption(), blankOption()],
});
type Form = ReturnType<typeof blank>;

const CATEGORY_LABEL: Record<string, string> = {
  general: 'General', meal: 'Meal', vacation: 'Vacation', shopping: 'Shopping', activity: 'Activity',
};

const parseTags = (s: string): string[] =>
  s.split(',').map((t) => t.trim()).filter(Boolean);
const usd = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

export function VotingModule() {
  const { familyId, userId, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const meId = selfMember?.id ?? null;

  const { data: polls, loading: pollsLoading, error: pollsError, refresh: refreshPolls } = useRealtimeQuery<Poll>({
    table: 'family_polls', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_polls').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
  });
  const { data: options, loading: optionsLoading, error: optionsError, refresh: refreshOptions } = useRealtimeQuery<Option>({
    table: 'family_poll_options', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_poll_options').select('*').eq('family_id', familyId),
  });
  const { data: votes, loading: votesLoading, error: votesError, refresh: refreshVotes } = useRealtimeQuery<VoteRow>({
    table: 'family_poll_votes', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_poll_votes').select('*').eq('family_id', familyId),
  });
  const { data: vacations, loading: vacationsLoading, error: vacationsError, refresh: refreshVacations } = useRealtimeQuery<VacationLite>({
    table: 'vacations', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('vacations').select('id, title').eq('family_id', familyId).order('created_at', { ascending: false }),
  });
  // Reasoning context: the family's real budgets fund the consensus when a poll
  // has a spending category but no explicit cap.
  const { data: budgets, loading: budgetsLoading, error: budgetsError, refresh: refreshBudgets } = useRealtimeQuery<BudgetRow>({
    table: 'budgets', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('budgets').select('category, amount').eq('family_id', familyId),
  });

  const loading = pollsLoading || optionsLoading || votesLoading || vacationsLoading || budgetsLoading;
  const error = pollsError || optionsError || votesError || vacationsError || budgetsError;
  const refresh = () => { void refreshPolls(); void refreshOptions(); void refreshVotes(); void refreshVacations(); void refreshBudgets(); };

  const [form, setForm] = useState<Form | null>(null);
  const optionsByPoll = useMemo(() => {
    const m = new Map<string, Option[]>();
    for (const o of options ?? []) { const a = m.get(o.poll_id) ?? []; a.push(o); m.set(o.poll_id, a); }
    return m;
  }, [options]);
  const votesByPoll = useMemo(() => {
    const m = new Map<string, VoteRow[]>();
    for (const v of votes ?? []) { const a = m.get(v.poll_id) ?? []; a.push(v); m.set(v.poll_id, a); }
    return m;
  }, [votes]);
  const vacationName = (id: string | null) => (id ? (vacations ?? []).find((v) => v.id === id)?.title ?? null : null);

  async function createPoll(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !form.question.trim()) return;
    const opts = form.options.filter((o) => o.label.trim());
    if (opts.length < 2) return toastError('Add at least two options');
    const supabase = createClient();
    const { data: poll, error } = await supabase.from('family_polls').insert({
      family_id: familyId,
      vacation_id: form.vacation_id || null,
      question: form.question.trim(),
      description: form.description.trim() || null,
      kind: form.kind,
      decision_category: form.decision_category,
      budget_cents: form.budget ? Math.round(Number(form.budget) * 100) : null,
      required_tags: parseTags(form.required_tags),
      closes_at: form.closes_at ? new Date(form.closes_at).toISOString() : null,
      created_by: userId,
    }).select('id').single();
    if (error || !poll) return toastError(describeDbError(error, 'Could not create'));
    const { error: oErr } = await supabase.from('family_poll_options').insert(
      opts.map((o, i) => ({
        family_id: familyId, poll_id: poll.id, label: o.label.trim(), sort: i,
        cost_cents: o.cost.trim() ? Math.round(Number(o.cost) * 100) : null,
        travel_minutes: o.travel.trim() ? Math.round(Number(o.travel)) : null,
        tags: parseTags(o.tags),
      })),
    );
    if (oErr) return toastError(describeDbError(oErr));
    success('Poll created');
    setForm(null);
  }

  async function vote(poll: Poll, optionId: string) {
    if (!meId) return toastError('Join the family as a member to vote');
    const supabase = createClient();
    const pollVotes = votesByPoll.get(poll.id) ?? [];
    const mine = memberSelections(pollVotes as VoteLike[], meId);
    if (mine.has(optionId)) {
      const { error: unErr } = await supabase.from('family_poll_votes').delete().eq('option_id', optionId).eq('member_id', meId);
      if (unErr) toastError(describeDbError(unErr));
      return;
    }
    if (poll.kind === 'single' && mine.size > 0) {
      // Clear the prior selection first; if this fails, do NOT insert or the
      // single-choice poll ends up with two votes for this member.
      const { error: clearErr } = await supabase.from('family_poll_votes').delete().eq('poll_id', poll.id).eq('member_id', meId);
      if (clearErr) return toastError(describeDbError(clearErr));
    }
    const { error } = await supabase.from('family_poll_votes').insert({ family_id: familyId, poll_id: poll.id, option_id: optionId, member_id: meId });
    if (error) toastError(describeDbError(error));
  }

  async function setStatus(id: string, status: string) {
    const { error } = await createClient().from('family_polls').update({ status }).eq('id', id);
    if (error) toastError(describeDbError(error));
  }
  async function remove(id: string) {
    if (!confirm('Delete this poll?')) return;
    const { error } = await createClient().from('family_polls').delete().eq('id', id);
    if (error) toastError(describeDbError(error)); else success('Deleted');
  }

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message="Could not load family voting data. Refresh and try again." onRetry={refresh} />;
  const all = polls ?? [];
  const budgetRows = budgets ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold"><Vote className="h-4 w-4 text-brand-text" /> Group Voting</h3>
          <p className="mt-0.5 text-xs text-muted">The family votes â€” Bubaly weighs it against your budget and needs, and recommends.</p>
        </div>
        <div className="flex items-center gap-2">
          <AiInsight kind="votes" iconOnly />
          <Button onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> New poll</Button>
        </div>
      </div>

      {all.length === 0 ? (
        <EmptyState icon={Vote} title="No polls yet" description="Create a poll to make a collaborative family decision â€” a trip, a restaurant, a movie night. Add each option's cost and Bubaly will facilitate consensus." />
      ) : all.map((p) => {
        const opts = (optionsByPoll.get(p.id) ?? []) as Option[];
        const pollVotes = (votesByPoll.get(p.id) ?? []) as VoteRow[];
        const tally = tallyPoll(opts as OptionLike[], pollVotes as VoteLike[]);
        const mine = meId ? memberSelections(pollVotes as VoteLike[], meId) : new Set<string>();
        const closed = isPollClosed(p.status, p.closes_at);
        const vac = vacationName(p.vacation_id);

        // â”€â”€ AI facilitation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const budgetCents = typeof p.budget_cents === 'number'
          ? p.budget_cents
          : budgetCapForCategory(p.decision_category, budgetRows);
        const requiredTags = p.required_tags ?? [];
        const consensusOptions: ConsensusOption[] = opts.map((o) => ({
          id: o.id, label: o.label,
          votes: pollVotes.filter((v) => v.option_id === o.id).length,
          costCents: o.cost_cents ?? undefined,
          travelMinutes: o.travel_minutes ?? undefined,
          tags: o.tags ?? [],
        }));
        const consensus = facilitateConsensus(consensusOptions, {
          budgetCents: budgetCents ?? undefined,
          requiredTags,
        });
        const rankById = new Map(consensus.ranked.map((r) => [r.id, r]));
        const hasMetrics = opts.some((o) => o.cost_cents != null || o.travel_minutes != null || (o.tags ?? []).length > 0);
        const facilitated = hasMetrics || typeof budgetCents === 'number' || requiredTags.length > 0;

        return (
          <div key={p.id} className="rounded-2xl border border-border bg-surface/40 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold">{p.question}</p>
                  {p.decision_category !== 'general' && (
                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">{CATEGORY_LABEL[p.decision_category] ?? p.decision_category}</span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  {p.kind === 'multi' ? 'Multiple choice' : 'Single choice'} Â· {voterCount(pollVotes as VoteLike[])} voted
                  {vac ? <> Â· <Plane className="inline h-3 w-3" /> {vac}</> : ''}
                  {typeof budgetCents === 'number' ? <> Â· <DollarSign className="inline h-3 w-3" /> budget {usd(budgetCents)}{p.budget_cents == null ? ' (from your budget)' : ''}</> : ''}
                  {requiredTags.length > 0 ? <> Â· <Leaf className="inline h-3 w-3" /> {requiredTags.join(', ')}</> : ''}
                  {p.closes_at ? ` Â· closes ${fmtDate(p.closes_at)}` : ''}
                  {closed && <span className="ml-1 inline-flex items-center gap-1 text-amber-500"><Lock className="h-3 w-3" /> closed</span>}
                </p>
                {p.description && <p className="mt-1 text-sm text-muted">{p.description}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs">
                <button onClick={() => setStatus(p.id, closed ? 'open' : 'closed')} className="text-muted hover:text-fg hover:underline">{closed ? 'Reopen' : 'Close'}</button>
                <button onClick={() => remove(p.id)} className="text-muted hover:text-danger" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>

            {/* AI consensus */}
            {facilitated && consensus.recommendation && (
              <div className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
                <div className="flex items-center gap-2 text-sm">
                  <Sparkles className="h-4 w-4 shrink-0 text-emerald-400" />
                  <span>
                    Bubaly recommends <strong>{consensus.recommendation.label}</strong> â€” {consensus.recommendation.rationale}
                  </span>
                </div>
                {consensus.totalVotes > 0 && (
                  <p className="mt-1 pl-6 text-xs text-emerald-300/80">
                    {consensus.consensusLevel >= 0.6 ? 'Strong agreement' : consensus.consensusLevel >= 0.4 ? 'Leaning one way' : 'Split vote'} Â· {consensus.totalVotes} vote{consensus.totalVotes === 1 ? '' : 's'} cast
                  </p>
                )}
                <div className="mt-2 pl-6">
                  <WhyThis
                    surface="voting" refId={p.id} refKind={p.decision_category}
                    explanation={explainConsensus({
                      label: consensus.recommendation.label,
                      rationale: consensus.recommendation.rationale,
                      votes: consensus.recommendation.votes,
                      votePct: consensus.recommendation.votePct,
                      blendedScore: consensus.recommendation.blendedScore,
                      totalVotes: consensus.totalVotes,
                      consensusLevel: consensus.consensusLevel,
                      budgetCents: budgetCents ?? null,
                    })}
                  />
                </div>
              </div>
            )}
            {facilitated && consensus.conflicts.map((c, i) => (
              <div key={i} className="mt-2 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                <span>{c}</span>
              </div>
            ))}

            <div className="mt-3 space-y-2">
              {tally.map((t) => {
                const selected = mine.has(t.optionId);
                const opt = opts.find((o) => o.id === t.optionId);
                const rank = rankById.get(t.optionId);
                const isRec = consensus.recommendation?.id === t.optionId;
                return (
                  <button
                    key={t.optionId}
                    onClick={() => !closed && vote(p, t.optionId)}
                    disabled={closed}
                    className={cn(
                      'relative block w-full overflow-hidden rounded-lg border px-3 py-2 text-left text-sm transition',
                      selected ? 'border-brand' : rank && !rank.feasible ? 'border-rose-500/40' : isRec ? 'border-emerald-500/40' : 'border-border',
                      closed ? 'cursor-default' : 'hover:border-brand/60',
                    )}
                  >
                    <span className="absolute inset-y-0 left-0 bg-brand/10" style={{ width: `${t.pct}%` }} aria-hidden />
                    <span className="relative flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        {selected && <Check className="h-3.5 w-3.5 text-brand-text" />}
                        {isRec && <Sparkles className="h-3.5 w-3.5 text-emerald-400" />}
                        {t.leading && t.count > 0 && <Trophy className="h-3.5 w-3.5 text-amber-500" />}
                        {t.label}
                      </span>
                      <span className="text-muted">{t.count} Â· {t.pct}%</span>
                    </span>
                    {facilitated && (opt?.cost_cents != null || opt?.travel_minutes != null || (opt?.tags?.length ?? 0) > 0 || (rank && !rank.feasible)) && (
                      <span className="relative mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                        {opt?.cost_cents != null && <span className="inline-flex items-center gap-1"><DollarSign className="h-3 w-3" />{usd(opt.cost_cents)}</span>}
                        {opt?.travel_minutes != null && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{opt.travel_minutes}m</span>}
                        {(opt?.tags ?? []).map((tag) => <span key={tag} className="rounded-full bg-muted/10 px-1.5 py-0.5">{tag}</span>)}
                        {rank && !rank.feasible && <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-1.5 py-0.5 text-rose-300">{rank.violations[0]}</span>}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {!meId && <p className="mt-2 text-xs text-muted">You need a family member profile to vote.</p>}
          </div>
        );
      })}

      {form && (
        <Modal open onClose={() => setForm(null)} title="New poll">
          <form onSubmit={createPoll} className="space-y-3">
            <Field label="Question">{(id) => <Input id={id} value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} placeholder="Where should we go this summer?" />}</Field>
            <Field label="Description (optional)">{(id) => <Textarea id={id} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">{(id) => <Select id={id} value={form.decision_category} onChange={(e) => setForm({ ...form, decision_category: e.target.value })}>{Object.entries(CATEGORY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field>
              <Field label="Type">{(id) => <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="single">Single choice</option><option value="multi">Multiple choice</option></Select>}</Field>
              <Field label="Budget cap ($, optional)">{(id) => <Input id={id} type="number" min="0" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} placeholder="uses your budget if blank" />}</Field>
              <Field label="Closes (optional)">{(id) => <Input id={id} type="datetime-local" value={form.closes_at} onChange={(e) => setForm({ ...form, closes_at: e.target.value })} />}</Field>
            </div>
            <Field label="Required tags (optional, comma-separated)">{(id) => <Input id={id} value={form.required_tags} onChange={(e) => setForm({ ...form, required_tags: e.target.value })} placeholder="vegetarian, gluten-free" />}</Field>
            {(vacations ?? []).length > 0 && (
              <Field label="Link to a trip (optional)">{(id) => <Select id={id} value={form.vacation_id} onChange={(e) => setForm({ ...form, vacation_id: e.target.value })}><option value="">â€” None â€”</option>{(vacations ?? []).map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}</Select>}</Field>
            )}
            <Field label="Options">
              {() => (
                <div className="space-y-2">
                  {form.options.map((opt, i) => (
                    <div key={i} className="rounded-lg border border-border p-2">
                      <div className="flex gap-2">
                        <Input value={opt.label} onChange={(e) => { const o = [...form.options]; o[i] = { ...o[i], label: e.target.value }; setForm({ ...form, options: o }); }} placeholder={`Option ${i + 1}`} />
                        {form.options.length > 2 && <button type="button" onClick={() => setForm({ ...form, options: form.options.filter((_, j) => j !== i) })} className="text-muted hover:text-danger" aria-label="Remove option"><Trash2 className="h-4 w-4" /></button>}
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2">
                        <Input type="number" min="0" value={opt.cost} onChange={(e) => { const o = [...form.options]; o[i] = { ...o[i], cost: e.target.value }; setForm({ ...form, options: o }); }} placeholder="Cost $" aria-label={`Option ${i + 1} cost`} />
                        <Input type="number" min="0" value={opt.travel} onChange={(e) => { const o = [...form.options]; o[i] = { ...o[i], travel: e.target.value }; setForm({ ...form, options: o }); }} placeholder="Travel min" aria-label={`Option ${i + 1} travel`} />
                        <Input value={opt.tags} onChange={(e) => { const o = [...form.options]; o[i] = { ...o[i], tags: e.target.value }; setForm({ ...form, options: o }); }} placeholder="tags" aria-label={`Option ${i + 1} tags`} />
                      </div>
                    </div>
                  ))}
                  <button type="button" onClick={() => setForm({ ...form, options: [...form.options, blankOption()] })} className="text-xs font-semibold text-brand-text">+ Add option</button>
                </div>
              )}
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit">Create poll</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
