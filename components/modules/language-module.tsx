'use client';

import { useEffect, useMemo, useState } from 'react';
import { Languages, Plus, Check, Pencil, Trash2, Flame, Layers, Timer, Sparkles, RotateCcw, Wand2, PauseCircle, PlayCircle, Target, ChevronRight } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables, CefrLevel, LanguageSessionKind } from '@/lib/database.types';
import {
  CEFR, SESSION_KINDS, LANGUAGES, GRADES, cefrMeta, kindMeta, languageMeta, starterDeck, sm2, dueCards, deckStats, weekProgress, streak, levelEstimate, suggestToday, languageSummary, isoDate, type Grade,
} from '@/lib/language/practice';
import { useTranslations } from '@/components/i18n/locale-provider';

type Goal = Tables<'language_goals'>;
type Session = Tables<'language_sessions'>;
type Card = Tables<'vocab_cards'>;

const fmtDate = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function LanguageModule() {
  const tr = useTranslations();
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();

  const goals = useRealtimeQuery<Goal>({
    table: 'language_goals', familyId,
    fetcher: (s) => s.from('language_goals').select('*').eq('family_id', familyId).order('is_active', { ascending: false }).order('created_at'),
    deps: [familyId],
  });
  const sessions = useRealtimeQuery<Session>({
    table: 'language_sessions', familyId,
    fetcher: (s) => s.from('language_sessions').select('*').eq('family_id', familyId).order('practiced_on', { ascending: false }).limit(800),
    deps: [familyId],
  });
  const cards = useRealtimeQuery<Card>({
    table: 'vocab_cards', familyId,
    fetcher: (s) => s.from('vocab_cards').select('*').eq('family_id', familyId).order('due_on').limit(2000),
    deps: [familyId],
  });

  const [goalId, setGoalId] = useState('');
  useEffect(() => {
    if (goals.data.length && !goals.data.some((g) => g.id === goalId)) {
      setGoalId((goals.data.find((g) => g.is_active && g.member_id === selfMember?.id) ?? goals.data.find((g) => g.is_active) ?? goals.data[0]).id);
    }
  }, [goals.data, goalId, selfMember]);
  const [goalForm, setGoalForm] = useState<{ open: boolean; goal: Goal | null }>({ open: false, goal: null });
  const [cardForm, setCardForm] = useState<{ open: boolean; card: Card | null }>({ open: false, card: null });
  const [sessionOpen, setSessionOpen] = useState(false);
  const [tab, setTab] = useState<'review' | 'cards' | 'sessions'>('review');
  const [revealed, setRevealed] = useState(false);
  const [reviewedCount, setReviewedCount] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);

  const today = useMemo(() => new Date(), []);
  const goal = goals.data.find((g) => g.id === goalId) ?? null;
  const myCards = useMemo(() => cards.data.filter((c) => c.goal_id === goalId), [cards.data, goalId]);
  const mySessions = useMemo(() => sessions.data.filter((s) => s.goal_id === goalId), [sessions.data, goalId]);
  const queue = useMemo(() => (goal ? dueCards(myCards, goal.id, today) : []), [myCards, goal, today]);
  const deck = useMemo(() => (goal ? deckStats(myCards, goal.id, today) : null), [myCards, goal, today]);
  const week = useMemo(() => (goal ? weekProgress(mySessions, goal, today) : null), [mySessions, goal, today]);
  const run = useMemo(() => (goal ? streak(mySessions, goal.id, today) : 0), [mySessions, goal, today]);
  const level = useMemo(() => (goal ? levelEstimate(goal, mySessions) : null), [goal, mySessions]);
  const suggestion = useMemo(() => (goal ? suggestToday(goal, mySessions, myCards, today) : null), [goal, mySessions, myCards, today]);
  const summary = useMemo(() => languageSummary(goals.data, sessions.data, cards.data, today), [goals.data, sessions.data, cards.data, today]);
  const nameOf = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? 'Member';
  const current = queue[0] ?? null;
  const visibleGoals = goals.data.filter((g) => g.is_active || showArchived || g.id === goalId);

  async function gradeCard(c: Card, grade: Grade) {
    const next = sm2(c, grade, new Date());
    const { error } = await createClient().from('vocab_cards').update(next).eq('id', c.id);
    if (error) return toastError(describeDbError(error));
    setRevealed(false);
    setReviewedCount((n) => n + 1);
  }

  async function finishReview() {
    if (!goal || !reviewedCount) return;
    const minutes = Math.max(1, Math.round(reviewedCount / 4));
    const { error } = await createClient().from('language_sessions').insert({ family_id: familyId, goal_id: goal.id, member_id: goal.member_id, kind: 'vocab', minutes, topic: `${reviewedCount} cards reviewed`, practiced_on: isoDate(new Date()), created_by: userId });
    if (error) return toastError(describeDbError(error));
    success(`${reviewedCount} cards reviewed · ${minutes} min logged`);
    setReviewedCount(0);
  }

  async function toggleSuspend(c: Card) {
    const { error } = await createClient().from('vocab_cards').update({ is_suspended: !c.is_suspended }).eq('id', c.id);
    if (error) return toastError(describeDbError(error));
  }

  async function deleteCard(c: Card) {
    const { error } = await createClient().from('vocab_cards').delete().eq('id', c.id);
    if (error) return toastError(describeDbError(error));
    success('Card removed');
  }

  async function addStarterDeck() {
    if (!goal) return;
    const deckCards = starterDeck(goal.language_code);
    if (!deckCards.length) return toastError(`No starter deck for ${goal.language_label} yet — add cards by hand.`);
    const have = new Set(myCards.map((c) => c.term.toLowerCase()));
    const fresh = deckCards.filter((c) => !have.has(c.term.toLowerCase()));
    if (!fresh.length) return toastError('The starter deck is already in.');
    setAdding(true);
    const { error } = await createClient().from('vocab_cards').insert(fresh.map((c) => ({ family_id: familyId, goal_id: goal.id, term: c.term, translation: c.translation, example: c.example ?? null, part_of_speech: c.pos ?? null, tags: ['starter'], due_on: isoDate(new Date()), created_by: userId })));
    setAdding(false);
    if (error) return toastError(describeDbError(error));
    success(`${fresh.length} starter cards added`);
  }

  async function deleteSession(s: Session) {
    const { error } = await createClient().from('language_sessions').delete().eq('id', s.id);
    if (error) return toastError(describeDbError(error));
    success('Session removed');
  }

  async function archiveGoal(g: Goal, active: boolean) {
    const { error } = await createClient().from('language_goals').update({ is_active: active }).eq('id', g.id);
    if (error) return toastError(describeDbError(error));
    success(active ? 'Goal reopened' : 'Goal archived');
  }

  async function deleteGoal(g: Goal) {
    if (!confirm(`Delete ${nameOf(g.member_id)}’s ${g.language_label} goal with every card and session?`)) return;
    const { error } = await createClient().from('language_goals').delete().eq('id', g.id);
    if (error) return toastError(describeDbError(error));
    setGoalId('');
    success('Goal deleted');
  }

  const loading = goals.loading || sessions.loading || cards.loading;
  const error = goals.error || sessions.error || cards.error;
  const refresh = () => { void goals.refresh(); void sessions.refresh(); void cards.refresh(); };
  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={tr('languageModule.couldNotLoadLanguagePractice')} onRetry={refresh} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title={tr('language.languagePractice')}
        description={tr('languageModule.kidsAndParentsLearningA')}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <AiInsight kind="language" iconOnly />
            {goal && <Button variant="secondary" onClick={() => setSessionOpen(true)}><Timer className="h-4 w-4" /> {tr('language.logPractice')}</Button>}
            {goal && <Button variant="secondary" onClick={() => setCardForm({ open: true, card: null })}><Plus className="h-4 w-4" /> {tr('language.card')}</Button>}
            <Button variant={goal ? 'ghost' : 'primary'} onClick={() => setGoalForm({ open: true, goal: null })}><Languages className="h-4 w-4" /> {goal ? 'New goal' : 'Start a language'}</Button>
          </div>
        }
      />

      {goals.data.length === 0 || !goal || !deck || !week || !level || !suggestion ? (
        <EmptyState icon={Languages} title={tr('language.noLanguageGoalsYet')} description={tr('languageModule.pickWhoIsLearningWhat')} action={<Button onClick={() => setGoalForm({ open: true, goal: null })}><Languages className="h-4 w-4" /> {tr('language.startALanguage')}</Button>} />
      ) : (
        <>
          {goals.data.length > 1 && (
            <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label={tr('language.languageGoal')}>
              {visibleGoals.map((g) => (
                <button key={g.id} role="tab" aria-selected={g.id === goalId} onClick={() => { setGoalId(g.id); setRevealed(false); }} className={cn('rounded-full border px-3 py-1.5 text-sm transition coarse:min-h-11', g.id === goalId ? 'border-brand bg-brand/15 text-brand-text' : 'border-border bg-surface/40 text-muted hover:text-fg', !g.is_active && 'opacity-60')}>
                  {languageMeta(g.language_code).flag} {nameOf(g.member_id)} <span className="text-xs opacity-70">· {g.language_label}</span>
                </button>
              ))}
              {goals.data.some((g) => !g.is_active) && <button onClick={() => setShowArchived((v) => !v)} className="text-xs text-muted hover:text-fg">{showArchived ? 'Hide' : 'Show'} archived</button>}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-4">
            <div className={cn('rounded-2xl border p-5', week.pct >= 100 ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-border bg-surface/40')}>
              <div className="flex items-center gap-2 text-sm font-semibold"><Timer className="h-4 w-4 text-brand-text" /> {tr('language.thisWeek')}</div>
              <p className="mt-2 text-2xl font-bold">{week.minutes}<span className="text-sm font-normal text-muted"> / {week.goal} min</span></p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full bg-brand" style={{ width: `${week.pct}%` }} /></div>
              <p className="mt-1 text-xs text-muted">{week.days} day{week.days === 1 ? '' : 's'} · {week.sessions} session{week.sessions === 1 ? '' : 's'}{week.avgScore !== null ? ` · avg score ${week.avgScore}` : ''}</p>
            </div>
            <div className={cn('rounded-2xl border p-5', run >= 7 ? 'border-amber-500/30 bg-amber-500/10' : 'border-border bg-surface/40')}>
              <div className="flex items-center gap-2 text-sm font-semibold"><Flame className="h-4 w-4 text-brand-text" /> {tr('language.streak')}</div>
              <p className="mt-2 text-2xl font-bold">{run}<span className="text-sm font-normal text-muted"> day{run === 1 ? '' : 's'}</span></p>
              <p className="mt-1 text-xs text-muted">{summary.longestStreak > run ? `Family best: ${summary.longestStreak}` : run ? 'Family best right here' : 'Practise today to start one'}</p>
            </div>
            <div className={cn('rounded-2xl border p-5', deck.due >= 10 ? 'border-amber-500/30 bg-amber-500/10' : 'border-border bg-surface/40')}>
              <div className="flex items-center gap-2 text-sm font-semibold"><Layers className="h-4 w-4 text-brand-text" /> {tr('language.deck')}</div>
              <p className="mt-2 text-2xl font-bold">{deck.due}<span className="text-sm font-normal text-muted"> due</span></p>
              <p className="mt-1 text-xs text-muted">{deck.total} {tr('language.cards')} {deck.new} {tr('language.new')} {deck.mature} mature{deck.retention !== null ? ` · ${deck.retention}% retention` : ''}</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface/40 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold"><Target className="h-4 w-4 text-brand-text" /> {cefrMeta(goal.current_level).value} → {goal.target_level}</div>
              <p className="mt-2 text-2xl font-bold">{level.pct}%</p>
              <p className="mt-1 text-xs text-muted">{level.hoursDone}{tr('language.hLogged')}{level.hoursToTarget}{tr('language.hTo')} {goal.target_level}{level.weeksAtGoal ? ` · ${level.weeksAtGoal} weeks at this pace` : ''}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-brand/20 bg-brand/5 p-4">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-semibold text-brand-text"><Sparkles className="h-4 w-4" /> Today: {suggestion.title}</p>
              <p className="mt-1 text-sm text-muted">{suggestion.detail}</p>
            </div>
            <div className="flex items-center gap-2">
              {suggestion.kind === 'vocab' ? <Button size="sm" onClick={() => setTab('review')}><Layers className="h-3.5 w-3.5" /> {tr('language.review')}</Button>
                : suggestion.kind === 'tutor' ? <AiInsight kind="language" />
                : <Button size="sm" variant="secondary" onClick={() => setSessionOpen(true)}><Timer className="h-3.5 w-3.5" /> Log {suggestion.minutes} min</Button>}
              <button onClick={() => setGoalForm({ open: true, goal })} aria-label={tr('language.editGoal')} className="rounded-lg p-1.5 text-muted hover:text-fg"><Pencil className="h-4 w-4" /></button>
              <button onClick={() => archiveGoal(goal, !goal.is_active)} aria-label={goal.is_active ? 'Archive goal' : 'Reopen goal'} className="rounded-lg p-1.5 text-muted hover:text-fg">{goal.is_active ? <PauseCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}</button>
              <button onClick={() => deleteGoal(goal)} aria-label={tr('language.deleteGoal')} className="rounded-lg p-1.5 text-muted hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
            </div>
          </div>

          <div className="flex items-center gap-2 border-b border-border" role="tablist">
            {([['review', `Review (${deck.due})`], ['cards', `Cards (${deck.total})`], ['sessions', `Practice log (${mySessions.length})`]] as const).map(([key, label]) => (
              <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={cn('-mb-px border-b-2 px-3 py-2 text-sm coarse:min-h-11', tab === key ? 'border-brand text-brand-text' : 'border-transparent text-muted hover:text-fg')}>{label}</button>
            ))}
            {tab === 'cards' && starterDeck(goal.language_code).length > 0 && <Button size="sm" variant="secondary" className="ml-auto mb-1" onClick={addStarterDeck} loading={adding}><Wand2 className="h-3.5 w-3.5" /> {tr('language.starterDeck')}</Button>}
          </div>

          {tab === 'review' && (
            current ? (
              <div className="mx-auto max-w-xl">
                <div className="rounded-3xl border border-border bg-surface/40 p-8 text-center">
                  <p className="text-xs text-muted">{current.repetitions === 0 && current.lapses === 0 ? 'New card' : `Seen ${current.repetitions + current.lapses}× · every ${current.interval_days}d`} · {queue.length} left</p>
                  <p className="mt-4 text-3xl font-bold">{current.term}</p>
                  {current.part_of_speech && <p className="mt-1 text-xs text-muted">{current.part_of_speech}</p>}
                  {revealed ? (
                    <>
                      <p className="mt-6 text-xl text-brand-text">{current.translation}</p>
                      {current.example && <p className="mt-2 text-sm italic text-muted">{current.example}</p>}
                      <div className="mt-6 grid grid-cols-4 gap-2">
                        {GRADES.map((g) => (
                          <button key={g.value} onClick={() => gradeCard(current, g.value)} className={cn('rounded-xl border px-2 py-3 text-sm coarse:min-h-12', g.value === 1 ? 'border-rose-500/30 hover:bg-rose-500/10' : g.value === 5 ? 'border-emerald-500/30 hover:bg-emerald-500/10' : 'border-border hover:bg-surface')}>
                            <span className="block font-semibold">{g.label}</span>
                            <span className="block text-[10px] text-muted">{sm2(current, g.value, today).interval_days}d</span>
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <Button className="mt-6" onClick={() => setRevealed(true)}><RotateCcw className="h-4 w-4" /> {tr('language.showAnswer')}</Button>
                  )}
                </div>
                {reviewedCount > 0 && <p className="mt-3 text-center text-xs text-muted">{reviewedCount} {tr('language.reviewedThisSitting')} <button onClick={finishReview} className="text-brand-text hover:underline">{tr('language.logItAsPractice')}</button></p>}
              </div>
            ) : (
              <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-6 text-center">
                <p className="font-semibold">{tr('language.deckClearForToday')}</p>
                <p className="mt-1 text-sm text-muted">{deck.total === 0 ? 'Add a starter deck or your own cards to begin.' : `Next cards come due ${myCards.filter((c) => !c.is_suspended && c.due_on > isoDate(today)).sort((a, b) => a.due_on.localeCompare(b.due_on))[0]?.due_on ? fmtDate(myCards.filter((c) => !c.is_suspended && c.due_on > isoDate(today)).sort((a, b) => a.due_on.localeCompare(b.due_on))[0].due_on) : 'when you add more'}.`}</p>
                {reviewedCount > 0 && <Button className="mt-4" onClick={finishReview}><Check className="h-4 w-4" /> Log {reviewedCount} {tr('language.reviewsAsPractice')}</Button>}
                {deck.total === 0 && starterDeck(goal.language_code).length > 0 && <Button className="mt-4" onClick={addStarterDeck} loading={adding}><Wand2 className="h-4 w-4" /> {tr('language.addThe')} {goal.language_label} {tr('language.starterDeck')}</Button>}
              </div>
            )
          )}

          {tab === 'cards' && (
            myCards.length === 0 ? (
              <EmptyState icon={Layers} title={tr('language.noCardsYet')} description="Twenty high-frequency words come as a starter deck; add the words from class, the show you watched, or dinner." action={<Button onClick={() => setCardForm({ open: true, card: null })}><Plus className="h-4 w-4" /> {tr('language.addACard')}</Button>} />
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {[...myCards].sort((a, b) => a.due_on.localeCompare(b.due_on) || a.term.localeCompare(b.term)).map((c) => (
                  <li key={c.id} className={cn('flex items-center gap-3 rounded-xl border px-3 py-2', c.is_suspended ? 'border-border/60 bg-surface/30 opacity-70' : 'border-border bg-surface/60')}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm"><span className="font-medium">{c.term}</span> <span className="text-muted">— {c.translation}</span></p>
                      <p className="text-[11px] text-muted">{c.is_suspended ? 'Suspended' : c.due_on <= isoDate(today) ? 'Due now' : `Due ${fmtDate(c.due_on)}`} · {c.repetitions === 0 && c.lapses === 0 ? 'new' : `${c.interval_days}d interval · ease ${c.ease}`}{c.lapses ? ` · ${c.lapses} lapse${c.lapses === 1 ? '' : 's'}` : ''}</p>
                    </div>
                    <button onClick={() => toggleSuspend(c)} aria-label={c.is_suspended ? 'Resume card' : 'Suspend card'} className="rounded-lg p-1.5 text-muted hover:text-fg">{c.is_suspended ? <PlayCircle className="h-4 w-4" /> : <PauseCircle className="h-4 w-4" />}</button>
                    <button onClick={() => setCardForm({ open: true, card: c })} aria-label={`Edit ${c.term}`} className="rounded-lg p-1.5 text-muted hover:text-fg"><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => deleteCard(c)} aria-label={`Delete ${c.term}`} className="rounded-lg p-1.5 text-muted hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                  </li>
                ))}
              </ul>
            )
          )}

          {tab === 'sessions' && (
            mySessions.length === 0 ? (
              <EmptyState icon={Timer} title={tr('language.nothingLoggedYet')} description={tr('languageModule.logAnythingAClassTen')} action={<Button onClick={() => setSessionOpen(true)}><Timer className="h-4 w-4" /> {tr('language.logPractice')}</Button>} />
            ) : (
              <ul className="space-y-2">
                {mySessions.slice(0, 40).map((s) => (
                  <li key={s.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/60 px-3 py-2">
                    <span className="text-lg" aria-hidden>{kindMeta(s.kind).emoji}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{kindMeta(s.kind).label} · {s.minutes} min{s.score !== null ? ` · ${s.score}/100` : ''}</p>
                      <p className="text-[11px] text-muted">{fmtDate(s.practiced_on)}{s.member_id ? ` · ${nameOf(s.member_id)}` : ''}{s.topic ? ` · ${s.topic}` : ''}{s.corrections.length ? ` · ${s.corrections.length} correction${s.corrections.length === 1 ? '' : 's'}` : ''}</p>
                    </div>
                    <button onClick={() => deleteSession(s)} aria-label={tr('language.deleteSession')} className="rounded-lg p-1.5 text-muted hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                  </li>
                ))}
              </ul>
            )
          )}
        </>
      )}

      {goalForm.open && (
        <GoalForm familyId={familyId} userId={userId} members={members} goal={goalForm.goal} defaultMember={selfMember?.id ?? null} onClose={() => setGoalForm({ open: false, goal: null })} onSaved={(id) => { setGoalForm({ open: false, goal: null }); setGoalId(id); success('Goal saved'); }} />
      )}
      {cardForm.open && goal && (
        <CardForm familyId={familyId} userId={userId} goalId={goal.id} card={cardForm.card} onClose={() => setCardForm({ open: false, card: null })} onSaved={() => { setCardForm({ open: false, card: null }); success('Card saved'); }} />
      )}
      {sessionOpen && goal && (
        <SessionForm familyId={familyId} userId={userId} goal={goal} suggested={suggestion} onClose={() => setSessionOpen(false)} onSaved={() => { setSessionOpen(false); success('Practice logged'); }} />
      )}
    </div>
  );
}

function GoalForm({ familyId, userId, members, goal, defaultMember, onClose, onSaved }: { familyId: string; userId: string; members: { id: string; display_name: string }[]; goal: Goal | null; defaultMember: string | null; onClose: () => void; onSaved: (id: string) => void }) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState(goal?.language_code ?? 'es');

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const memberId = String(f.get('member_id') ?? '');
    if (!memberId) return toastError('Who is learning?');
    const label = code === 'other' ? String(f.get('language_label') ?? '').trim() : languageMeta(code).label;
    if (!label) return toastError('Name the language');
    const current = String(f.get('current_level') ?? 'A1') as CefrLevel;
    const target = String(f.get('target_level') ?? 'B1') as Exclude<CefrLevel, 'A0'>;
    if (CEFR.findIndex((l) => l.value === target) <= CEFR.findIndex((l) => l.value === current)) return toastError('The target level must be above the current level');
    setLoading(true);
    const payload = {
      member_id: memberId, language_code: code, language_label: label, current_level: current, target_level: target,
      weekly_minutes: Math.max(0, Math.min(3000, Number(f.get('weekly_minutes') ?? 90))), reason: String(f.get('reason') ?? '').trim() || null, notes: String(f.get('notes') ?? '').trim() || null,
    };
    const supabase = createClient();
    const { data, error } = goal
      ? await supabase.from('language_goals').update(payload).eq('id', goal.id).select('id').single()
      : await supabase.from('language_goals').insert({ family_id: familyId, created_by: userId, is_active: true, ...payload }).select('id').single();
    if (error) { setLoading(false); return toastError(describeDbError(error)); }
    if (!goal) {
      // New goal: seed the starter deck so the first review is one tap away.
      const deckCards = starterDeck(code);
      if (deckCards.length) {
        const { error: deckError } = await supabase.from('vocab_cards').insert(deckCards.map((c) => ({ family_id: familyId, goal_id: data.id, term: c.term, translation: c.translation, example: c.example ?? null, part_of_speech: c.pos ?? null, tags: ['starter'], due_on: isoDate(new Date()), created_by: userId })));
        if (deckError) toastError(describeDbError(deckError));
      }
    }
    setLoading(false);
    onSaved(data.id);
  }

  return (
    <Modal open title={goal ? 'Edit language goal' : 'Start a language'} description="Levels follow the CEFR scale; the hours estimate comes from the usual guided-learning bands." onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Who" required>{(id) => <Select id={id} name="member_id" defaultValue={goal?.member_id ?? defaultMember ?? ''}>{!goal && <option value="">Choose…</option>}{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label={tr('language.language')} required>{(id) => <Select id={id} name="language_code" value={code} onChange={(e) => setCode(e.target.value)}>{LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.label}</option>)}</Select>}</Field>
        </div>
        {code === 'other' && <Field label={tr('language.languageName')} required>{(id) => <Input id={id} name="language_label" defaultValue={goal?.language_label ?? ''} placeholder={tr('language.tagalog')} />}</Field>}
        <div className="grid grid-cols-3 gap-3">
          <Field label="Now">{(id) => <Select id={id} name="current_level" defaultValue={goal?.current_level ?? 'A0'}>{CEFR.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</Select>}</Field>
          <Field label={tr('language.target')}>{(id) => <Select id={id} name="target_level" defaultValue={goal?.target_level ?? 'B1'}>{CEFR.filter((l) => l.value !== 'A0').map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</Select>}</Field>
          <Field label={tr('language.minutesWeek')}>{(id) => <Input id={id} name="weekly_minutes" type="number" min={0} max={3000} step={5} defaultValue={goal?.weekly_minutes ?? 90} />}</Field>
        </div>
        <Field label="Why">{(id) => <Input id={id} name="reason" defaultValue={goal?.reason ?? ''} placeholder={tr('language.grandmaSpeaksItSchoolExamIn')} />}</Field>
        <Field label={tr('language.notes')}>{(id) => <Textarea id={id} name="notes" rows={2} defaultValue={goal?.notes ?? ''} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('language.cancel')}</Button>
          <Button type="submit" loading={loading}><Check className="h-4 w-4" /> {tr('language.saveGoal')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function CardForm({ familyId, userId, goalId, card, onClose, onSaved }: { familyId: string; userId: string; goalId: string; card: Card | null; onClose: () => void; onSaved: () => void }) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const term = String(f.get('term') ?? '').trim();
    const translation = String(f.get('translation') ?? '').trim();
    if (!term || !translation) return toastError('Term and translation are both needed');
    setLoading(true);
    const payload = { term, translation, example: String(f.get('example') ?? '').trim() || null, part_of_speech: String(f.get('part_of_speech') ?? '').trim() || null, tags: String(f.get('tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean), notes: String(f.get('notes') ?? '').trim() || null };
    const supabase = createClient();
    const { error } = card
      ? await supabase.from('vocab_cards').update(payload).eq('id', card.id)
      : await supabase.from('vocab_cards').insert({ family_id: familyId, goal_id: goalId, created_by: userId, due_on: isoDate(new Date()), ...payload });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title={card ? 'Edit card' : 'New card'} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('language.term')} required>{(id) => <Input id={id} name="term" defaultValue={card?.term ?? ''} autoFocus />}</Field>
          <Field label={tr('language.translation')} required>{(id) => <Input id={id} name="translation" defaultValue={card?.translation ?? ''} />}</Field>
        </div>
        <Field label={tr('language.exampleSentence')}>{(id) => <Input id={id} name="example" defaultValue={card?.example ?? ''} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('language.partOfSpeech')}>{(id) => <Input id={id} name="part_of_speech" defaultValue={card?.part_of_speech ?? ''} placeholder={tr('language.nounVerb')} />}</Field>
          <Field label={tr('language.tagsCommaSeparated')}>{(id) => <Input id={id} name="tags" defaultValue={card?.tags.join(', ') ?? ''} placeholder={tr('language.foodChapter3')} />}</Field>
        </div>
        <Field label={tr('language.notes')}>{(id) => <Textarea id={id} name="notes" rows={2} defaultValue={card?.notes ?? ''} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('language.cancel')}</Button>
          <Button type="submit" loading={loading}><Check className="h-4 w-4" /> {tr('language.saveCard')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function SessionForm({ familyId, userId, goal, suggested, onClose, onSaved }: { familyId: string; userId: string; goal: Goal; suggested: { kind: LanguageSessionKind; minutes: number } | null; onClose: () => void; onSaved: () => void }) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const minutes = Math.max(1, Math.min(600, Number(f.get('minutes') ?? 15)));
    const scoreRaw = String(f.get('score') ?? '').trim();
    setLoading(true);
    const { error } = await createClient().from('language_sessions').insert({
      family_id: familyId, goal_id: goal.id, member_id: goal.member_id, kind: String(f.get('kind') ?? 'vocab') as LanguageSessionKind, minutes,
      score: scoreRaw ? Math.max(0, Math.min(100, Number(scoreRaw))) : null, topic: String(f.get('topic') ?? '').trim() || null,
      corrections: String(f.get('corrections') ?? '').split('\n').map((c) => c.trim()).filter(Boolean), practiced_on: String(f.get('practiced_on') ?? '') || isoDate(new Date()),
      notes: String(f.get('notes') ?? '').trim() || null, created_by: userId,
    });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title={tr('language.logPractice')} description={tr('languageModule.anythingCountsClassTutorChat')} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Field label={tr('language.what')}>{(id) => <Select id={id} name="kind" defaultValue={suggested?.kind ?? 'vocab'}>{SESSION_KINDS.map((k) => <option key={k.value} value={k.value}>{k.emoji} {k.label}</option>)}</Select>}</Field>
          <Field label={tr('language.minutes')} required>{(id) => <Input id={id} name="minutes" type="number" min={1} max={600} defaultValue={suggested?.minutes ?? 15} autoFocus />}</Field>
          <Field label={tr('language.when')}>{(id) => <Input id={id} name="practiced_on" type="date" defaultValue={isoDate(new Date())} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('language.topic')}>{(id) => <Input id={id} name="topic" placeholder={tr('language.orderingFoodPastTenseEpisode3')} />}</Field>
          <Field label={tr('language.score0100')}>{(id) => <Input id={id} name="score" type="number" min={0} max={100} />}</Field>
        </div>
        <Field label={tr('language.correctionsToRememberOnePerLine')}>{(id) => <Textarea id={id} name="corrections" rows={3} placeholder={tr('language.tengoHambreNotSoyHambre')} />}</Field>
        <Field label={tr('language.notes')}>{(id) => <Textarea id={id} name="notes" rows={2} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('language.cancel')}</Button>
          <Button type="submit" loading={loading}><ChevronRight className="h-4 w-4" /> {tr('language.logIt')}</Button>
        </div>
      </form>
    </Modal>
  );
}
