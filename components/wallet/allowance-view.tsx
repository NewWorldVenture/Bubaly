'use client';

// Allowance management — per-child recurring allowance rules (amount + cadence,
// pause/resume). A Basic+ feature; Free families see an upgrade prompt. The cron
// (/api/cron/wallet-allowance) pays them into the ledger automatically.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, Pause, Play, Pencil, Lock, X } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Field, Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import { formatCents } from '@/lib/wallet/ledger';
import { WalletSubnav } from '@/components/wallet/wallet-subnav';
import { saveAllowanceRuleAction, toggleAllowanceRuleAction } from '@/app/(app)/wallet/actions';

export type AllowanceRow = {
  childWalletId: string; name: string; ruleId: string | null;
  amountCents: number; cadence: 'weekly' | 'biweekly' | 'monthly'; isActive: boolean; nextRunOn: string | null;
};

function fmtNextRun(date: string): string {
  const d = new Date(date + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function AllowanceView({ rows, enabled, canManage }: { rows: AllowanceRow[]; enabled: boolean; canManage: boolean }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [editing, setEditing] = useState<AllowanceRow | null>(null);

  async function toggle(row: AllowanceRow) {
    if (!row.ruleId) return;
    const res = await toggleAllowanceRuleAction({ id: row.ruleId, isActive: !row.isActive });
    if (!res.ok) return toastError(res.error ?? 'Could not update');
    success(row.isActive ? 'Allowance paused' : 'Allowance resumed');
    router.refresh();
  }

  return (
    <div className="module-page">
      <PageHeader title="Family Wallet" description="Automate weekly, biweekly, or monthly allowances." />
      <WalletSubnav />

      {!enabled && (
        <div className="mb-5 flex items-center gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
          <Lock className="h-5 w-5 flex-shrink-0 text-amber-500" />
          <div className="flex-1 text-sm">
            <p className="font-semibold">Automated allowances are a Basic plan feature.</p>
            <p className="text-xs text-muted">Upgrade to schedule recurring allowances that pay automatically.</p>
          </div>
          <Link href="/pricing" className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand/90">Upgrade</Link>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-border bg-surface/40 p-4 text-sm text-muted">No child wallets yet. Activate the Family Wallet and add children first.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.childWalletId} className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4">
              <Avatar name={r.name} size={36} className="rounded-full" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{r.name}</p>
                {r.ruleId ? (
                  <p className="text-xs text-muted">
                    {formatCents(r.amountCents)} · {r.cadence}
                    {r.isActive ? (r.nextRunOn ? ` · next ${fmtNextRun(r.nextRunOn)}` : '') : ' · paused'}
                  </p>
                ) : (
                  <p className="text-xs text-muted">No allowance set</p>
                )}
              </div>
              {canManage && enabled && (
                <div className="flex items-center gap-1">
                  {r.ruleId && (
                    <button onClick={() => toggle(r)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg" aria-label={r.isActive ? 'Pause' : 'Resume'}>
                      {r.isActive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </button>
                  )}
                  <button onClick={() => setEditing(r)} className={cn('rounded-lg px-2.5 py-1.5 text-xs font-semibold', r.ruleId ? 'text-muted hover:bg-elevated hover:text-fg' : 'bg-brand text-white hover:bg-brand/90')}>
                    {r.ruleId ? <Pencil className="h-3.5 w-3.5" /> : 'Set'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && <AllowanceModal row={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AllowanceModal({ row, onClose }: { row: AllowanceRow; onClose: () => void }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [amount, setAmount] = useState(row.amountCents ? String(row.amountCents / 100) : '');
  const [cadence, setCadence] = useState<AllowanceRow['cadence']>(row.cadence);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars <= 0) return toastError('Enter an amount greater than $0.');
    setLoading(true);
    const res = await saveAllowanceRuleAction({ id: row.ruleId ?? undefined, childWalletId: row.childWalletId, amountCents: Math.round(dollars * 100), cadence });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not save allowance');
    success('Allowance saved');
    onClose();
    router.refresh();
  }

  return (
    <Modal open onClose={onClose} title={`Allowance — ${row.name}`}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Amount (USD)">{(id) => <Input id={id} type="number" min="0" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10.00" autoFocus />}</Field>
        <div className="flex flex-wrap gap-2">
          {[5, 10, 20].map((q) => (
            <button key={q} type="button" onClick={() => setAmount(String(q))}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-brand/40 hover:text-brand transition">
              ${q}
            </button>
          ))}
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium">How often?</label>
          <div className="flex gap-2">
            {(['weekly', 'biweekly', 'monthly'] as const).map((c) => (
              <button key={c} type="button" onClick={() => setCadence(c)}
                className={cn('flex-1 rounded-xl border-2 px-3 py-2 text-sm font-medium capitalize transition',
                  cadence === c ? 'border-brand bg-brand/10 text-brand' : 'border-border text-muted hover:border-brand/40')}>
                {c}
              </button>
            ))}
          </div>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted"><CalendarClock className="h-3.5 w-3.5" /> Paid automatically into {row.name}&apos;s wallet, split by your rules.</p>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}><X className="h-4 w-4" /> Cancel</Button>
          <Button type="submit" loading={loading}>Save allowance</Button>
        </div>
      </form>
    </Modal>
  );
}
