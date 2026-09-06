'use client';

import { useMemo, useState } from 'react';
import {
  Gift, Plus, Pencil, Trash2, Coins, Trophy, Check, X, Clock,
  Sparkles, History,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { cn } from '@/lib/utils/cn';
import {
  computeBalances, canAfford, REDEMPTION_STATUS_LABELS,
  type AssignmentLike, type RedemptionLike,
} from '@/lib/rewards/points';
import type { Tables, RedemptionStatus } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Reward = Tables<'rewards'>;
type Redemption = Tables<'reward_redemptions'>;
type Assignment = Tables<'chore_assignments'>;

const STATUS_STYLES: Record<RedemptionStatus, string> = {
  requested: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  approved: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  fulfilled: 'text-blue-300 bg-blue-500/10 border-blue-500/30',
  rejected: 'text-rose-300 bg-rose-500/10 border-rose-500/30',
};

const blankReward = { id: '', title: '', description: '', cost_points: 100 };

export function RewardsModule() {
  const t = useTranslations();
  const { familyId, userId, members, selfMember, role } = useApp();
  const { success, error: toastError } = useToast();
  const canManage = isManager(role);

  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(blankReward);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const { data: rewards, loading, error } = useRealtimeQuery<Reward>({
    table: 'rewards', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('rewards').select('*').eq('family_id', familyId).order('cost_points'),
  });
  const { data: assignments } = useRealtimeQuery<Assignment>({
    table: 'chore_assignments', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('chore_assignments').select('*').eq('family_id', familyId).eq('status', 'approved'),
  });
  const { data: redemptions } = useRealtimeQuery<Redemption>({
    table: 'reward_redemptions', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('reward_redemptions').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
  });

  const memberName = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? null;

  const balances = useMemo(() => computeBalances(
    members.map((m) => m.id),
    (assignments ?? []).map<AssignmentLike>((a) => ({ member_id: a.member_id, status: a.status, points_awarded: a.points_awarded })),
    (redemptions ?? []).map<RedemptionLike>((r) => ({ member_id: r.member_id, cost_points: r.cost_points, status: r.status })),
  ), [members, assignments, redemptions]);
  const balanceByMember = useMemo(() => new Map(balances.map((b) => [b.memberId, b])), [balances]);
  const selfBalance = selfMember ? balanceByMember.get(selfMember.id) : undefined;

  const pending = useMemo(() => (redemptions ?? []).filter((r) => r.status === 'requested'), [redemptions]);
  const history = useMemo(() => (redemptions ?? []).filter((r) => r.status !== 'requested').slice(0, 12), [redemptions]);

  const sortedBalances = useMemo(() => [...balances].sort((a, b) => b.available - a.available), [balances]);

  // ── Reward CRUD ───────────────────────────────────────────
  function openNew() { setForm(blankReward); setModalOpen(true); }
  function openEdit(r: Reward) { setForm({ id: r.id, title: r.title, description: r.description ?? '', cost_points: r.cost_points }); setModalOpen(true); }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) { toastError('Title is required'); return; }
    if (form.cost_points < 0) { toastError('Cost must be 0 or more'); return; }
    setSaving(true);
    const sb = createClient();
    const fields = { title: form.title.trim(), description: form.description.trim() || null, cost_points: Math.round(form.cost_points) };
    const { error: err } = form.id
      ? await sb.from('rewards').update(fields).eq('id', form.id)
      : await sb.from('rewards').insert({ ...fields, family_id: familyId, created_by: userId });
    setSaving(false);
    if (err) { toastError(describeDbError(err)); return; }
    success(form.id ? 'Reward updated' : 'Reward added');
    setModalOpen(false);
  }

  async function remove(r: Reward) {
    if (!confirm(`Delete the reward "${r.title}"?`)) return;
    const sb = createClient();
    const { error: err } = await sb.from('rewards').delete().eq('id', r.id);
    if (err) { toastError(describeDbError(err)); return; }
    success('Reward deleted');
  }

  // ── Redemption flow ───────────────────────────────────────
  async function requestReward(r: Reward, forMemberId: string) {
    setBusy(r.id);
    const sb = createClient();
    const { error: err } = await sb.from('reward_redemptions').insert({
      family_id: familyId, reward_id: r.id, member_id: forMemberId,
      reward_title: r.title, cost_points: r.cost_points,
      // A manager redeeming for themselves can approve instantly; otherwise it
      // enters the approval queue.
      status: canManage && forMemberId === selfMember?.id ? 'approved' : 'requested',
      decided_by: canManage && forMemberId === selfMember?.id ? selfMember?.id ?? null : null,
      decided_at: canManage && forMemberId === selfMember?.id ? new Date().toISOString() : null,
    });
    setBusy(null);
    if (err) { toastError(describeDbError(err)); return; }
    success(canManage && forMemberId === selfMember?.id ? 'Reward redeemed' : 'Redemption requested');
  }

  async function decide(red: Redemption, status: RedemptionStatus) {
    setBusy(red.id);
    const sb = createClient();
    const { error: err } = await sb.from('reward_redemptions').update({
      status, decided_by: selfMember?.id ?? null, decided_at: new Date().toISOString(),
    }).eq('id', red.id);
    setBusy(null);
    if (err) { toastError(describeDbError(err)); return; }
    success(status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'Marked fulfilled');
  }

  if (loading) return <SkeletonList count={5} />;
  if (error) return <ErrorState message={typeof error === 'string' ? error : 'Failed to load rewards'} />;

  return (
    <div>
      <PageHeader
        title={t('rewards.rewardsAllowance')}
        description="Turn chore points into rewards. Kids request, parents approve, everyone sees the leaderboard."
        action={
          <div className="flex items-center gap-2">
            <AiInsight kind="rewards" iconOnly />
            {canManage && <Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> {t('rewards.addReward')}</Button>}
          </div>
        }
      />

      {/* Balances leaderboard */}
      <div className="rounded-2xl bg-surface/50 border border-border p-5 mb-6">
        <h2 className="text-sm font-semibold text-fg uppercase tracking-wider mb-4 flex items-center gap-2">
          <Trophy className="h-4 w-4 text-amber-400" /> {t('rewards.pointsLeaderboard')}
        </h2>
        {sortedBalances.length === 0 ? (
          <p className="text-muted text-sm">{t('rewards.noFamilyMembersYet')}</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {sortedBalances.map((b, i) => {
              const m = members.find((mm) => mm.id === b.memberId);
              if (!m) return null;
              return (
                <div key={b.memberId} className={cn('rounded-xl border p-4 text-center', i === 0 && b.available > 0 ? 'border-amber-500/40 bg-amber-500/[0.04]' : 'border-border bg-surface/40')}>
                  <div className="flex justify-center mb-2 relative">
                    <Avatar name={m.display_name} size={40} />
                    {i === 0 && b.available > 0 && <Trophy className="h-4 w-4 text-amber-400 absolute -top-1 -right-1" />}
                  </div>
                  <div className="text-sm font-medium text-fg truncate">{m.display_name}</div>
                  <div className="mt-1 text-2xl font-bold text-amber-400 tabular-nums flex items-center justify-center gap-1">
                    <Coins className="h-4 w-4" />{b.available}
                  </div>
                  <div className="text-[11px] text-muted mt-0.5">{b.earned} {t('rewards.earned')} {b.spent} spent</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pending approvals (managers) */}
      {canManage && pending.length > 0 && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 mb-6">
          <h2 className="text-sm font-semibold text-amber-400 uppercase tracking-wider mb-4 flex items-center gap-2">
            <Clock className="h-4 w-4" /> {t('rewards.pendingApprovals')}{pending.length})
          </h2>
          <div className="space-y-2">
            {pending.map((red) => {
              const bal = balanceByMember.get(red.member_id);
              const affordable = canAfford(bal, red.cost_points);
              return (
                <div key={red.id} className="flex items-center gap-3 rounded-xl bg-surface/50 border border-border px-3 py-2.5">
                  <Avatar name={memberName(red.member_id) ?? '?'} size={28} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-fg truncate">{memberName(red.member_id)} wants {red.reward_title}</div>
                    <div className="text-xs text-muted">
                      {red.cost_points} {t('rewards.pts')} {affordable ? `${bal?.available} available` : <span className="text-rose-400">{t('rewards.notEnoughPoints')}{bal?.available ?? 0})</span>}
                    </div>
                  </div>
                  <button onClick={() => decide(red, 'approved')} disabled={busy === red.id || !affordable}
                    className="inline-flex h-8 px-3 items-center justify-center gap-1 rounded-lg border border-emerald-500/50 text-emerald-300 text-xs font-medium hover:bg-emerald-500/10 disabled:opacity-40">
                    <Check className="h-3.5 w-3.5" /> {t('rewards.approve')}
                  </button>
                  <button onClick={() => decide(red, 'rejected')} disabled={busy === red.id}
                    className="inline-flex h-8 px-3 items-center justify-center gap-1 rounded-lg border border-rose-500/50 text-rose-300 text-xs font-medium hover:bg-rose-500/10 disabled:opacity-40">
                    <X className="h-3.5 w-3.5" /> {t('rewards.reject')}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Rewards catalog */}
      <h2 className="text-sm font-semibold text-fg uppercase tracking-wider mb-3 flex items-center gap-2">
        <Gift className="h-4 w-4 text-brand-text" /> {t('rewards.rewardsCatalog')}
      </h2>
      {(rewards ?? []).length === 0 ? (
        <EmptyState icon={Gift} title={t('rewards.noRewardsYet')}
          description={canManage ? 'Add rewards kids can redeem with the points they earn from chores.' : 'No rewards have been added yet.'}
          action={canManage && <Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> {t('rewards.addReward')}</Button>} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {(rewards ?? []).map((r) => {
            const affordableForSelf = canAfford(selfBalance, r.cost_points);
            return (
              <div key={r.id} className="rounded-2xl border border-border bg-surface/50 p-5 flex flex-col">
                <div className="flex items-start justify-between gap-2">
                  <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand-text flex-shrink-0">
                    <Gift className="h-5 w-5" />
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-1">
                      <button onClick={() => openEdit(r)} aria-label={t('rewards.edit')} className="p-1.5 rounded-lg text-muted hover:text-fg hover:bg-elevated"><Pencil className="h-4 w-4" /></button>
                      <button onClick={() => remove(r)} aria-label={t('rewards.delete')} className="p-1.5 rounded-lg text-muted hover:text-rose-400 hover:bg-elevated"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  )}
                </div>
                <div className="mt-3 font-semibold text-fg">{r.title}</div>
                {r.description && <p className="mt-1 text-sm text-muted flex-1">{r.description}</p>}
                <div className="mt-3 flex items-center gap-1.5 text-amber-400 font-bold">
                  <Coins className="h-4 w-4" /> {r.cost_points} pts
                </div>
                <div className="mt-3">
                  {selfMember && (selfMember.role === 'child' || selfMember.role === 'teen') ? (
                    <Button onClick={() => requestReward(r, selfMember.id)} disabled={busy === r.id || !affordableForSelf}
                      variant={affordableForSelf ? 'primary' : 'outline'} className="w-full gap-1.5">
                      <Sparkles className="h-4 w-4" /> {affordableForSelf ? 'Redeem' : 'Not enough points'}
                    </Button>
                  ) : canManage ? (
                    <RedeemForMember reward={r} onRedeem={requestReward} members={members} balanceByMember={balanceByMember} busy={busy === r.id} />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-fg uppercase tracking-wider mb-3 flex items-center gap-2">
            <History className="h-4 w-4 text-muted" /> {t('rewards.recentRedemptions')}
          </h2>
          <div className="space-y-1.5">
            {history.map((red) => (
              <div key={red.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm">
                <Avatar name={memberName(red.member_id) ?? '?'} size={22} />
                <span className="text-fg/90 truncate">{memberName(red.member_id)} · {red.reward_title}</span>
                <span className="text-muted ml-auto tabular-nums">{red.cost_points} pts</span>
                <span className={cn('text-[10px] uppercase tracking-wide rounded border px-1.5 py-0.5', STATUS_STYLES[red.status])}>
                  {REDEMPTION_STATUS_LABELS[red.status]}
                </span>
                {canManage && red.status === 'approved' && (
                  <button onClick={() => decide(red, 'fulfilled')} disabled={busy === red.id}
                    className="text-xs font-medium text-blue-300 hover:underline">{t('rewards.markFulfilled')}</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reward modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={form.id ? 'Edit reward' : 'Add reward'}>
        <form onSubmit={save} className="space-y-4">
          <Field label={t('rewards.reward')} required>
            {(id) => <Input id={id} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder={t('rewards.eGMovieNightPick')} autoFocus />}
          </Field>
          <Field label={t('rewards.description')}>
            {(id) => <Textarea id={id} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder={t('rewards.whatDoesThisRewardInclude')} />}
          </Field>
          <Field label={t('rewards.costPoints')} required>
            {(id) => <Input id={id} type="number" min={0} step={5} value={form.cost_points} onChange={(e) => setForm((f) => ({ ...f, cost_points: Number(e.target.value) }))} />}
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>{t('rewards.cancel')}</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : form.id ? 'Save changes' : 'Add reward'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/** Manager control to redeem a reward on behalf of a child/teen. */
function RedeemForMember({ reward, onRedeem, members, balanceByMember, busy }: {
  reward: Reward;
  onRedeem: (r: Reward, memberId: string) => void;
  members: Tables<'family_members'>[];
  balanceByMember: Map<string, { available: number }>;
  busy: boolean;
}) {
  const t = useTranslations();
  const kids = members.filter((m) => m.role === 'child' || m.role === 'teen');
  const [memberId, setMemberId] = useState<string>(kids[0]?.id ?? '');
  if (kids.length === 0) return null;
  const bal = balanceByMember.get(memberId);
  const affordable = !!bal && bal.available >= reward.cost_points;
  return (
    <div className="flex gap-2">
      <select value={memberId} onChange={(e) => setMemberId(e.target.value)}
        className="h-9 flex-1 min-w-0 rounded-lg bg-surface/60 border border-border px-2 text-sm text-fg focus-ring">
        {kids.map((k) => <option key={k.id} value={k.id}>{k.display_name}</option>)}
      </select>
      <Button onClick={() => onRedeem(reward, memberId)} disabled={busy || !affordable} variant={affordable ? 'primary' : 'outline'} size="sm" className="gap-1">
        <Sparkles className="h-3.5 w-3.5" /> {t('rewards.redeem')}
      </Button>
    </div>
  );
}
