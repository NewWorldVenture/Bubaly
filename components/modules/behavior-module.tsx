'use client';

import { useMemo, useState } from 'react';
import { Smile, Frown, Minus, Plus, Trash2, Sparkles, TrendingUp, Flame, Award } from 'lucide-react';
import Link from 'next/link';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { ErrorState, SkeletonList, EmptyState } from '@/components/ui/states';
import { AiInsight } from '@/components/ai/ai-insight';
import { fmtDate } from '@/lib/utils/format';
import {
  BEHAVIOR_KINDS, BEHAVIOR_CATEGORIES, kindMeta, summarizeMember, trendByWeek, positiveStreakDays,
  type BehaviorLogLike,
} from '@/lib/behavior/insights';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Log = Tables<'behavior_logs'>;

const blank = () => ({ id: '', member_id: '', kind: 'positive', category: 'responsibility', note: '', points: '1', occurred_at: new Date().toISOString().slice(0, 16) });

const KIND_ICON = { positive: Smile, concern: Frown, neutral: Minus } as const;

export function BehaviorModule() {
  const tr = useTranslations();
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const { data: logs, loading, error, refresh } = useRealtimeQuery<Log>({
    table: 'behavior_logs', familyId, deps: [familyId],
    // Bound the read: behavior_logs grows unbounded over a family's lifetime, but
    // every view here is recent-focused (6-week trend, streaks, recent list). Load
    // a rolling 365-day window (hard-capped at 1000 rows) instead of the full
    // history, so the client payload stays bounded as data accumulates.
    fetcher: (sb) => sb.from('behavior_logs').select('*').eq('family_id', familyId)
      .gte('occurred_at', new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString())
      .order('occurred_at', { ascending: false }).limit(1000),
  });

  const [memberFilter, setMemberFilter] = useState('all');
  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const [ai, setAi] = useState<{ loading: boolean; insight: string; tips: string[] } | null>(null);

  const all = useMemo(() => logs ?? [], [logs]);
  const scoped = useMemo(
    () => (memberFilter === 'all' ? all : all.filter((l) => l.member_id === memberFilter)),
    [all, memberFilter],
  );

  // Per-child summary cards (only members with at least one log, or all kids).
  const memberIds = useMemo(() => {
    const ids = new Set<string>();
    for (const l of all) if (l.member_id) ids.add(l.member_id);
    return [...ids];
  }, [all]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const supabase = createClient();
    const row = {
      member_id: form.member_id || null,
      kind: form.kind,
      category: form.category.trim() || 'general',
      note: form.note.trim() || null,
      points: Number.isFinite(parseInt(form.points, 10)) ? parseInt(form.points, 10) : 0,
      occurred_at: new Date(form.occurred_at).toISOString(),
    };
    const { error } = form.id
      ? await supabase.from('behavior_logs').update(row).eq('id', form.id)
      : await supabase.from('behavior_logs').insert({ ...row, family_id: familyId, logged_by: userId });
    if (error) return toastError(describeDbError(error));
    success(form.id ? 'Updated' : 'Logged');
    setForm(null);
  }

  async function remove(id: string) {
    if (!confirm('Delete this entry?')) return;
    const { error } = await createClient().from('behavior_logs').delete().eq('id', id);
    if (error) toastError(describeDbError(error)); else success('Deleted');
  }

  async function getInsight() {
    setAi({ loading: true, insight: '', tips: [] });
    try {
      const res = await fetch('/api/behavior/insight', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ memberId: memberFilter === 'all' ? undefined : memberFilter }),
      });
      const d = await res.json();
      setAi({ loading: false, insight: d.insight ?? '', tips: Array.isArray(d.tips) ? d.tips : [] });
    } catch {
      setAi({ loading: false, insight: 'Could not generate an insight right now.', tips: [] });
    }
  }

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={tr('behaviorModule.couldNotLoadBehaviorLogs')} onRetry={refresh} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold"><Smile className="h-4 w-4 text-brand-text" /> {tr('behavior.behaviorParentingInsights')}</h3>
        <div className="flex items-center gap-2">
          {members.length > 0 && (
            <Select value={memberFilter} onChange={(e) => setMemberFilter(e.target.value)} className="h-9">
              <option value="all">{tr('behavior.allKids')}</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </Select>
          )}
          <AiInsight kind="behavior" iconOnly />
          <Link href="/dashboard/independence"
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-sm font-semibold text-muted transition hover:text-fg hover:bg-elevated">
            <Award className="h-4 w-4" /> {tr('behavior.independence')}
          </Link>
          <Button onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> {tr('behavior.logBehavior')}</Button>
        </div>
      </div>

      {/* AI parenting insight */}
      <div className="rounded-2xl border border-brand/20 bg-brand/5 p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-brand-text" /> {tr('behavior.aiParentingInsight')}</p>
          <Button variant="secondary" onClick={getInsight} loading={ai?.loading}>{tr('behavior.generate')}</Button>
        </div>
        {ai && !ai.loading && (
          <div className="mt-3 space-y-2 text-sm">
            <p className="text-fg/90">{ai.insight}</p>
            {ai.tips.length > 0 && (
              <ul className="list-inside list-disc space-y-1 text-muted">
                {ai.tips.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Per-child insight cards */}
      {memberIds.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {memberIds.map((mid) => {
            const mlogs = all.filter((l) => l.member_id === mid) as BehaviorLogLike[];
            const s = summarizeMember(mlogs);
            const streak = positiveStreakDays(mlogs);
            const trend = trendByWeek(mlogs, 6);
            const maxBar = Math.max(1, ...trend.map((t) => t.positive + t.concern));
            const m = memberById.get(mid);
            return (
              <div key={mid} className="rounded-2xl border border-border bg-surface/40 p-4">
                <div className="flex items-center gap-2">
                  <Avatar name={m?.display_name ?? 'Member'} size={28} />
                  <p className="font-semibold">{m?.display_name ?? 'Member'}</p>
                  {streak > 0 && <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-500"><Flame className="h-3 w-3" /> {streak}d</span>}
                </div>
                <div className="mt-3 flex items-end justify-between">
                  <div>
                    <p className="text-2xl font-bold">{s.balanceScore}<span className="text-sm font-normal text-muted">/100</span></p>
                    <p className="text-xs text-muted">{tr('behavior.balanceScore')}</p>
                  </div>
                  <div className="text-right text-xs">
                    <p className="text-success">{s.positive} positive</p>
                    <p className="text-danger">{s.concern} concern</p>
                  </div>
                </div>
                {/* 6-week mini trend */}
                <div className="mt-3 flex h-10 items-end gap-1">
                  {trend.map((t, i) => (
                    <div key={i} className="flex flex-1 flex-col justify-end gap-0.5" title={`${t.weekStart}: +${t.positive} / -${t.concern}`}>
                      <div className="w-full rounded-sm bg-success/70" style={{ height: `${(t.positive / maxBar) * 100}%` }} />
                      <div className="w-full rounded-sm bg-danger/60" style={{ height: `${(t.concern / maxBar) * 100}%` }} />
                    </div>
                  ))}
                </div>
                {s.topCategories.length > 0 && (
                  <p className="mt-3 flex items-center gap-1 text-xs text-muted"><TrendingUp className="h-3 w-3" /> {s.topCategories.map((c) => `${c.category} (${c.count})`).join(' · ')}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Recent log */}
      <div className="space-y-2">
        {scoped.length === 0 ? (
          <EmptyState icon={Smile} title={tr('behavior.noBehaviorLoggedYet')} description={tr('behaviorModule.logPositiveMomentsAndConcerns')} />
        ) : scoped.map((l) => {
          const Icon = KIND_ICON[l.kind as keyof typeof KIND_ICON] ?? Minus;
          const meta = kindMeta(l.kind);
          const m = l.member_id ? memberById.get(l.member_id) : null;
          return (
            <div key={l.id} className="flex items-start gap-3 rounded-xl border border-border bg-surface/40 p-3">
              <div className={`mt-0.5 rounded-lg p-1.5 ${meta.tone === 'success' ? 'bg-success/15 text-success' : meta.tone === 'danger' ? 'bg-danger/15 text-danger' : 'bg-border/40 text-muted'}`}>
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  <span className="font-medium capitalize">{l.category}</span>
                  {m ? ` · ${m.display_name}` : ''}
                  {l.points ? <span className={l.points > 0 ? 'text-success' : 'text-danger'}> · {l.points > 0 ? '+' : ''}{l.points}</span> : null}
                </p>
                {l.note && <p className="text-xs text-muted">{l.note}</p>}
                <p className="mt-0.5 text-[11px] text-muted">{fmtDate(l.occurred_at)}</p>
              </div>
              <button onClick={() => remove(l.id)} className="text-muted hover:text-danger" aria-label={tr('behavior.delete')}><Trash2 className="h-4 w-4" /></button>
            </div>
          );
        })}
      </div>

      {form && (
        <Modal open onClose={() => setForm(null)} title={form.id ? 'Edit behavior' : 'Log behavior'}>
          <form onSubmit={save} className="space-y-3">
            <Field label={tr('behavior.child')}>
              {(id) => (
                <Select id={id} value={form.member_id} onChange={(e) => setForm({ ...form, member_id: e.target.value })}>
                  <option value="">{tr('behavior.select')}</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                </Select>
              )}
            </Field>
            <Field label={tr('behavior.kind')}>
              {(id) => (
                <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  {BEHAVIOR_KINDS.map((k) => <option key={k} value={k}>{kindMeta(k).label}</option>)}
                </Select>
              )}
            </Field>
            <Field label={tr('behavior.category')}>
              {(id) => (
                <Select id={id} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                  {BEHAVIOR_CATEGORIES.map((c) => <option key={c} value={c} className="capitalize">{c}</option>)}
                </Select>
              )}
            </Field>
            <Field label={tr('behavior.pointsOptional')}>
              {(id) => <Input id={id} type="number" value={form.points} onChange={(e) => setForm({ ...form, points: e.target.value })} />}
            </Field>
            <Field label={tr('behavior.when')}>
              {(id) => <Input id={id} type="datetime-local" value={form.occurred_at} onChange={(e) => setForm({ ...form, occurred_at: e.target.value })} />}
            </Field>
            <Field label={tr('behavior.note')}>
              {(id) => <Textarea id={id} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={tr('behavior.whatHappened')} />}
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setForm(null)}>{tr('behavior.cancel')}</Button>
              <Button type="submit">{form.id ? 'Save' : 'Log it'}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

