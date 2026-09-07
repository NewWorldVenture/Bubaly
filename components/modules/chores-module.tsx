'use client';

import { useMemo, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus, LayoutTemplate, Trophy, Flame, Gift, Star, MoreVertical,
  CheckCircle2, Circle, Clock, Trash2, ChevronRight, Users, ChevronDown, Sparkles, Scale,
} from 'lucide-react';
import Link from 'next/link';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { createChoreAction, deleteChoreAssignmentAction, setChoreStatusAction } from '@/app/(app)/dashboard/chores/actions';
import { newSubmissionId } from '@/lib/utils/submission-id';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { isManager } from '@/lib/constants/roles';
import { Avatar } from '@/components/ui/avatar';
import { useCappedList, ShowMoreChip } from '@/components/family/capped-list';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { payChoreRewardAction } from '@/app/(app)/wallet/actions';
import { formatCents } from '@/lib/wallet/ledger';
import {
  topEarners, streaksByMember, groupByRecurrence, rewardsProgress, totalFamilyPoints,
  pointsByMember, dueLabel, choreEmoji, isCompleted, RANK_MEDALS,
  type AssignmentLike,
} from '@/lib/chores/dashboard';
import type { Tables, Updatable } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Chore = Tables<'chores'>;
type Reward = Tables<'rewards'>;
type Assignment = Tables<'chore_assignments'> & { chore: Chore | null };

type Tab = 'mine' | 'all' | 'completed' | 'approvals' | 'store';

const STATUS_META: Record<string, { label: string; cls: string; icon: typeof Circle }> = {
  todo: { label: 'To Do', cls: 'text-muted border-border', icon: Circle },
  in_progress: { label: 'In Progress', cls: 'text-blue-400 border-blue-500/40 bg-blue-500/10', icon: Clock },
  submitted: { label: 'Submitted', cls: 'text-amber-400 border-amber-500/40 bg-amber-500/10', icon: Clock },
  approved: { label: 'Completed', cls: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10', icon: CheckCircle2 },
  done: { label: 'Completed', cls: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10', icon: CheckCircle2 },
  rejected: { label: 'Needs Redo', cls: 'text-rose-400 border-rose-500/40 bg-rose-500/10', icon: Circle },
};

const DUE_TONE: Record<string, string> = {
  overdue: 'text-rose-400', today: 'text-amber-400', soon: 'text-amber-300', normal: 'text-muted', none: 'text-muted',
};

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `Today, ${time}` : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

export function ChoresModule() {
  const tr = useTranslations();
  const { familyId, userId, role, members, selfMember } = useApp();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const manager = isManager(role);

  const [tab, setTab] = useState<Tab>('all');
  const [childFilter, setChildFilter] = useState<string | null>(null); // member_id or null = all
  const [addOpen, setAddOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [prefill, setPrefill] = useState<Partial<ChoreDraft> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [pointsWindow, setPointsWindow] = useState<'week' | 'month' | 'all'>('week');

  const { data, loading, error, refresh } = useRealtimeQuery<Assignment>({
    table: 'chore_assignments', familyId, deps: [familyId],
    fetcher: async (supabase) => {
      const { data: assigns, error } = await supabase.from('chore_assignments').select('*').eq('family_id', familyId).order('created_at', { ascending: false });
      if (error) return { data: null, error };
      const ids = [...new Set(assigns.map((a) => a.chore_id))];
      const { data: chores } = ids.length ? await supabase.from('chores').select('*').in('id', ids) : { data: [] as Chore[] };
      const byId = new Map((chores ?? []).map((c) => [c.id, c]));
      return { data: assigns.map((a) => ({ ...a, chore: byId.get(a.chore_id) ?? null })), error: null };
    },
  });

  const { data: rewards } = useRealtimeQuery<Reward>({
    table: 'rewards', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('rewards').select('*').eq('family_id', familyId).order('cost_points'),
  });

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const selfMemberId = selfMember?.id ?? null;
  const memberChips = useCappedList(members);

  // Point-window filter for the leaderboard/points widgets.
  const windowed = useMemo(() => {
    if (pointsWindow === 'all') return data;
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (pointsWindow === 'week' ? 7 : 30));
    return data.filter((a) => {
      if (!isCompleted(a.status)) return true; // active rows unaffected by the window
      const ts = a.approved_at ?? a.submitted_at;
      return ts ? new Date(ts) >= since : true;
    });
  }, [data, pointsWindow]);

  const asgLike = (rows: Assignment[]): AssignmentLike[] => rows.map((a) => ({ ...a, chore: a.chore }));

  const earners = useMemo(() => topEarners(members, asgLike(windowed)), [members, windowed]);
  const pointsMap = useMemo(() => pointsByMember(asgLike(windowed)), [windowed]);
  const streaks = useMemo(() => streaksByMember(members, asgLike(data), new Date().toLocaleDateString('en-CA')), [members, data]);
  const familyPoints = useMemo(() => totalFamilyPoints(asgLike(windowed)), [windowed]);
  const progress = useMemo(() => rewardsProgress(members, asgLike(data), rewards ?? []), [members, data, rewards]);

  const pendingApprovals = useMemo(() => data.filter((a) => a.status === 'submitted'), [data]);
  const completedRows = useMemo(() => data.filter((a) => isCompleted(a.status)), [data]);

  // Active rows for the current tab + child filter, grouped by recurrence.
  const scoped = useMemo(() => {
    let rows = data;
    if (tab === 'mine') rows = rows.filter((a) => a.member_id === selfMemberId);
    if (childFilter) rows = rows.filter((a) => a.member_id === childFilter);
    return rows;
  }, [data, tab, childFilter, selfMemberId]);

  const groups = useMemo(() => groupByRecurrence(asgLike(scoped)), [scoped]);
  const completedScoped = useMemo(
    () => (childFilter ? completedRows.filter((a) => a.member_id === childFilter) : completedRows),
    [completedRows, childFilter],
  );

  // ── Mutations ─────────────────────────────────────────────
  async function setStatus(a: Assignment, next: string) {
    if (busy) return;
    setBusy(a.id); setMenuFor(null);
    // Through the service, which is family-scoped where this filtered `id` alone —
    // and which, for 'submitted', reads the chore's `requires_approval` and settles
    // on 'done' when no parent is needed. This always wrote 'submitted', so a chore
    // configured to need no approval still sat waiting for one.
    const result = await setChoreStatusAction(a.id, next as 'todo' | 'in_progress' | 'submitted');
    setBusy(null);
    if (!result.ok) return toastError(result.error);
    // The SETTLED status, not the requested one: a chore that needs no approval
    // comes back 'done', and saying "Submitted for approval!" about it would be
    // a small lie this work exists to remove rather than add.
    success(
      result.status === 'done' ? 'Done — no approval needed!'
        : result.status === 'submitted' ? 'Submitted for approval!'
        : result.status === 'in_progress' ? 'Marked in progress' : 'Updated',
    );
    void refresh();
  }

  async function approve(a: Assignment) {
    if (busy) return;
    setBusy(a.id); setMenuFor(null);
    const supabase = createClient();
    const { error } = await supabase.from('chore_assignments').update({
      // approved_by is a FK to family_members(id), not auth.users — use the member id.
      status: 'approved', approved_at: new Date().toISOString(), approved_by: selfMemberId, points_awarded: a.chore?.points ?? 0,
    }).eq('id', a.id);
    setBusy(null);
    if (error) return toastError(describeDbError(error));
    success(`Approved! +${a.chore?.points ?? 0} pts`); void refresh();
  }

  async function payChore(a: Assignment) {
    if (paying) return;
    setPaying(a.id); setMenuFor(null);
    const res = await payChoreRewardAction({ choreAssignmentId: a.id });
    setPaying(null);
    if (!res.ok) return toastError(res.error ?? 'Payment failed');
    success(tr('choresModule.paidToWallet')); void refresh();
  }

  async function removeChore(a: Assignment) {
    if (busy) return;
    setMenuFor(null);
    if (typeof window !== 'undefined' && !window.confirm(`Delete "${a.chore?.title ?? 'this chore'}"?`)) return;
    setBusy(a.id);
    const result = await deleteChoreAssignmentAction(a.id);
    setBusy(null);
    if (!result.ok) return toastError(result.error);
    success(tr('choresModule.choreRemoved')); void refresh();
  }

  async function redeem(r: Reward) {
    if (!selfMember) return toastError(tr('choresModule.noMemberProfileToRedeem'));
    if (busy) return;
    setBusy(r.id);
    const supabase = createClient();
    const instant = manager;
    const { error } = await supabase.from('reward_redemptions').insert({
      family_id: familyId, reward_id: r.id, member_id: selfMember.id, reward_title: r.title, cost_points: r.cost_points,
      status: instant ? 'approved' : 'requested',
      decided_by: instant ? selfMember.id : null, decided_at: instant ? new Date().toISOString() : null,
    });
    setBusy(null);
    if (error) return toastError(describeDbError(error));
    success(instant ? 'Reward redeemed!' : 'Redemption requested');
  }

  if (loading) return <SkeletonList count={6} />;
  if (error) return <ErrorState message={typeof error === 'string' ? error : 'Failed to load chores'} onRetry={refresh} />;

  const TABS: { key: Tab; label: string; count?: number }[] = [
    { key: 'mine', label: 'My Chores' },
    { key: 'all', label: 'All Chores' },
    { key: 'completed', label: 'Completed', count: completedRows.length },
    { key: 'approvals', label: 'Approvals', count: pendingApprovals.length },
    { key: 'store', label: 'Chore Store' },
  ];

  return (
    <div className="module-with-sidebar" onClick={() => menuFor && setMenuFor(null)}>
      <div className="module-main">
        <div className="module-page">
          <PageHeader
            title={tr('chores.chores')}
            description={tr('choresModule.buildResponsibilityEarnRewardsAnd')}
            action={manager ? (
              <>
                <Button onClick={() => { setPrefill(null); setAddOpen(true); }}><Plus className="h-4 w-4" /> {tr('chores.addChore')}</Button>
                <Button variant="outline" onClick={() => setTemplatesOpen(true)}><LayoutTemplate className="h-4 w-4" /> {tr('chores.choreTemplates')}</Button>
                <Link href="/dashboard/workload"
                  className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm font-semibold text-muted transition hover:text-fg hover:bg-elevated">
                  <Scale className="h-4 w-4" /> {tr('chores.workloadBalance')}
                </Link>
              </>
            ) : undefined}
          />

          {/* Tabs */}
          <div className="tab-bar border-b border-border pb-px">
            {TABS.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={cn('relative flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition',
                  tab === t.key ? 'text-fg' : 'text-muted hover:text-fg')}>
                {t.label}
                {typeof t.count === 'number' && t.count > 0 && (
                  <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-bold',
                    t.key === 'approvals' ? 'bg-amber-500/20 text-amber-400' : 'bg-brand/20 text-brand-text')}>{t.count}</span>
                )}
                {tab === t.key && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand" />}
              </button>
            ))}
          </div>

          {/* Child filter pills */}
          {(tab === 'mine' || tab === 'all' || tab === 'completed') && (
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => setChildFilter(null)}
                className={cn('flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition',
                  childFilter === null ? 'border-brand bg-brand/10 text-fg' : 'border-border bg-surface/40 text-muted hover:text-fg')}>
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-elevated"><Users className="h-3.5 w-3.5" /></span>
                All
              </button>
              {memberChips.shown.map((m) => (
                <button key={m.id} onClick={() => setChildFilter(m.id)}
                  className={cn('flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition',
                    childFilter === m.id ? 'border-brand bg-brand/10' : 'border-border bg-surface/40 hover:bg-elevated/40')}>
                  <Avatar name={m.display_name} color={m.color} size={28} />
                  <span className="leading-tight">
                    <span className="block text-sm font-medium">{m.display_name}</span>
                    <span className="block text-[11px] text-muted">{pointsMap.get(m.id) ?? 0} pts</span>
                  </span>
                </button>
              ))}
              <ShowMoreChip overflow={memberChips.overflow} expanded={memberChips.expanded} onToggle={memberChips.toggle} />
              {manager && (
                <button onClick={() => router.push('/dashboard/settings#members')}
                  className="flex items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2 text-sm text-muted transition hover:text-fg hover:border-brand/50">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-elevated"><Plus className="h-4 w-4" /></span>
                  {tr('chores.addChild')}
                </button>
              )}
            </div>
          )}

          {/* Body per tab */}
          {(tab === 'mine' || tab === 'all') && (
            <div className="space-y-6">
              <ChoreTable
                title={tr('chores.dailyChores')} rows={groups.daily} {...rowProps()} />
              <ChoreTable
                title={tr('chores.weeklyChores')} rows={groups.weekly} {...rowProps()} />
              {groups.other.length > 0 && <ChoreTable title={tr('chores.otherChores')} rows={groups.other} {...rowProps()} />}
              {groups.daily.length + groups.weekly.length + groups.other.length === 0 && (
                <EmptyState icon={CheckCircle2} title={tr('chores.allCaughtUp')}
                  description={tab === 'mine' ? 'You have no chores assigned right now.' : 'No active chores. Add one to get started.'}
                  action={manager ? <Button onClick={() => { setPrefill(null); setAddOpen(true); }}><Plus className="h-4 w-4" /> {tr('chores.addChore')}</Button> : undefined} />
              )}
              <CompletedStrip rows={completedScoped} memberById={memberById} onViewAll={() => setTab('completed')} />
            </div>
          )}

          {tab === 'completed' && (
            <CompletedGrid rows={completedScoped} memberById={memberById} />
          )}

          {tab === 'approvals' && (
            <div className="space-y-2">
              {pendingApprovals.length === 0 ? (
                <EmptyState icon={CheckCircle2} title={tr('chores.nothingToReview')} description={tr('choresModule.submittedChoresWillAppearHere')} />
              ) : pendingApprovals.map((a) => {
                const m = memberById.get(a.member_id);
                return (
                  <div key={a.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-4 py-3">
                    <span className="text-2xl">{choreEmoji(a.chore)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{a.chore?.title ?? 'Chore'}</div>
                      <div className="text-xs text-muted">{m?.display_name ?? 'Someone'} {tr('chores.submitted')} {timeAgo(a.submitted_at)}</div>
                    </div>
                    <span className="flex items-center gap-1 text-xs font-semibold text-emerald-400"><Star className="h-3.5 w-3.5 fill-emerald-400" /> {a.chore?.points ?? 0} pts</span>
                    {manager && (
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => setStatus(a, 'rejected')} disabled={busy === a.id}>{tr('chores.redo')}</Button>
                        <Button size="sm" onClick={() => approve(a)} loading={busy === a.id}>{tr('chores.approve')}</Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {tab === 'store' && (
            <div className="grid-cards">
              {(rewards ?? []).length === 0 ? (
                <div className="col-span-full"><EmptyState icon={Gift} title={tr('chores.noRewardsYet')}
                  description={tr('choresModule.setUpRewardsYourFamily')}
                  action={<Button variant="outline" onClick={() => router.push('/dashboard/rewards')}>{tr('chores.manageRewards')}</Button>} /></div>
              ) : (rewards ?? []).map((r) => {
                const selfPts = selfMemberId ? pointsMap.get(selfMemberId) ?? 0 : 0;
                const affordable = selfPts >= r.cost_points;
                return (
                  <div key={r.id} className="flex flex-col rounded-xl border border-border bg-surface/40 p-4">
                    <div className="flex items-start justify-between">
                      <span className="text-3xl">{choreEmoji(null)}</span>
                      <span className="flex items-center gap-1 rounded-full bg-brand/15 px-2 py-1 text-xs font-bold text-brand-text"><Star className="h-3 w-3 fill-brand" /> {r.cost_points}</span>
                    </div>
                    <div className="mt-2 text-sm font-semibold">{r.title}</div>
                    {r.description && <div className="text-xs text-muted line-clamp-2">{r.description}</div>}
                    <Button size="sm" className="mt-3" disabled={r.redeemed_at != null || (!manager && !affordable) || busy === r.id}
                      loading={busy === r.id} onClick={() => redeem(r)}>
                      {r.redeemed_at ? 'Redeemed' : affordable || manager ? 'Redeem' : `Need ${r.cost_points - selfPts} more`}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right rail */}
      <div className="module-sidebar hidden lg:flex lg:flex-col gap-4">
        {/* Family Chore Points */}
        <div className="sidebar-card relative overflow-hidden">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold">{tr('chores.familyChorePoints')}</p>
            <div className="relative">
              <select value={pointsWindow} onChange={(e) => setPointsWindow(e.target.value as typeof pointsWindow)}
                className="appearance-none rounded-lg border border-border bg-surface/60 py-1 pl-2 pr-6 text-[11px] text-muted focus-ring">
                <option value="week">{tr('chores.thisWeek')}</option>
                <option value="month">{tr('chores.thisMonth')}</option>
                <option value="all">{tr('chores.allTime')}</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1.5 h-3 w-3 text-muted" />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-4xl font-extrabold text-fg">{familyPoints}</div>
              <div className="text-xs text-muted">{tr('chores.totalPointsEarned')}</div>
            </div>
            <Trophy className="h-14 w-14 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.35)]" />
          </div>
          <button onClick={() => setTab('completed')} className="mt-3 text-xs font-medium text-brand-text hover:underline">{tr('chores.viewLeaderboard')}</button>
        </div>

        {/* Top Earners */}
        <div className="sidebar-card">
          <p className="mb-3 text-sm font-semibold">{tr('chores.topEarners')}</p>
          <div className="space-y-2.5">
            {earners.slice(0, 4).map((e) => (
              <div key={e.member.id} className="flex items-center gap-2.5">
                <span className="w-5 text-center text-sm">{RANK_MEDALS[e.rank - 1] ?? <span className="text-xs font-semibold text-muted">{e.rank}</span>}</span>
                <Avatar name={e.member.display_name} color={e.member.color} size={26} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{e.member.display_name}</span>
                <span className="text-sm font-semibold text-fg">{e.points} pts</span>
              </div>
            ))}
            {earners.length === 0 && <p className="text-xs text-muted">{tr('chores.noPointsEarnedYet')}</p>}
          </div>
          <button onClick={() => setTab('completed')} className="mt-3 flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">
            <ChevronRight className="h-3 w-3" /> {tr('chores.viewFullLeaderboard')}
          </button>
        </div>

        {/* Chore Streaks */}
        <div className="sidebar-card">
          <p className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Flame className="h-4 w-4 text-orange-400" /> {tr('chores.choreStreaks')}</p>
          <div className="space-y-2.5">
            {streaks.slice(0, 4).map((s) => (
              <div key={s.member.id} className="flex items-center gap-2.5">
                <Avatar name={s.member.display_name} color={s.member.color} size={24} />
                <span className="min-w-0 flex-1 truncate text-sm">{s.member.display_name}</span>
                <span className="text-sm font-semibold text-orange-400">{s.days} {s.days === 1 ? 'day' : 'days'}</span>
              </div>
            ))}
            {streaks.length === 0 && <p className="text-xs text-muted">{tr('chores.noActiveStreaksCompleteAChore')}</p>}
          </div>
          {streaks.length > 0 && (
            <button onClick={() => setTab('completed')} className="mt-3 flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">
              <ChevronRight className="h-3 w-3" /> {tr('chores.viewAllStreaks')}
            </button>
          )}
        </div>

        {/* Rewards Progress */}
        <div className="sidebar-card">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold">{tr('chores.rewardsProgress')}</p>
            <button onClick={() => router.push('/dashboard/rewards')} className="text-xs font-medium text-brand-text hover:underline">{tr('chores.manageRewards')}</button>
          </div>
          {progress ? (
            <>
              <p className="text-xs text-muted">{progress.member.display_name} is {progress.remaining} {tr('chores.pointsAwayFromNextReward')}</p>
              <div className="mt-2 flex items-center gap-2">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-elevated">
                  <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${progress.pct}%` }} />
                </div>
                <span className="shrink-0 text-[11px] text-muted">{progress.points} / {progress.cost} pts</span>
              </div>
              <div className="mt-3 flex items-center gap-2 text-xs">
                <Gift className="h-4 w-4 text-brand-text" />
                <span className="text-muted">{tr('chores.nextReward')}</span>
                <span className="font-medium">{progress.rewardTitle}</span>
              </div>
            </>
          ) : (
            <button onClick={() => router.push('/dashboard/rewards')} className="text-xs text-muted hover:text-fg">
              {tr('chores.addARewardToGiveChores')}
            </button>
          )}
        </div>

        {/* Need Approval */}
        <div className="sidebar-card">
          <p className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
            {tr('chores.needApproval')}
            {pendingApprovals.length > 0 && <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-400">{pendingApprovals.length}</span>}
          </p>
          <div className="space-y-2.5">
            {pendingApprovals.slice(0, 3).map((a) => {
              const m = memberById.get(a.member_id);
              return (
                <div key={a.id} className="flex items-center gap-2">
                  <Avatar name={m?.display_name ?? '?'} color={m?.color} size={26} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs"><span className="font-medium">{m?.display_name ?? 'Someone'}</span> submitted <span className="font-medium">{a.chore?.title}</span></div>
                    <div className="text-[10px] text-muted">{timeAgo(a.submitted_at)}</div>
                  </div>
                  {manager && (
                    <button onClick={() => approve(a)} disabled={busy === a.id}
                      className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium hover:bg-elevated disabled:opacity-50">{tr('chores.review')}</button>
                  )}
                </div>
              );
            })}
            {pendingApprovals.length === 0 && <p className="text-xs text-muted">{tr('chores.nothingWaitingForApproval')}</p>}
          </div>
          {pendingApprovals.length > 0 && (
            <button onClick={() => setTab('approvals')} className="mt-3 flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">
              <ChevronRight className="h-3 w-3" /> {tr('chores.viewAllApprovals')}
            </button>
          )}
        </div>
      </div>

      {addOpen && manager && (
        <NewChoreModal familyId={familyId} userId={userId} members={members} prefill={prefill}
          onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void refresh(); }} />
      )}
      {templatesOpen && (
        <TemplatesModal onClose={() => setTemplatesOpen(false)}
          onPick={(t) => { setTemplatesOpen(false); setPrefill(t); setAddOpen(true); }} />
      )}
    </div>
  );

  // Shared row-action props for ChoreTable instances.
  function rowProps() {
    return {
      memberById, manager, busy, paying, menuFor, setMenuFor,
      onStatus: setStatus, onApprove: approve, onPay: payChore, onDelete: removeChore,
    };
  }
}

// ── Chore table (Daily / Weekly / Other) ────────────────────────────────────
type RowProps = {
  memberById: Map<string, Tables<'family_members'>>;
  manager: boolean;
  busy: string | null;
  paying: string | null;
  menuFor: string | null;
  setMenuFor: (id: string | null) => void;
  onStatus: (a: Assignment, next: string) => void;
  onApprove: (a: Assignment) => void;
  onPay: (a: Assignment) => void;
  onDelete: (a: Assignment) => void;
};

function ChoreTable({ title, rows, ...p }: { title: string; rows: AssignmentLike[] } & RowProps) {
  const tr = useTranslations();
  if (rows.length === 0) return null;
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="rounded-full bg-brand/15 px-2 py-0.5 text-xs font-bold text-brand-text">{rows.length}</span>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-surface/30">
        <div className="hidden grid-cols-[1fr_150px_120px_110px_140px_40px] border-b border-border bg-surface/40 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted lg:grid">
          <div>{tr('chores.chore')}</div><div>{tr('chores.assignee')}</div><div>Due</div><div>{tr('chores.reward')}</div><div>{tr('chores.status')}</div><div />
        </div>
        <div className="divide-y divide-border/50">
          {rows.map((a) => <ChoreRow key={a.id} a={a as Assignment} {...p} />)}
        </div>
      </div>
    </section>
  );
}

function ChoreRow({ a, memberById, manager, busy, paying, menuFor, setMenuFor, onStatus, onApprove, onPay, onDelete }: { a: Assignment } & RowProps) {
  const tr = useTranslations();
  const member = memberById.get(a.member_id);
  const due = dueLabel(a.due_at);
  const status = STATUS_META[a.status] ?? STATUS_META.todo;
  const StatusIcon = status.icon;
  const done = isCompleted(a.status);
  const canPay = manager && done && (a.chore?.cash_cents ?? 0) > 0 && !a.cash_awarded_cents;
  // Assignee can advance their own chore's status; managers can act on any.
  const nextStatus = a.status === 'todo' ? 'in_progress' : a.status === 'in_progress' ? 'submitted' : null;

  return (
    <div className="grid grid-cols-1 items-center gap-2 px-4 py-3 transition hover:bg-surface/20 lg:grid-cols-[1fr_150px_120px_110px_140px_40px]">
      {/* Chore */}
      <div className="flex items-center gap-3 min-w-0">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-elevated text-lg">{choreEmoji(a.chore)}</span>
        <div className="min-w-0">
          <div className={cn('truncate text-sm font-medium', done && 'text-muted line-through')}>{a.chore?.title ?? '—'}</div>
          {a.chore?.description && <div className="truncate text-xs text-muted">{a.chore.description}</div>}
        </div>
      </div>
      {/* Assignee */}
      <div className="flex items-center gap-2">
        {member ? <><Avatar name={member.display_name} color={member.color} size={22} /><span className="text-xs text-muted lg:text-sm">{member.display_name}</span></> : <span className="text-xs text-muted">{tr('chores.unassigned')}</span>}
      </div>
      {/* Due */}
      <div className={cn('text-xs font-medium', DUE_TONE[due.tone])}>{due.label}</div>
      {/* Reward */}
      <div className="flex items-center gap-1 text-sm font-semibold text-emerald-400">
        <Star className="h-3.5 w-3.5 fill-emerald-400" /> {a.chore?.points ?? 0} pts
      </div>
      {/* Status */}
      <div>
        <button
          onClick={() => nextStatus && !done ? onStatus(a, nextStatus) : undefined}
          disabled={!!busy || done || !nextStatus}
          className={cn('inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition',
            status.cls, nextStatus && !done && 'hover:bg-elevated cursor-pointer', busy === a.id && 'animate-pulse')}>
          <StatusIcon className="h-3.5 w-3.5" /> {status.label}
        </button>
      </div>
      {/* Kebab */}
      <div className="flex justify-end lg:justify-center">
        <div className="relative">
          <button onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === a.id ? null : a.id); }}
            className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg" aria-label={tr('chores.choreActions')}>
            <MoreVertical className="h-4 w-4" />
          </button>
          {menuFor === a.id && (
            <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-xl border border-border bg-elevated shadow-lg" onClick={(e) => e.stopPropagation()}>
              {a.status === 'todo' && <MenuItem onClick={() => onStatus(a, 'in_progress')}><Clock className="h-3.5 w-3.5" /> {tr('chores.startInProgress')}</MenuItem>}
              {!done && a.status !== 'submitted' && <MenuItem onClick={() => onStatus(a, 'submitted')}><CheckCircle2 className="h-3.5 w-3.5" /> {tr('chores.submitForApproval')}</MenuItem>}
              {manager && a.status === 'submitted' && <MenuItem onClick={() => onApprove(a)}><CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> {tr('chores.approve')}</MenuItem>}
              {done && a.status !== 'todo' && <MenuItem onClick={() => onStatus(a, 'todo')}><Circle className="h-3.5 w-3.5" /> {tr('chores.reopen')}</MenuItem>}
              {canPay && <MenuItem onClick={() => onPay(a)}><Sparkles className="h-3.5 w-3.5 text-amber-400" /> {paying === a.id ? 'Paying…' : `Pay ${formatCents(a.chore!.cash_cents!)}`}</MenuItem>}
              {manager && <MenuItem danger onClick={() => onDelete(a)}><Trash2 className="h-3.5 w-3.5" /> {tr('chores.delete')}</MenuItem>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick}
      className={cn('flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-surface',
        danger ? 'text-rose-400' : 'text-fg')}>
      {children}
    </button>
  );
}

// ── Completed views ─────────────────────────────────────────────────────────
function CompletedStrip({ rows, memberById, onViewAll }: { rows: Assignment[]; memberById: Map<string, Tables<'family_members'>>; onViewAll: () => void }) {
  const tr = useTranslations();
  if (rows.length === 0) return null;
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">{tr('chores.completedChores')}</h2>
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-bold text-emerald-400">{rows.length}</span>
        </div>
        <button onClick={onViewAll} className="flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">{tr('chores.viewAll')} <ChevronRight className="h-3 w-3" /></button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.slice(0, 6).map((a) => <CompletedCard key={a.id} a={a} member={memberById.get(a.member_id)} />)}
      </div>
    </section>
  );
}

function CompletedGrid({ rows, memberById }: { rows: Assignment[]; memberById: Map<string, Tables<'family_members'>> }) {
  const tr = useTranslations();
  if (rows.length === 0) return <EmptyState icon={CheckCircle2} title={tr('chores.noCompletedChoresYet')} description={tr('choresModule.approvedChoresShowUpHere')} />;
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((a) => <CompletedCard key={a.id} a={a} member={memberById.get(a.member_id)} />)}
    </div>
  );
}

function CompletedCard({ a, member }: { a: Assignment; member?: Tables<'family_members'> }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{a.chore?.title ?? '—'}</div>
        <div className="text-[11px] text-muted">{member?.display_name ?? 'Someone'} · {a.approved_at ? new Date(a.approved_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Done'}</div>
      </div>
      <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-amber-400"><Star className="h-3.5 w-3.5 fill-amber-400" /> {a.points_awarded ?? a.chore?.points ?? 0} pts</span>
    </div>
  );
}

// ── Add / template modals ────────────────────────────────────────────────────
type ChoreDraft = {
  title: string; description: string; member_id: string; points: number;
  priority: 'low' | 'medium' | 'high'; recurrence: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'; due_at: string; icon: string;
};

const CHORE_TEMPLATES: { icon: string; title: string; description: string; points: number; recurrence: ChoreDraft['recurrence'] }[] = [
  { icon: '🛏️', title: 'Make Bed', description: 'Make your bed and tidy up', points: 10, recurrence: 'daily' },
  { icon: '🍽️', title: 'Clean Dishes', description: 'Load or unload the dishwasher', points: 15, recurrence: 'daily' },
  { icon: '🗑️', title: 'Take Out Trash', description: 'Take the trash to the curb', points: 10, recurrence: 'daily' },
  { icon: '📖', title: 'Homework Time', description: 'Complete 30 min of homework', points: 20, recurrence: 'daily' },
  { icon: '🐾', title: 'Feed the Pet', description: 'Give food and fresh water', points: 10, recurrence: 'daily' },
  { icon: '🧹', title: 'Vacuum Living Room', description: 'Vacuum floors and rug', points: 25, recurrence: 'weekly' },
  { icon: '🍴', title: 'Set the Table', description: 'Set the table for dinner', points: 15, recurrence: 'weekly' },
  { icon: '🧺', title: 'Laundry', description: 'Wash, dry, and fold clothes', points: 30, recurrence: 'weekly' },
  { icon: '🪴', title: 'Water Plants', description: 'Water all indoor plants', points: 10, recurrence: 'weekly' },
  { icon: '🚿', title: 'Clean Bathroom', description: 'Wipe surfaces and mirror', points: 20, recurrence: 'weekly' },
];

function TemplatesModal({ onClose, onPick }: { onClose: () => void; onPick: (t: Partial<ChoreDraft>) => void }) {
  const tr = useTranslations();
  return (
    <Modal open title={tr('chores.choreTemplates')} onClose={onClose}>
      <p className="mb-3 text-sm text-muted">{tr('chores.pickAStartingPointYouCan')}</p>
      <div className="grid max-h-[60vh] gap-2 overflow-y-auto sm:grid-cols-2">
        {CHORE_TEMPLATES.map((t) => (
          <button key={t.title} onClick={() => onPick({ title: t.title, description: t.description, points: t.points, recurrence: t.recurrence, icon: t.icon })}
            className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 p-3 text-left transition hover:border-brand/50 hover:bg-elevated/40">
            <span className="text-2xl">{t.icon}</span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{t.title}</span>
              <span className="block truncate text-xs text-muted">{t.description}</span>
            </span>
            <span className="ml-auto shrink-0 text-xs font-semibold text-emerald-400">{t.points} pts</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function NewChoreModal({ familyId, userId, members, prefill, onClose, onSaved }: {
  familyId: string; userId: string;
  members: { id: string; display_name: string; color: string | null }[];
  prefill: Partial<ChoreDraft> | null;
  onClose: () => void; onSaved: () => void;
}) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  // One id per open modal, so a retry after a failed save is the SAME chore and
  // a second Add (a new modal) is a different one. The modal is mounted only
  // while `addOpen`, so closing and reopening mints a fresh id.
  const submissionId = useRef('');
  if (!submissionId.current) submissionId.current = newSubmissionId();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    const description = String(form.get('description') ?? '').trim() || null;
    const memberId = String(form.get('member_id') ?? '');
    const points = Number(form.get('points') ?? 10);
    const priority = String(form.get('priority') ?? 'medium') as ChoreDraft['priority'];
    const recurrence = String(form.get('recurrence') ?? 'none') as ChoreDraft['recurrence'];
    const due_at = String(form.get('due_at') ?? '') || null;
    const icon = String(form.get('icon') ?? '').trim() || null;

    if (!title) return toastError(tr('choresModule.addAChoreTitle'));
    if (title.length > 160) return toastError('Title is too long (max 160 characters)');
    if (!memberId) return toastError(tr('choresModule.pickWhoThisChoreIs'));
    if (!Number.isFinite(points) || points < 0 || points > 1000) return toastError(tr('choresModule.rewardMustBeBetween0'));

    setLoading(true);
    try {
      // One call. `createChore` creates the chore and its assignment together and
      // rolls the chore back FAMILY-SCOPED if the assignment fails, where this
      // rolled back on `id` alone.
      const result = await createChoreAction({
        title, description, points, priority, recurrence, icon,
        dueAt: due_at, assigneeId: memberId, submissionId: submissionId.current,
      });
      if (!result.ok) { toastError(result.error); return; }
      onSaved();
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open title={tr('chores.addChore')} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <input type="hidden" name="icon" defaultValue={prefill?.icon ?? ''} />
        <Field label={tr('chores.title')} required>
          {(id) => <Input id={id} name="title" autoFocus placeholder={tr('chores.makeTheBed')} defaultValue={prefill?.title ?? ''} />}
        </Field>
        <Field label={tr('chores.description')}>
          {(id) => <Textarea id={id} name="description" rows={2} placeholder={tr('chores.whatNeedsToBeDone')} defaultValue={prefill?.description ?? ''} />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('chores.assignTo')} required>
            {(id) => <Select id={id} name="member_id"><option value="">{tr('chores.pickMember')}</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}
          </Field>
          <Field label={tr('chores.priority')}>
            {(id) => <Select id={id} name="priority" defaultValue={prefill?.priority ?? 'medium'}><option value="low">Low</option><option value="medium">{tr('chores.medium')}</option><option value="high">{tr('chores.high')}</option></Select>}
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('chores.rewardPoints')}>{(id) => <Input id={id} name="points" type="number" defaultValue={String(prefill?.points ?? 10)} min="0" max="1000" />}</Field>
          <Field label={tr('chores.dueDate')}>{(id) => <Input id={id} name="due_at" type="date" />}</Field>
        </div>
        <Field label={tr('chores.repeat')}>
          {(id) => (
            <Select id={id} name="recurrence" defaultValue={prefill?.recurrence ?? 'none'}>
              <option value="none">{tr('chores.noRepeat')}</option>
              <option value="daily">{tr('chores.everyDay')}</option>
              <option value="weekly">{tr('chores.everyWeek')}</option>
              <option value="monthly">{tr('chores.everyMonth')}</option>
              <option value="yearly">{tr('chores.everyYear')}</option>
            </Select>
          )}
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('chores.cancel')}</Button>
          <Button type="submit" loading={loading}>{loading ? 'Saving…' : 'Add Chore'}</Button>
        </div>
      </form>
    </Modal>
  );
}
