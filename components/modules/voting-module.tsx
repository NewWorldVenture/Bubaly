'use client';

import { useMemo, useState } from 'react';
import { Vote, Plus, Trash2, Check, Trophy, Lock, Plane } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SkeletonList, EmptyState } from '@/components/ui/states';
import { AiInsight } from '@/components/ai/ai-insight';
import { fmtDate } from '@/lib/utils/format';
import { tallyPoll, voterCount, memberSelections, isPollClosed, type VoteLike, type OptionLike } from '@/lib/voting/polls';
import type { Tables } from '@/lib/database.types';

type Poll = Tables<'family_polls'>;
type Option = Tables<'family_poll_options'>;
type VoteRow = Tables<'family_poll_votes'>;
type VacationLite = { id: string; title: string };

const blank = () => ({ question: '', description: '', kind: 'single', vacation_id: '', closes_at: '', options: ['', ''] });

export function VotingModule() {
  const { familyId, userId, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const meId = selfMember?.id ?? null;

  const { data: polls, loading } = useRealtimeQuery<Poll>({
    table: 'family_polls', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_polls').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
  });
  const { data: options } = useRealtimeQuery<Option>({
    table: 'family_poll_options', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_poll_options').select('*').eq('family_id', familyId),
  });
  const { data: votes } = useRealtimeQuery<VoteRow>({
    table: 'family_poll_votes', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_poll_votes').select('*').eq('family_id', familyId),
  });
  const { data: vacations } = useRealtimeQuery<VacationLite>({
    table: 'vacations', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('vacations').select('id, title').eq('family_id', familyId).order('created_at', { ascending: false }),
  });

  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
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
    const opts = form.options.map((o) => o.trim()).filter(Boolean);
    if (opts.length < 2) return toastError('Add at least two options');
    const supabase = createClient();
    const { data: poll, error } = await supabase.from('family_polls').insert({
      family_id: familyId,
      vacation_id: form.vacation_id || null,
      question: form.question.trim(),
      description: form.description.trim() || null,
      kind: form.kind,
      closes_at: form.closes_at ? new Date(form.closes_at).toISOString() : null,
      created_by: userId,
    }).select('id').single();
    if (error || !poll) return toastError(describeDbError(error, 'Could not create'));
    const { error: oErr } = await supabase.from('family_poll_options').insert(
      opts.map((label, i) => ({ family_id: familyId, poll_id: poll.id, label, sort: i })),
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
      await supabase.from('family_poll_votes').delete().eq('option_id', optionId).eq('member_id', meId);
      return;
    }
    if (poll.kind === 'single' && mine.size > 0) {
      await supabase.from('family_poll_votes').delete().eq('poll_id', poll.id).eq('member_id', meId);
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
  const all = polls ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold"><Vote className="h-4 w-4 text-brand" /> Group Voting</h3>
        <div className="flex items-center gap-2">
          <AiInsight kind="votes" iconOnly />
          <Button onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> New poll</Button>
        </div>
      </div>

      {all.length === 0 ? (
        <EmptyState icon={Vote} title="No polls yet" description="Create a poll to make a collaborative family decision — a trip, a restaurant, a movie night." />
      ) : all.map((p) => {
        const opts = (optionsByPoll.get(p.id) ?? []) as OptionLike[];
        const pollVotes = (votesByPoll.get(p.id) ?? []) as VoteLike[];
        const tally = tallyPoll(opts, pollVotes);
        const mine = meId ? memberSelections(pollVotes, meId) : new Set<string>();
        const closed = isPollClosed(p.status, p.closes_at);
        const vac = vacationName(p.vacation_id);
        return (
          <div key={p.id} className="rounded-2xl border border-border bg-surface/40 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold">{p.question}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {p.kind === 'multi' ? 'Multiple choice' : 'Single choice'} · {voterCount(pollVotes)} voted
                  {vac ? <> · <Plane className="inline h-3 w-3" /> {vac}</> : ''}
                  {p.closes_at ? ` · closes ${fmtDate(p.closes_at)}` : ''}
                  {closed && <span className="ml-1 inline-flex items-center gap-1 text-amber-500"><Lock className="h-3 w-3" /> closed</span>}
                </p>
                {p.description && <p className="mt-1 text-sm text-muted">{p.description}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs">
                <button onClick={() => setStatus(p.id, closed ? 'open' : 'closed')} className="text-muted hover:text-fg hover:underline">{closed ? 'Reopen' : 'Close'}</button>
                <button onClick={() => remove(p.id)} className="text-muted hover:text-danger" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {tally.map((t) => {
                const selected = mine.has(t.optionId);
                return (
                  <button
                    key={t.optionId}
                    onClick={() => !closed && vote(p, t.optionId)}
                    disabled={closed}
                    className={`relative block w-full overflow-hidden rounded-lg border px-3 py-2 text-left text-sm transition ${selected ? 'border-brand' : 'border-border'} ${closed ? 'cursor-default' : 'hover:border-brand/60'}`}
                  >
                    <span className="absolute inset-y-0 left-0 bg-brand/10" style={{ width: `${t.pct}%` }} aria-hidden />
                    <span className="relative flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        {selected && <Check className="h-3.5 w-3.5 text-brand" />}
                        {t.leading && t.count > 0 && <Trophy className="h-3.5 w-3.5 text-amber-500" />}
                        {t.label}
                      </span>
                      <span className="text-muted">{t.count} · {t.pct}%</span>
                    </span>
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
              <Field label="Type">{(id) => <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="single">Single choice</option><option value="multi">Multiple choice</option></Select>}</Field>
              <Field label="Closes (optional)">{(id) => <Input id={id} type="datetime-local" value={form.closes_at} onChange={(e) => setForm({ ...form, closes_at: e.target.value })} />}</Field>
            </div>
            {(vacations ?? []).length > 0 && (
              <Field label="Link to a trip (optional)">{(id) => <Select id={id} value={form.vacation_id} onChange={(e) => setForm({ ...form, vacation_id: e.target.value })}><option value="">— None —</option>{(vacations ?? []).map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}</Select>}</Field>
            )}
            <Field label="Options">
              {() => (
                <div className="space-y-2">
                  {form.options.map((opt, i) => (
                    <div key={i} className="flex gap-2">
                      <Input value={opt} onChange={(e) => { const o = [...form.options]; o[i] = e.target.value; setForm({ ...form, options: o }); }} placeholder={`Option ${i + 1}`} />
                      {form.options.length > 2 && <button type="button" onClick={() => setForm({ ...form, options: form.options.filter((_, j) => j !== i) })} className="text-muted hover:text-danger"><Trash2 className="h-4 w-4" /></button>}
                    </div>
                  ))}
                  <button type="button" onClick={() => setForm({ ...form, options: [...form.options, ''] })} className="text-xs font-semibold text-brand">+ Add option</button>
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
