'use client';

// Family Decision Engine — score trade-offs, explain the reasoning, let the family
// decide. Decisions + options are real, family-scoped Supabase rows; the scoring is
// the pure engine in lib/decisions/engine.ts, run live as you edit and cached on the
// rows when you save. 100% Supabase + realtime.
import { useMemo, useState } from 'react';
import {
  Scale, Plus, Trophy, Check, Trash2, Sparkles, DollarSign, Clock, MapPin, Gauge, Star,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ErrorState, SkeletonList } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import { evaluateDecision, type OptionInput, type Criterion } from '@/lib/decisions/engine';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Decision = Tables<'family_decisions'>;
type Option = Tables<'decision_options'>;

const num = (v: number | null | undefined): number | undefined => (typeof v === 'number' ? v : undefined);

export function DecisionsModule() {
  const t = useTranslations();
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const { data: decisions, loading: ld, error: decisionsError, refresh: refreshDecisions } = useRealtimeQuery<Decision>({
    table: 'family_decisions', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_decisions').select('*').eq('family_id', familyId).order('updated_at', { ascending: false }),
  });
  const { data: options, loading: lo, error: optionsError, refresh: refreshOptions } = useRealtimeQuery<Option>({
    table: 'decision_options', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('decision_options').select('*').eq('family_id', familyId),
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = (decisions ?? []).find((d) => d.id === selectedId) ?? (decisions ?? [])[0] ?? null;
  const myOptions = useMemo(
    () => (options ?? []).filter((o) => o.decision_id === selected?.id),
    [options, selected?.id],
  );

  // Live scoring via the pure engine.
  const result = useMemo(() => {
    if (!selected) return null;
    const inputs: OptionInput[] = myOptions.map((o) => ({
      id: o.id, label: o.label,
      costCents: num(o.cost_cents), timeMinutes: num(o.time_minutes),
      travelMinutes: num(o.travel_minutes), loadDelta: num(o.load_delta), benefit: num(o.benefit),
    }));
    return evaluateDecision(inputs, {
      budgetCents: num(selected.budget_cents),
      maxTravelMinutes: num(selected.max_travel_minutes),
      weights: (selected.weights as Partial<Record<Criterion, number>>) ?? {},
    });
  }, [selected, myOptions]);

  const [addDecision, setAddDecision] = useState(false);
  const [addOption, setAddOption] = useState(false);

  async function saveScores() {
    if (!selected || !result) return;
    const sb = createClient();
    const updates = result.ranked.map((r) =>
      sb.from('decision_options').update({ score: r.score, rationale: r.rationale, feasible: r.feasible }).eq('id', r.id),
    );
    const results = await Promise.all(updates);
    const err = results.find((x) => x.error)?.error;
    if (err) { toastError(describeDbError(err)); return; }
    success(t('decisionsModule.scoresSavedToTheDecision'));
  }

  async function choose(optionId: string) {
    if (!selected) return;
    const sb = createClient();
    const { error } = await sb.from('family_decisions')
      .update({ decided_option_id: optionId, status: 'decided' }).eq('id', selected.id);
    if (error) { toastError(describeDbError(error)); return; }
    success(t('decisionsModule.decisionRecorded'));
  }

  const loading = ld || lo;
  const readError = decisionsError || optionsError;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('decisions.decisionEngine')}
        description={t('decisionsModule.weighTheTradeOffsSee')}
        action={<Button onClick={() => setAddDecision(true)}><Plus className="size-4" /> {t('decisions.newDecision')}</Button>}
      />

      {loading ? (
        <SkeletonList count={4} />
      ) : readError ? (
        <ErrorState message={t('decisionsModule.couldNotLoadDecisionData')} onRetry={() => { void refreshDecisions(); void refreshOptions(); }} />
      ) : (decisions ?? []).length === 0 ? (
        <EmptyState onAdd={() => setAddDecision(true)} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Decisions list */}
          <div className="space-y-1 lg:col-span-1">
            {(decisions ?? []).map((d) => (
              <button
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                className={cn(
                  'flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition',
                  selected?.id === d.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/5',
                )}
              >
                <span className="truncate">{d.question}</span>
                {d.status === 'decided' && <Trophy className="ml-2 size-4 shrink-0 text-amber-400" />}
              </button>
            ))}
          </div>

          {/* Selected decision */}
          <div className="space-y-4 lg:col-span-2">
            {selected && (
              <>
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-base font-semibold">{selected.question}</h2>
                      {selected.detail && <p className="mt-0.5 text-sm text-muted">{selected.detail}</p>}
                    </div>
                    <Button variant="secondary" onClick={() => setAddOption(true)}><Plus className="size-4" /> {t('decisions.option')}</Button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted">
                    {typeof selected.budget_cents === 'number' && (
                      <span className="rounded-full border border-border px-2 py-0.5">{t('decisions.budget')}{(selected.budget_cents / 100).toFixed(0)}</span>
                    )}
                    {typeof selected.max_travel_minutes === 'number' && (
                      <span className="rounded-full border border-border px-2 py-0.5">{t('decisions.travel')} {selected.max_travel_minutes}m</span>
                    )}
                  </div>
                </div>

                {myOptions.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted">
                    {t('decisions.addTwoOrMoreOptionsTo')}
                  </div>
                ) : (
                  <>
                    {result?.recommendation && (
                      <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
                        <Sparkles className="size-4 shrink-0 text-emerald-300" />
                        <span>
                          Recommended: <strong>{result.recommendation.label}</strong> — {result.recommendation.rationale}
                        </span>
                      </div>
                    )}
                    <div className="space-y-2">
                      {result?.ranked.map((r, i) => {
                        const opt = myOptions.find((o) => o.id === r.id)!;
                        const isWinner = selected.decided_option_id === r.id;
                        return (
                          <div key={r.id} className={cn(
                            'rounded-xl border p-4',
                            isWinner ? 'border-amber-400/50 bg-amber-400/5' : r.feasible ? 'border-border bg-card' : 'border-rose-500/30 bg-rose-500/5',
                          )}>
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2">
                                <span className="flex size-6 items-center justify-center rounded-full bg-muted/10 text-xs font-semibold">{i + 1}</span>
                                <span className="font-medium">{opt.label}</span>
                                {isWinner && <Trophy className="size-4 text-amber-400" />}
                                {!r.feasible && <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] text-rose-300">{t('decisions.doesnAposTFit')}</span>}
                              </div>
                              <div className="flex items-center gap-3">
                                <span className="text-sm font-semibold tabular-nums">{r.score}</span>
                                <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted/10">
                                  <div className={cn('h-full rounded-full', r.feasible ? 'bg-primary' : 'bg-rose-400')} style={{ width: `${r.score}%` }} />
                                </div>
                              </div>
                            </div>
                            <p className="mt-2 text-xs text-muted">{r.rationale}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted">
                              {typeof opt.cost_cents === 'number' && <span className="flex items-center gap-1"><DollarSign className="size-3" />{(opt.cost_cents / 100).toFixed(0)}</span>}
                              {typeof opt.time_minutes === 'number' && <span className="flex items-center gap-1"><Clock className="size-3" />{opt.time_minutes}m</span>}
                              {typeof opt.travel_minutes === 'number' && <span className="flex items-center gap-1"><MapPin className="size-3" />{opt.travel_minutes}m</span>}
                              {typeof opt.load_delta === 'number' && <span className="flex items-center gap-1"><Gauge className="size-3" />load {opt.load_delta}</span>}
                              {typeof opt.benefit === 'number' && <span className="flex items-center gap-1"><Star className="size-3" />benefit {opt.benefit}</span>}
                              {!isWinner && (
                                <button onClick={() => choose(r.id)} className="ml-auto rounded-full border border-border px-2.5 py-1 hover:bg-muted/5">
                                  <Check className="mr-1 inline size-3" />{t('decisions.choose')}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex justify-end">
                      <Button variant="secondary" onClick={saveScores}>{t('decisions.saveScores')}</Button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {addDecision && (
        <AddDecisionModal familyId={familyId} userId={userId}
          onClose={() => setAddDecision(false)}
          onSaved={(id) => { setSelectedId(id); setAddDecision(false); success(t('decisionsModule.decisionCreated')); }}
          onError={toastError} />
      )}
      {addOption && selected && (
        <AddOptionModal familyId={familyId} userId={userId} decisionId={selected.id}
          onClose={() => setAddOption(false)}
          onSaved={() => { setAddOption(false); success(t('decisionsModule.optionAdded')); }}
          onError={toastError} />
      )}
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  const t = useTranslations();
  return (
    <div className="rounded-xl border border-dashed border-border p-10 text-center">
      <Scale className="mx-auto mb-3 size-8 text-muted" />
      <h3 className="mb-1 text-base font-semibold">{t('decisions.decideTheHardOnesTogether')}</h3>
      <p className="mx-auto mb-4 max-w-md text-sm text-muted">{t('decisionsModule.whichVacationFitsTheBudget')}</p>
      <Button onClick={onAdd}><Plus className="size-4" /> {t('decisions.newDecision')}</Button>
    </div>
  );
}

function AddDecisionModal({ familyId, userId, onClose, onSaved, onError }: {
  familyId: string; userId: string | null; onClose: () => void; onSaved: (id: string) => void; onError: (m: string) => void;
}) {
  const t = useTranslations();
  const [question, setQuestion] = useState('');
  const [detail, setDetail] = useState('');
  const [budget, setBudget] = useState('');
  const [maxTravel, setMaxTravel] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q) { onError(t('decisionsModule.askTheQuestionFirst')); return; }
    setSaving(true);
    const sb = createClient();
    const { data, error } = await sb.from('family_decisions').insert({
      family_id: familyId, question: q, detail: detail.trim() || null,
      budget_cents: budget ? Math.round(Number(budget) * 100) : null,
      max_travel_minutes: maxTravel ? Math.round(Number(maxTravel)) : null,
      created_by: userId,
    }).select('id').single();
    setSaving(false);
    if (error || !data) { onError(describeDbError(error)); return; }
    onSaved(data.id);
  }
  return (
    <Modal open onClose={onClose} title={t('decisions.newDecision')}>
      <form onSubmit={submit} className="space-y-3">
        <Field label={t('decisions.question')}>{(id) => <Input id={id} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t('decisions.whichVacationThisSummer')} autoFocus />}</Field>
        <Field label={t('decisions.detailOptional')}>{(id) => <Input id={id} value={detail} onChange={(e) => setDetail(e.target.value)} placeholder={t('decisions.lateJulyEveryoneFree')} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('decisions.budgetCapOptional')}>{(id) => <Input id={id} type="number" min="0" value={budget} onChange={(e) => setBudget(e.target.value)} />}</Field>
          <Field label={t('decisions.maxTravelMinOptional')}>{(id) => <Input id={id} type="number" min="0" value={maxTravel} onChange={(e) => setMaxTravel(e.target.value)} />}</Field>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('decisions.cancel')}</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Creating…' : 'Create'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function AddOptionModal({ familyId, userId, decisionId, onClose, onSaved, onError }: {
  familyId: string; userId: string | null; decisionId: string; onClose: () => void; onSaved: () => void; onError: (m: string) => void;
}) {
  const t = useTranslations();
  const [label, setLabel] = useState('');
  const [cost, setCost] = useState('');
  const [time, setTime] = useState('');
  const [travel, setTravel] = useState('');
  const [load, setLoad] = useState('');
  const [benefit, setBenefit] = useState('');
  const [saving, setSaving] = useState(false);
  const optNum = (v: string) => (v.trim() === '' ? null : Number(v));
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const l = label.trim();
    if (!l) { onError(t('decisionsModule.nameTheOption')); return; }
    setSaving(true);
    const sb = createClient();
    const { error } = await sb.from('decision_options').insert({
      family_id: familyId, decision_id: decisionId, label: l,
      cost_cents: cost ? Math.round(Number(cost) * 100) : null,
      time_minutes: optNum(time), travel_minutes: optNum(travel),
      load_delta: optNum(load), benefit: optNum(benefit), created_by: userId,
    });
    setSaving(false);
    if (error) { onError(describeDbError(error)); return; }
    onSaved();
  }
  return (
    <Modal open onClose={onClose} title={t('decisions.addOption')}>
      <form onSubmit={submit} className="space-y-3">
        <Field label={t('decisions.option')}>{(id) => <Input id={id} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('decisions.beachWeek')} autoFocus />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('decisions.cost')}>{(id) => <Input id={id} type="number" min="0" value={cost} onChange={(e) => setCost(e.target.value)} />}</Field>
          <Field label={t('decisions.effortMin')}>{(id) => <Input id={id} type="number" min="0" value={time} onChange={(e) => setTime(e.target.value)} />}</Field>
          <Field label={t('decisions.travelMin')}>{(id) => <Input id={id} type="number" min="0" value={travel} onChange={(e) => setTravel(e.target.value)} />}</Field>
          <Field label={t('decisions.familyLoad0100')}>{(id) => <Input id={id} type="number" min="0" max="100" value={load} onChange={(e) => setLoad(e.target.value)} />}</Field>
          <Field label={t('decisions.benefit0100')}>{(id) => <Input id={id} type="number" min="0" max="100" value={benefit} onChange={(e) => setBenefit(e.target.value)} />}</Field>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('decisions.cancel')}</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add'}</Button>
        </div>
      </form>
    </Modal>
  );
}

