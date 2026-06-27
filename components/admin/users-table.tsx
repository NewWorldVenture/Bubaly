'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { X, Check, UserMinus, Tag } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { fmtDate } from '@/lib/utils/format';
import { ROLE_LABELS, ROLE_ORDER, type MemberRole } from '@/lib/constants/roles';
import { PLANS } from '@/lib/constants/plans';
import { useToast } from '@/components/ui/toast';
import { MemberRowActions } from './member-row-actions';
import { adminBulkUpdateRoleAction, adminBulkRemoveAction } from '@/app/(app)/admin/actions';

export type UserRow = {
  memberId: string;
  name: string;
  email: string | null;
  familyName: string | null;
  familyId: string | null;
  role: MemberRole | null;
  plan: string | null;
  hasAccount: boolean;
  joinedAt: string;
};

export function UsersTable({ rows }: { rows: UserRow[] }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [roleModal, setRoleModal] = useState(false);

  const allSelected = rows.length > 0 && selected.size === rows.length;

  function toggle(id: string) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected((s) => (s.size === rows.length ? new Set() : new Set(rows.map((r) => r.memberId))));
  }

  async function bulkRemove() {
    const ids = [...selected];
    if (!confirm(`Remove ${ids.length} member${ids.length === 1 ? '' : 's'} from their families? Reversible.`)) return;
    setBusy(true);
    const res = await adminBulkRemoveAction({ memberIds: ids });
    setBusy(false);
    if (!res.ok) return toastError(res.error);
    success(`Removed ${ids.length} member${ids.length === 1 ? '' : 's'}`);
    setSelected(new Set());
    router.refresh();
  }

  async function applyRole(role: MemberRole) {
    const ids = [...selected];
    setBusy(true);
    const res = await adminBulkUpdateRoleAction({ memberIds: ids, role });
    setBusy(false);
    setRoleModal(false);
    if (!res.ok) return toastError(res.error);
    success(`Updated ${ids.length} member${ids.length === 1 ? '' : 's'}`);
    setSelected(new Set());
    router.refresh();
  }

  return (
    <div className="mt-4">
      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-brand/30 bg-brand/5 px-3 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <button onClick={() => setRoleModal(true)} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium hover:bg-elevated disabled:opacity-50">
            <Tag className="h-3.5 w-3.5" /> Change role
          </button>
          <button onClick={bulkRemove} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-danger/30 px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50">
            <UserMinus className="h-3.5 w-3.5" /> Remove
          </button>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-xs text-muted hover:text-fg">Clear</button>
        </div>
      )}

      <div className="table-responsive">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th className="px-3 py-2">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all on page" className="accent-brand" />
              </th>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Family</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Plan</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Joined</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.map((u) => (
              <tr key={u.memberId} className={selected.has(u.memberId) ? 'bg-brand/5' : undefined}>
                <td className="px-3 py-2.5">
                  <input type="checkbox" checked={selected.has(u.memberId)} onChange={() => toggle(u.memberId)} aria-label={`Select ${u.name}`} className="accent-brand" />
                </td>
                <td className="px-3 py-2.5">
                  <p className="font-medium">{u.name || '—'}</p>
                  <p className="text-xs text-muted">{u.email ?? <span className="italic">No login account</span>}</p>
                </td>
                <td className="px-3 py-2.5 text-muted">{u.familyName ?? '—'}</td>
                <td className="px-3 py-2.5">{u.role ? <Badge tone="brand">{ROLE_LABELS[u.role]}</Badge> : '—'}</td>
                <td className="px-3 py-2.5 text-muted">{u.plan ? PLANS.find((p) => p.id === u.plan)?.name ?? u.plan : '—'}</td>
                <td className="px-3 py-2.5"><Badge tone={u.hasAccount ? 'success' : 'neutral'}>{u.hasAccount ? 'Active' : 'No account'}</Badge></td>
                <td className="px-3 py-2.5 text-muted">{fmtDate(u.joinedAt, 'MMM d, yyyy')}</td>
                <td className="px-3 py-2.5">
                  <MemberRowActions memberId={u.memberId} name={u.name} role={u.role} familyId={u.familyId} plan={u.plan} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {roleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setRoleModal(false)}>
          <div className="w-full max-w-sm rounded-2xl border border-border bg-bg p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-bold text-fg">Set role for {selected.size}</h3>
              <button onClick={() => setRoleModal(false)} aria-label="Close" className="rounded-lg p-1.5 text-muted hover:bg-elevated"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-1.5">
              {ROLE_ORDER.map((r) => (
                <button key={r} onClick={() => applyRole(r)} disabled={busy}
                  className="flex w-full items-center justify-between rounded-xl border border-border px-3 py-2.5 text-left text-sm hover:bg-elevated disabled:opacity-50">
                  {ROLE_LABELS[r]} <Check className="h-4 w-4 opacity-0" />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
