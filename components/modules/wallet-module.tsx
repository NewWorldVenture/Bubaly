'use client';

import { useMemo, useState } from 'react';
import {
  Wallet, Plus, Settings, ArrowUpRight, ArrowDownLeft,
  Target, Sparkles, X, PiggyBank, TrendingUp,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import {
  splitTotal, totalBalance, walletSummary, fmtMoney, rulesValid,
  bucketLabel, bucketEmoji, DEFAULT_BUCKETS, DEFAULT_SPLIT,
  BUCKET_META, type AllocationRule, type DefaultBucket,
} from '@/lib/wallet/ledger';
import type { Tables } from '@/lib/database.types';

type Bucket = Tables<'wallet_buckets'>;
type Rule = Tables<'wallet_rules'>;
type Txn = Tables<'wallet_transactions'>;

const KINDS = ['deposit', 'withdrawal', 'chore', 'gift', 'adjustment'] as const;

export function WalletModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const memberName = (id: string) => memberById.get(id)?.display_name ?? 'Member';

  const { data: buckets, loading } = useRealtimeQuery<Bucket>({
    table: 'wallet_buckets', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('wallet_buckets').select('*').eq('family_id', familyId).order('sort_order'),
  });
  const { data: rules } = useRealtimeQuery<Rule>({
    table: 'wallet_rules', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('wallet_rules').select('*').eq('family_id', familyId),
  });
  const { data: txns } = useRealtimeQuery<Txn>({
    table: 'wallet_transactions', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('wallet_transactions').select('*').eq('family_id', familyId).order('created_at', { ascending: false }).limit(100),
  });

  const [selectedMember, setSelectedMember] = useState<string | null>(null);
  const [depositForm, setDepositForm] = useState<{ memberId: string; amount: string; description: string; kind: string } | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [goalForm, setGoalForm] = useState<{ memberId: string; bucket: string; target: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiInsights, setAiInsights] = useState<{ advice: string; suggestions: string[] } | null>(null);

  const allBuckets = buckets ?? [];
  const allRules = rules ?? [];
  const allTxns = txns ?? [];

  const activeMember = selectedMember ?? members[0]?.id ?? null;
  const summary = useMemo(
    () => activeMember ? walletSummary(allBuckets, activeMember, allTxns) : null,
    [allBuckets, activeMember, allTxns],
  );

  const memberRules = useMemo(
    () => settingsFor ? allRules.filter((r) => r.member_id === settingsFor) : [],
    [allRules, settingsFor],
  );

  async function ensureBuckets(memberId: string) {
    const existing = allBuckets.filter((b) => b.member_id === memberId);
    const existingNames = new Set(existing.map((b) => b.bucket));
    const missing = DEFAULT_BUCKETS.filter((b) => !existingNames.has(b));
    if (missing.length === 0) return;

    const sb = createClient();
    const rows = missing.map((bucket, i) => ({
      family_id: familyId,
      member_id: memberId,
      bucket,
      balance_cents: 0,
      sort_order: DEFAULT_BUCKETS.indexOf(bucket as DefaultBucket),
    }));
    await sb.from('wallet_buckets').insert(rows);
  }

  async function deposit(e: React.FormEvent) {
    e.preventDefault();
    if (!depositForm) return;
    const cents = Math.round(parseFloat(depositForm.amount || '0') * 100);
    if (cents <= 0) return toastError('Enter a positive amount');

    setSaving(true);
    try {
      await ensureBuckets(depositForm.memberId);

      const memberR = allRules.filter((r) => r.member_id === depositForm.memberId);
      const allocRules: AllocationRule[] = memberR.length > 0
        ? memberR.map((r) => ({ bucket: r.bucket, pct: r.pct }))
        : Object.entries(DEFAULT_SPLIT).map(([bucket, pct]) => ({ bucket, pct }));

      const shares = splitTotal(cents, allocRules);
      const sb = createClient();

      for (const [bucket, shareCents] of shares) {
        await sb.from('wallet_transactions').insert({
          family_id: familyId,
          member_id: depositForm.memberId,
          bucket,
          amount_cents: shareCents,
          kind: depositForm.kind || 'deposit',
          description: depositForm.description.trim() || null,
          created_by: userId,
        });
        await sb.from('wallet_buckets')
          .update({ balance_cents: (allBuckets.find((b) => b.member_id === depositForm.memberId && b.bucket === bucket)?.balance_cents ?? 0) + shareCents })
          .eq('family_id', familyId)
          .eq('member_id', depositForm.memberId)
          .eq('bucket', bucket);
      }

      success('Deposited ' + fmtMoney(cents));
      setDepositForm(null);
    } catch { toastError('Could not deposit'); } finally { setSaving(false); }
  }

  async function saveRules(memberId: string, newRules: AllocationRule[]) {
    if (!rulesValid(newRules)) return toastError('Percentages must add up to 100%');
    setSaving(true);
    try {
      const sb = createClient();
      await sb.from('wallet_rules').delete().eq('family_id', familyId).eq('member_id', memberId);
      const rows = newRules.map((r) => ({
        family_id: familyId, member_id: memberId, bucket: r.bucket, pct: r.pct,
      }));
      const { error } = await sb.from('wallet_rules').insert(rows);
      if (error) return toastError(error.message);
      success('Allocation saved');
      setSettingsFor(null);
    } catch { toastError('Could not save'); } finally { setSaving(false); }
  }

  async function setGoal(e: React.FormEvent) {
    e.preventDefault();
    if (!goalForm) return;
    const targetCents = Math.round(parseFloat(goalForm.target || '0') * 100);
    if (targetCents <= 0) return toastError('Enter a goal amount');

    const sb = createClient();
    const { error } = await sb.from('wallet_buckets')
      .update({ target_cents: targetCents })
      .eq('family_id', familyId)
      .eq('member_id', goalForm.memberId)
      .eq('bucket', goalForm.bucket);
    if (error) return toastError(error.message);
    success('Goal set');
    setGoalForm(null);
  }

  async function runAiAssist() {
    if (!activeMember) return;
    setAiLoading(true);
    try {
      const res = await fetch('/api/ai/wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: activeMember, memberName: memberName(activeMember) }),
      });
      const data = await res.json();
      if (data.aiInsights) setAiInsights(data.aiInsights);
    } catch { /* ignore */ } finally { setAiLoading(false); }
  }

  if (loading) return <LoadingBlock />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Wallet className="h-4 w-4 text-brand" /> Family Wallet
        </h3>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={runAiAssist} loading={aiLoading}>
            <Sparkles className="h-4 w-4" /> AI Coach
          </Button>
          <Button onClick={() => setDepositForm({ memberId: activeMember ?? '', amount: '', description: '', kind: 'deposit' })}>
            <Plus className="h-4 w-4" /> Add Money
          </Button>
        </div>
      </div>

      {/* Member Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {members.map((m) => (
          <button
            key={m.id}
            onClick={() => setSelectedMember(m.id)}
            className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm whitespace-nowrap transition ${
              activeMember === m.id ? 'bg-brand text-brand-fg' : 'bg-surface/60 hover:bg-surface'
            }`}
          >
            <Avatar name={m.display_name} size={20} color={m.color} />
            {m.display_name}
          </button>
        ))}
      </div>

      {/* AI Insights */}
      {aiInsights && (
        <div className="rounded-xl border border-brand/30 bg-brand/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-brand">
              <Sparkles className="h-4 w-4" /> AI Financial Coach
            </div>
            <button onClick={() => setAiInsights(null)} className="text-muted hover:text-fg"><X className="h-4 w-4" /></button>
          </div>
          {aiInsights.advice && <p className="mb-2 text-sm">{aiInsights.advice}</p>}
          {aiInsights.suggestions.length > 0 && (
            <ul className="space-y-1">
              {aiInsights.suggestions.map((s, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-muted">
                  <span className="mt-0.5 text-brand">•</span> {s}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {activeMember && summary && (
        <>
          {/* Total Balance */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5 text-center">
            <p className="text-xs text-muted">Total Balance</p>
            <p className="text-3xl font-bold">{fmtMoney(summary.totalCents)}</p>
          </div>

          {/* Buckets */}
          {summary.byBucket.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {summary.byBucket.map((b) => {
                const meta = BUCKET_META[b.bucket as DefaultBucket];
                const bkt = allBuckets.find((x) => x.member_id === activeMember && x.bucket === b.bucket);
                const hasGoal = bkt?.target_cents != null && bkt.target_cents > 0;
                const goalPct = hasGoal ? Math.min(100, Math.round((b.cents / bkt!.target_cents!) * 100)) : null;

                return (
                  <div key={b.bucket} className="rounded-2xl border border-border bg-surface/40 p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-lg">{bucketEmoji(b.bucket)}</span>
                      <button onClick={() => setGoalForm({ memberId: activeMember, bucket: b.bucket, target: '' })} className="text-muted hover:text-fg">
                        <Target className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <p className="mt-1 text-xs text-muted">{bucketLabel(b.bucket)}</p>
                    <p className="text-lg font-bold">{fmtMoney(b.cents)}</p>
                    {goalPct !== null && (
                      <div className="mt-2">
                        <div className="h-1.5 rounded-full bg-border">
                          <div className="h-1.5 rounded-full bg-brand transition-all" style={{ width: `${goalPct}%` }} />
                        </div>
                        <p className="mt-0.5 text-[10px] text-muted">{goalPct}% of {fmtMoney(bkt!.target_cents!)}</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon={PiggyBank}
              title="No wallet yet"
              description="Add money to set up wallet buckets for this member."
            />
          )}

          {/* Allocation Settings */}
          <div className="flex items-center justify-between rounded-xl border border-border bg-surface/40 p-4">
            <div>
              <p className="text-sm font-medium">Auto-Split Allocation</p>
              <p className="text-xs text-muted">
                {(() => {
                  const mr = allRules.filter((r) => r.member_id === activeMember);
                  if (mr.length === 0) return 'Using default: 50/30/10/10';
                  return mr.map((r) => `${bucketLabel(r.bucket)} ${r.pct}%`).join(' · ');
                })()}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setSettingsFor(activeMember)}>
              <Settings className="h-4 w-4" /> Edit
            </Button>
          </div>

          {/* Goal Progress */}
          {summary.goalProgress.length > 0 && (
            <div className="rounded-xl border border-brand/30 bg-brand/5 p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-brand">
                <TrendingUp className="h-4 w-4" /> Goal Tracker
              </div>
              {summary.goalProgress.map((g) => (
                <div key={g.bucket} className="mb-2 last:mb-0">
                  <div className="flex items-center justify-between text-sm">
                    <span>{bucketEmoji(g.bucket)} {bucketLabel(g.bucket)}</span>
                    <span className="text-xs text-muted">
                      {g.pct}% · {g.weeksLeft != null ? (g.weeksLeft === 0 ? 'Goal reached!' : `~${g.weeksLeft}w left`) : 'Add deposits to track'}
                    </span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-border">
                    <div className="h-2 rounded-full bg-brand transition-all" style={{ width: `${g.pct}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Recent Transactions */}
          {allTxns.filter((t) => t.member_id === activeMember).length > 0 && (
            <div>
              <h4 className="mb-2 text-sm font-semibold text-muted">Recent Activity</h4>
              <div className="space-y-1.5">
                {allTxns.filter((t) => t.member_id === activeMember).slice(0, 20).map((t) => (
                  <div key={t.id} className="flex items-center justify-between rounded-lg border border-border bg-surface/40 px-3 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      {t.amount_cents >= 0 ? <ArrowDownLeft className="h-3.5 w-3.5 text-success" /> : <ArrowUpRight className="h-3.5 w-3.5 text-danger" />}
                      <span>{bucketEmoji(t.bucket)}</span>
                      <span className="truncate">{t.description || t.kind}</span>
                    </div>
                    <span className={`font-medium ${t.amount_cents >= 0 ? 'text-success' : 'text-danger'}`}>
                      {t.amount_cents >= 0 ? '+' : ''}{fmtMoney(t.amount_cents)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Deposit Modal */}
      {depositForm && (
        <Modal open onClose={() => setDepositForm(null)} title="Add Money">
          <form onSubmit={deposit} className="space-y-4">
            <Field label="Member">
              {(id) => (
                <Select id={id} value={depositForm.memberId} onChange={(e) => setDepositForm({ ...depositForm, memberId: e.target.value })}>
                  <option value="">Select member</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Amount ($)">
              {(id) => <Input id={id} type="number" step="0.01" min="0.01" value={depositForm.amount} onChange={(e) => setDepositForm({ ...depositForm, amount: e.target.value })} placeholder="10.00" required />}
            </Field>
            <Field label="Type">
              {(id) => (
                <Select id={id} value={depositForm.kind} onChange={(e) => setDepositForm({ ...depositForm, kind: e.target.value })}>
                  {KINDS.map((k) => <option key={k} value={k}>{k.charAt(0).toUpperCase() + k.slice(1)}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Description">
              {(id) => <Input id={id} value={depositForm.description} onChange={(e) => setDepositForm({ ...depositForm, description: e.target.value })} placeholder="Allowance, birthday money, etc." />}
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" type="button" onClick={() => setDepositForm(null)}>Cancel</Button>
              <Button type="submit" loading={saving}>Add Money</Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Allocation Settings Modal */}
      {settingsFor && <AllocationEditor
        memberId={settingsFor}
        memberName={memberName(settingsFor)}
        current={memberRules}
        saving={saving}
        onSave={(r) => saveRules(settingsFor, r)}
        onClose={() => setSettingsFor(null)}
      />}

      {/* Goal Modal */}
      {goalForm && (
        <Modal open onClose={() => setGoalForm(null)} title={`Set Goal — ${bucketLabel(goalForm.bucket)}`}>
          <form onSubmit={setGoal} className="space-y-4">
            <Field label="Goal Amount ($)">
              {(id) => <Input id={id} type="number" step="0.01" min="0.01" value={goalForm.target} onChange={(e) => setGoalForm({ ...goalForm, target: e.target.value })} placeholder="500.00" required />}
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" type="button" onClick={() => setGoalForm(null)}>Cancel</Button>
              <Button type="submit">Set Goal</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function AllocationEditor({ memberId, memberName, current, saving, onSave, onClose }: {
  memberId: string;
  memberName: string;
  current: Rule[];
  saving: boolean;
  onSave: (rules: AllocationRule[]) => void;
  onClose: () => void;
}) {
  const initial: Record<string, number> = {};
  for (const b of DEFAULT_BUCKETS) {
    const existing = current.find((r) => r.bucket === b);
    initial[b] = existing ? existing.pct : DEFAULT_SPLIT[b as DefaultBucket];
  }
  const [pcts, setPcts] = useState(initial);
  const total = Object.values(pcts).reduce((s, v) => s + v, 0);

  return (
    <Modal open onClose={onClose} title={`Auto-Split — ${memberName}`}>
      <div className="space-y-4">
        <p className="text-sm text-muted">Set how incoming money is divided across buckets. Percentages must total 100%.</p>

        {DEFAULT_BUCKETS.map((b) => (
          <div key={b} className="flex items-center gap-3">
            <span className="w-6 text-center text-lg">{BUCKET_META[b].emoji}</span>
            <span className="w-16 text-sm font-medium">{BUCKET_META[b].label}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={pcts[b]}
              onChange={(e) => setPcts({ ...pcts, [b]: parseInt(e.target.value) })}
              className="flex-1"
            />
            <div className="w-14">
              <Input
                type="number"
                min={0}
                max={100}
                value={pcts[b]}
                onChange={(e) => setPcts({ ...pcts, [b]: Math.max(0, Math.min(100, parseInt(e.target.value) || 0)) })}
                className="text-center text-sm"
              />
            </div>
            <span className="w-6 text-xs text-muted">%</span>
          </div>
        ))}

        <div className={`text-center text-sm font-medium ${total === 100 ? 'text-success' : 'text-danger'}`}>
          Total: {total}% {total !== 100 && `(needs ${total < 100 ? '+' : ''}${100 - total}%)`}
        </div>

        <div className="flex items-center justify-between pt-2">
          <Button variant="outline" size="sm" onClick={() => setPcts({ ...DEFAULT_SPLIT })}>
            Reset to 50/30/10/10
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={() => onSave(Object.entries(pcts).map(([bucket, pct]) => ({ bucket, pct })))} loading={saving} disabled={total !== 100}>
              Save Allocation
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
