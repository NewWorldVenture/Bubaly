'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, CheckCircle2, Loader2, ChevronDown, Trophy, X } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import {
  DOMAIN_LABEL, DOMAIN_ICON, ageFromBirthday, suggestMilestones, independenceLevel,
  type IndependenceDomain,
} from '@/lib/independence/progression';
import { startMilestoneAction, achieveMilestoneAction, skipMilestoneAction } from '@/app/(app)/dashboard/independence/actions';
import type { Tables } from '@/lib/database.types';

type Kid = { id: string; display_name: string; role: string; birthday: string | null; color: string | null };
type Row = Tables<'independence_milestones'>;

const DEFAULT_AGE = 10;   // no birthday on file → mid-ladder, parent can still pick anything

export function IndependenceModule({ kids, rows }: { kids: Kid[]; rows: Row[] }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [pending, startTransition] = useTransition();
  const [selectedKid, setSelectedKid] = useState<string | null>(kids[0]?.id ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAllSuggestions, setShowAllSuggestions] = useState(false);

  const kid = kids.find(k => k.id === selectedKid) ?? null;
  const age = kid ? (ageFromBirthday(kid.birthday) ?? DEFAULT_AGE) : DEFAULT_AGE;

  const kidRows = useMemo(() => rows.filter(r => r.member_id === selectedKid), [rows, selectedKid]);
  const achievedTitles = useMemo(
    () => new Set(kidRows.filter(r => r.status === 'achieved').map(r => r.title)), [kidRows]);
  const trackedTitles = useMemo(
    () => new Set(kidRows.filter(r => r.status !== 'skipped').map(r => r.title)), [kidRows]);

  const level = useMemo(() => independenceLevel(age, achievedTitles), [age, achievedTitles]);
  const suggestions = useMemo(() => suggestMilestones(age, trackedTitles), [age, trackedTitles]);
  const inProgress = kidRows.filter(r => r.status === 'in_progress' || r.status === 'suggested');
  const achieved = kidRows.filter(r => r.status === 'achieved');

  function run(fn: () => Promise<{ ok: boolean } & { error?: string }>, key: string, okMsg: string) {
    setBusy(key);
    startTransition(async () => {
      const res = await fn();
      setBusy(null);
      if (!res.ok) { toastError(res.error ?? 'Something went wrong'); return; }
      success(okMsg);
      router.refresh();
    });
  }

  if (kids.length === 0) {
    return (
      <div className="module-page">
        <PageHeader title="Independence" description="Responsibilities that grow as your kids do." />
        <div className="rounded-2xl border border-border bg-surface/30 p-8 text-center">
          <p className="text-sm text-muted">
            Add a child or teen to the family to start their independence ladder.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="module-page">
      <PageHeader
        title="Independence"
        description="An age-based ladder of real-life skills — responsibilities grow as they do."
      />

      {/* Kid switcher */}
      <div className="mb-4 flex gap-2 overflow-x-auto no-scrollbar">
        {kids.map(k => (
          <button key={k.id} onClick={() => setSelectedKid(k.id)}
            className={cn('flex-shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition',
              selectedKid === k.id ? 'bg-brand text-brand-fg' : 'bg-surface text-muted hover:text-fg')}>
            {k.display_name}
          </button>
        ))}
      </div>

      {kid && (
        <>
          {/* Level card */}
          <div className="mb-4 flex items-center gap-4 rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/10 to-transparent p-4">
            <div className="relative grid h-16 w-16 flex-shrink-0 place-items-center">
              <svg viewBox="0 0 36 36" className="h-16 w-16 -rotate-90">
                <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3" className="stroke-elevated" />
                <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3" strokeLinecap="round"
                  className="stroke-brand" strokeDasharray={`${level.pct * 0.974} 100`} />
              </svg>
              <span className="absolute text-sm font-bold">{level.pct}%</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">
                Level {level.level} · {level.label}
                {ageFromBirthday(kid.birthday) === null && (
                  <span className="ml-2 text-[10px] font-semibold text-muted">(add a birthday for age-tuned suggestions)</span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {level.achievedCount} of {level.eligibleCount} age-appropriate skills achieved.
              </p>
              <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-brand">
                <Sparkles className="h-3.5 w-3.5" /> Next unlock: {level.nextUnlock}
              </p>
            </div>
          </div>

          {/* In progress */}
          {inProgress.length > 0 && (
            <section className="mb-4 rounded-2xl border border-border bg-surface/30 p-4">
              <h2 className="mb-3 text-sm font-bold">Working on now</h2>
              <div className="space-y-2">
                {inProgress.map(r => (
                  <div key={r.id} className="flex items-center gap-3 rounded-xl border border-border bg-elevated/50 p-3">
                    <span className="text-xl">{DOMAIN_ICON[r.domain as IndependenceDomain] ?? '⭐'}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{r.title}</p>
                      {r.description && <p className="mt-0.5 text-xs text-muted">{r.description}</p>}
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-1.5">
                      <button
                        onClick={() => run(() => achieveMilestoneAction(r.id), 'ach-' + r.id, `${kid.display_name} achieved “${r.title}” 🎉`)}
                        disabled={pending}
                        className="rounded-lg bg-emerald-500/15 px-3 py-2 text-xs font-bold text-emerald-400 transition hover:bg-emerald-500/25 disabled:opacity-50">
                        {busy === 'ach-' + r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Achieved!'}
                      </button>
                      <button
                        onClick={() => run(() => skipMilestoneAction(r.id), 'skip-' + r.id, 'Skipped — it won’t be suggested again.')}
                        disabled={pending}
                        aria-label={`Skip ${r.title}`}
                        className="rounded-lg p-2 text-muted transition hover:text-fg disabled:opacity-50">
                        {busy === 'skip-' + r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Suggestions */}
          <section className="mb-4 rounded-2xl border border-border bg-surface/30 p-4">
            <h2 className="mb-1 flex items-center gap-2 text-sm font-bold">
              <Sparkles className="h-4 w-4 text-brand" /> Ready for {kid.display_name} (age {age})
            </h2>
            <p className="mb-3 text-xs text-muted">Age-matched skills to start next — foundations first.</p>
            <div className="space-y-2">
              {(showAllSuggestions ? suggestions : suggestions.slice(0, 6)).map(m => (
                <div key={m.title} className="flex items-center gap-3 rounded-xl border border-border bg-elevated/50 p-3">
                  <span className="text-xl">{DOMAIN_ICON[m.domain]}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">
                      {m.title}
                      <span className="ml-2 rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold text-muted">
                        {DOMAIN_LABEL[m.domain]} · {m.ageBand}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted">{m.description}</p>
                  </div>
                  <button
                    onClick={() => run(() => startMilestoneAction(kid.id, m.title), 'start-' + m.title, `Added “${m.title}” to ${kid.display_name}'s ladder.`)}
                    disabled={pending}
                    className="flex-shrink-0 rounded-lg bg-brand px-3 py-2 text-xs font-bold text-brand-fg transition hover:opacity-90 disabled:opacity-50">
                    {busy === 'start-' + m.title ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Start'}
                  </button>
                </div>
              ))}
              {suggestions.length === 0 && (
                <p className="py-4 text-center text-sm text-muted">
                  Every age-appropriate skill is on the ladder already — amazing! 🎉
                </p>
              )}
            </div>
            {suggestions.length > 6 && (
              <button onClick={() => setShowAllSuggestions(v => !v)}
                className="mt-3 flex w-full items-center justify-center gap-1 rounded-lg py-2 text-xs font-semibold text-muted transition hover:text-fg">
                {showAllSuggestions ? 'Show fewer' : `Show all ${suggestions.length}`}
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showAllSuggestions && 'rotate-180')} />
              </button>
            )}
          </section>

          {/* Achieved */}
          <section className="rounded-2xl border border-border bg-surface/30 p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-bold">
              <Trophy className="h-4 w-4 text-amber-400" /> Achieved ({achieved.length})
            </h2>
            {achieved.length === 0 ? (
              <p className="py-3 text-center text-sm text-muted">First badge coming soon — start a skill above.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {achieved.map(r => (
                  <div key={r.id} className="flex items-start gap-2.5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-400" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{r.title}</p>
                      <p className="mt-0.5 text-[11px] text-muted">
                        {DOMAIN_LABEL[r.domain as IndependenceDomain] ?? r.domain}
                        {r.achieved_at && <> · {new Date(r.achieved_at).toLocaleDateString()}</>}
                        {r.evidence && <> · {r.evidence}</>}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
