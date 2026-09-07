'use client';

import { useMemo, useState, useTransition } from 'react';
import { Vote, Plus, Check, X, HelpCircle, Trophy, ShoppingCart, Lock, RotateCcw } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { tallyVotes, winningOption } from '@/lib/recipes/voting';
import { createMealVote, castBallot, closeMealVote, reopenMealVote, addWinnerToGrocery } from './actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export type VoteView = {
  id: string; title: string; status: string; mealDate: string | null; mealType: string | null;
  winnerOptionId: string | null;
  options: { id: string; recipeId: string | null; label: string; photoUrl: string | null }[];
  ballots: { optionId: string; memberId: string; choice: string }[];
};
type RecipeLite = { id: string; name: string; photoUrl: string | null };

const CHOICES: { v: 'yes' | 'maybe' | 'no'; icon: typeof Check; cls: string }[] = [
  { v: 'yes', icon: Check, cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' },
  { v: 'maybe', icon: HelpCircle, cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40' },
  { v: 'no', icon: X, cls: 'bg-rose-500/15 text-rose-300 border-rose-500/40' },
];

export function MealVoteClient({ votes, recipes }: { votes: VoteView[]; recipes: RecipeLite[] }) {
  const tr = useTranslations();
  const { selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const [pending, start] = useTransition();
  const [createOpen, setCreateOpen] = useState(false);

  function act(fn: () => Promise<{ ok: boolean; error?: string }>, okMsg?: string) {
    start(async () => {
      const res = await fn();
      if (res.ok) { if (okMsg) success(okMsg); } else toastError(res.error ?? 'Something went wrong');
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold"><Vote className="h-5 w-5 text-brand-text" /> {tr('dashboardRecipesVoteVoteClient.mealVoting')}</h1>
          <p className="text-sm text-muted">{tr('dashboardRecipesVoteVoteClient.proposeMealsLetTheFamilyVote')}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> {tr('dashboardRecipesVoteVoteClient.newVote')}</Button>
      </div>

      {votes.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center text-muted">{tr('dashboardRecipesVoteVoteClient.noVotesYetStartOneTo')}</div>
      ) : (
        <div className="space-y-4">
          {votes.map((v) => {
            const tallies = tallyVotes(v.options.map((o) => o.id), v.ballots.map((b) => ({ option_id: b.optionId, choice: b.choice })));
            const tById = new Map(tallies.map((t) => [t.optionId, t]));
            const liveWinner = v.winnerOptionId ?? (v.status === 'open' ? winningOption(tallies) : null);
            const closed = v.status === 'closed';
            return (
              <div key={v.id} className="rounded-2xl border border-border bg-surface/40 p-4">
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold">{v.title}</p>
                    <p className="text-xs text-muted">{[v.mealDate, v.mealType].filter(Boolean).join(' · ') || 'No date set'} · {closed ? 'Closed' : 'Open'}</p>
                  </div>
                  <div className="flex gap-1.5">
                    {closed ? (
                      <>
                        <button onClick={() => act(() => addWinnerToGrocery(v.id), 'Added to grocery list')} disabled={pending} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-elevated"><ShoppingCart className="h-3.5 w-3.5" />{' '}{tr('voteClient.grocery')}</button>
                        <button onClick={() => act(() => reopenMealVote(v.id))} disabled={pending} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-elevated"><RotateCcw className="h-3.5 w-3.5" />{' '}{tr('voteClient.reopen')}</button>
                      </>
                    ) : (
                      <button onClick={() => act(() => closeMealVote(v.id), 'Vote closed')} disabled={pending} className="inline-flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1 text-xs font-semibold text-white"><Lock className="h-3.5 w-3.5" />{' '}{tr('voteClient.closePickWinner')}</button>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  {v.options.map((o) => {
                    const t = tById.get(o.id);
                    const mine = v.ballots.find((b) => b.optionId === o.id && b.memberId === selfMember?.id)?.choice;
                    const isWinner = liveWinner === o.id;
                    return (
                      <div key={o.id} className={`rounded-xl border p-3 ${isWinner ? 'border-brand/50 bg-brand/5' : 'border-border'}`}>
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">{o.label}{isWinner && <Trophy className="ml-1 inline h-3.5 w-3.5 text-amber-300" />}</span>
                          <span className="shrink-0 text-xs text-muted">👍 {t?.yes ?? 0} · 🤷 {t?.maybe ?? 0} · 👎 {t?.no ?? 0}</span>
                        </div>
                        {!closed && (
                          <div className="mt-2 flex gap-1.5">
                            {CHOICES.map((c) => (
                              <button key={c.v} onClick={() => act(() => castBallot({ voteId: v.id, optionId: o.id, choice: c.v }))} disabled={pending}
                                className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition ${mine === c.v ? c.cls : 'border-border text-muted hover:bg-elevated'}`}>
                                <c.icon className="h-3.5 w-3.5" /> {c.v}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {createOpen && <CreateVoteModal recipes={recipes} onClose={() => setCreateOpen(false)} />}
    </div>
  );
}

function CreateVoteModal({ recipes, onClose }: { recipes: RecipeLite[]; onClose: () => void }) {
  const tr = useTranslations();
  const { success, error: toastError } = useToast();
  const [title, setTitle] = useState('');
  const [mealDate, setMealDate] = useState('');
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [extra, setExtra] = useState('');
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  const filtered = useMemo(
    () => recipes.filter((r) => r.name.toLowerCase().includes(search.toLowerCase())).slice(0, 40),
    [recipes, search],
  );

  async function submit() {
    const options: { recipeId: string | null; label: string; photoUrl: string | null }[] =
      recipes.filter((r) => picked[r.id]).map((r) => ({ recipeId: r.id, label: r.name, photoUrl: r.photoUrl }));
    for (const line of extra.split('\n').map((s) => s.trim()).filter(Boolean)) options.push({ recipeId: null, label: line, photoUrl: null });
    if (!title.trim()) return toastError('Add a title.');
    if (options.length < 2) return toastError('Pick at least two options.');
    setSaving(true);
    const res = await createMealVote({ title, mealDate: mealDate || null, options });
    setSaving(false);
    if (res.ok) { success('Vote created'); onClose(); } else toastError(res.error);
  }

  return (
    <Modal open onClose={onClose} title={tr('dashboardRecipesVoteVoteClient.newMealVote')}>
      <div className="space-y-4">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tr('dashboardRecipesVoteVoteClient.eGFridayDinner')} />
        <Input type="date" value={mealDate} onChange={(e) => setMealDate(e.target.value)} />
        <div>
          <p className="mb-1.5 text-sm font-semibold">{tr('dashboardRecipesVoteVoteClient.optionsFromYourRecipes')}</p>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tr('dashboardRecipesVoteVoteClient.searchYourRecipes')} />
          <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
            {filtered.length === 0 && <p className="text-xs text-muted">{tr('dashboardRecipesVoteVoteClient.noRecipesAddFreeTextOptions')}</p>}
            {filtered.map((r) => (
              <label key={r.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm">
                <input type="checkbox" checked={!!picked[r.id]} onChange={(e) => setPicked((p) => ({ ...p, [r.id]: e.target.checked }))} className="h-4 w-4 accent-[var(--brand)]" />
                <span className="truncate">{r.name}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1 text-sm font-semibold">{tr('dashboardRecipesVoteVoteClient.orAddOptionsOnePerLine')}</p>
          <textarea value={extra} onChange={(e) => setExtra(e.target.value)} rows={2} placeholder={'Pizza night\nTacos'} className="w-full rounded-lg border border-border bg-bg p-2 text-sm" />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{tr('dashboardRecipesVoteVoteClient.cancel')}</Button>
          <Button onClick={submit} loading={saving}><Plus className="h-4 w-4" /> {tr('dashboardRecipesVoteVoteClient.createVote')}</Button>
        </div>
      </div>
    </Modal>
  );
}
