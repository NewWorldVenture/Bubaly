'use client';

// Family Playbook — the "Family Intelligence Layer" surface (north-star pillar
// #3). Bubaly learns durable preferences/traditions from real household usage
// (favorite meals, grocery staples, family favorites, annual traditions) and
// proposes them here. The family confirms the ones worth keeping → they become
// real family_facts rows in the Knowledge Base. Nothing is saved until confirmed.
// 100% Supabase via useRealtimeQuery + server actions; no mock data.

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import {
  Sparkles, Check, X, RefreshCw, Wand2, BookHeart, ArrowRight,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import { FACT_CATEGORY_LABELS, type FactCategory } from '@/lib/memory/facts';
import type { Tables } from '@/lib/database.types';
import {
  refreshPlaybookAction, acceptSuggestionAction, dismissSuggestionAction,
} from '@/app/(app)/dashboard/playbook/playbook-actions';

type Suggestion = Tables<'family_playbook_suggestions'>;

/** Confidence → a calm label + tint (no vanity numbers front and center). */
function confidenceMeta(n: number): { label: string; tint: string } {
  if (n >= 85) return { label: 'Very likely', tint: 'bg-emerald-500/12 text-emerald-500' };
  if (n >= 65) return { label: 'Likely', tint: 'bg-brand/12 text-brand' };
  return { label: 'Worth a look', tint: 'bg-amber-500/12 text-amber-500' };
}

export function PlaybookModule() {
  const { familyId, members } = useApp();
  const { success, error: toastError } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();

  const { data: rows, loading, error, refresh } = useRealtimeQuery<Suggestion>({
    table: 'family_playbook_suggestions', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_playbook_suggestions').select('*').eq('family_id', familyId),
  });

  const suggested = useMemo(
    () => rows.filter((r) => r.status === 'suggested').sort((a, b) => b.confidence - a.confidence),
    [rows],
  );
  const savedCount = useMemo(() => rows.filter((r) => r.status === 'accepted').length, [rows]);

  const memberName = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? 'The family';

  function onRefresh() {
    startRefresh(async () => {
      const res = await refreshPlaybookAction();
      if (!res.ok) { toastError(res.error ?? 'Could not learn right now'); return; }
      refresh();
      success(res.added ? `Found ${res.added} thing${res.added === 1 ? '' : 's'} Bubaly noticed` : 'No new patterns yet — check back after more activity');
    });
  }

  async function onAccept(s: Suggestion) {
    setBusyId(s.id);
    const res = await acceptSuggestionAction({ id: s.id });
    setBusyId(null);
    if (!res.ok) { toastError(res.error ?? 'Could not save'); return; }
    refresh();
    success(`Saved "${s.label}" to your Knowledge Base`);
  }

  async function onDismiss(s: Suggestion) {
    setBusyId(s.id);
    const res = await dismissSuggestionAction({ id: s.id });
    setBusyId(null);
    if (!res.ok) { toastError(res.error ?? 'Could not dismiss'); return; }
    refresh();
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Family Playbook"
        description="Bubaly learns what matters to your family and suggests it here. Confirm the ones worth keeping — they save to your Knowledge Base."
        action={
          <Button onClick={onRefresh} disabled={refreshing} variant="secondary">
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            {refreshing ? 'Learning…' : 'Find new insights'}
          </Button>
        }
      />

      {/* At-a-glance rail */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile icon={Wand2} label="To review" value={suggested.length} />
        <StatTile icon={BookHeart} label="Saved to playbook" value={savedCount} />
        <Link
          href="/dashboard/knowledge"
          className="group flex items-center justify-between rounded-2xl border border-border bg-card p-4 transition hover:border-brand/40"
        >
          <div>
            <p className="text-xs text-muted">Knowledge Base</p>
            <p className="mt-1 text-sm font-semibold">Open</p>
          </div>
          <ArrowRight className="h-4 w-4 text-muted transition group-hover:translate-x-0.5 group-hover:text-brand" />
        </Link>
      </div>

      {loading ? (
        <SkeletonList count={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={refresh} />
      ) : suggested.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="Nothing to review right now"
          description="As your family plans meals, shops, and celebrates, Bubaly spots the patterns worth remembering. Tap “Find new insights” to look now."
          action={
            <Button onClick={onRefresh} disabled={refreshing}>
              <Wand2 className="h-4 w-4" />
              Find new insights
            </Button>
          }
        />
      ) : (
        <ul className="space-y-3">
          {suggested.map((s) => {
            const conf = confidenceMeta(s.confidence);
            const cat = (FACT_CATEGORY_LABELS[s.category as FactCategory] ? s.category : 'other') as FactCategory;
            const busy = busyId === s.id;
            return (
              <li
                key={s.id}
                className="rounded-2xl border border-border bg-card p-4 transition hover:border-border/80"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', conf.tint)}>{conf.label}</span>
                      <span className="rounded-full bg-elevated px-2 py-0.5 text-[11px] text-muted">{FACT_CATEGORY_LABELS[cat]}</span>
                    </div>
                    <p className="mt-2 truncate text-sm font-semibold">
                      {s.label}: <span className="font-normal">{s.value}</span>
                    </p>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                      {s.member_id && <Avatar name={memberName(s.member_id)} size={20} />}
                      <span className="truncate">
                        {s.member_id ? `${memberName(s.member_id)} · ` : ''}{s.evidence ?? 'Learned from your family’s activity'}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      onClick={() => onDismiss(s)}
                      disabled={busy}
                      aria-label="Dismiss"
                      title="Not useful"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border text-muted transition hover:bg-elevated disabled:opacity-50"
                    >
                      <X className="h-4 w-4" />
                    </button>
                    <Button onClick={() => onAccept(s)} disabled={busy} size="sm">
                      <Check className="h-4 w-4" />
                      Save
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StatTile({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: number }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4">
      <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand/10 text-brand">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-lg font-bold leading-none tabular-nums">{value}</p>
        <p className="mt-1 text-xs text-muted">{label}</p>
      </div>
    </div>
  );
}
