'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, UserMinus, Pencil, X, CreditCard } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { ROLE_LABELS, ROLE_ORDER, type MemberRole } from '@/lib/constants/roles';
import { PLANS, type PlanId } from '@/lib/constants/plans';
import { adminRemoveMemberAction, adminUpdateMemberAction, adminUpdateFamilyPlanAction } from '@/app/(app)/admin/actions';

export function MemberRowActions({ memberId, name, role, familyId, plan }: {
  memberId: string; name?: string | null; role?: MemberRole | null; familyId?: string | null; plan?: string | null;
}) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [planEditing, setPlanEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function removeFromFamily() {
    if (!confirm('Remove this person from the family? This is reversible — they can be re-invited.')) return;
    setBusy(true);
    const res = await adminRemoveMemberAction(memberId);
    setBusy(false);
    setOpen(false);
    if (!res.ok) return toastError(res.error);
    success('Removed from family');
    router.refresh();
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="rounded-lg p-1.5 text-muted hover:bg-elevated" aria-label="Row actions">
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-xl popover-surface p-1 shadow-glass animate-fade-in">
            <button onClick={() => { setOpen(false); setEditing(true); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-elevated">
              <Pencil className="h-4 w-4" /> Edit name &amp; role
            </button>
            {familyId && (
              <button onClick={() => { setOpen(false); setPlanEditing(true); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-elevated">
                <CreditCard className="h-4 w-4" /> Change plan
              </button>
            )}
            <button onClick={removeFromFamily} disabled={busy} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-elevated disabled:opacity-50">
              <UserMinus className="h-4 w-4" /> Remove from family
            </button>
          </div>
        </>
      )}

      {editing && (
        <EditMemberModal
          memberId={memberId}
          initialName={name ?? ''}
          initialRole={(role ?? 'adult') as MemberRole}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); router.refresh(); }}
        />
      )}

      {planEditing && familyId && (
        <PlanModal
          familyId={familyId}
          initialPlan={(plan as PlanId) ?? 'free'}
          onClose={() => setPlanEditing(false)}
          onSaved={() => { setPlanEditing(false); router.refresh(); }}
        />
      )}
    </div>
  );
}

function PlanModal({ familyId, initialPlan, onClose, onSaved }: {
  familyId: string; initialPlan: PlanId; onClose: () => void; onSaved: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [plan, setPlan] = useState<PlanId>(PLANS.some((p) => p.id === initialPlan) ? initialPlan : 'free');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const res = await adminUpdateFamilyPlanAction({ familyId, plan });
    setSaving(false);
    if (!res.ok) return toastError(res.error ?? 'Could not change plan');
    success('Plan updated');
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-border bg-bg p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="font-bold text-fg">Change plan</h3>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted hover:bg-elevated"><X className="h-4 w-4" /></button>
        </div>
        <p className="mb-4 text-xs text-muted">This is an admin override (no charge) and changes the plan for the whole family.</p>
        <div className="space-y-2">
          {PLANS.map((p) => (
            <button key={p.id} type="button" onClick={() => setPlan(p.id)}
              className={`flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-left text-sm transition ${plan === p.id ? 'border-brand bg-brand/10' : 'border-border hover:bg-elevated'}`}>
              <span className="font-medium">{p.name}</span>
              {plan === p.id && <span className="text-xs font-semibold text-brand">Selected</span>}
            </button>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted hover:text-fg">Cancel</button>
          <button onClick={save} disabled={saving} className="rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60">
            {saving ? 'Saving…' : 'Save plan'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditMemberModal({ memberId, initialName, initialRole, onClose, onSaved }: {
  memberId: string; initialName: string; initialRole: MemberRole;
  onClose: () => void; onSaved: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [name, setName] = useState(initialName);
  const [role, setRole] = useState<MemberRole>(initialRole);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) return toastError('Name is required.');
    setSaving(true);
    const res = await adminUpdateMemberAction({ memberId, displayName: name.trim(), role });
    setSaving(false);
    if (!res.ok) return toastError(res.error ?? 'Could not save');
    success('Member updated');
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-border bg-bg p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-bold text-fg">Edit member</h3>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted hover:bg-elevated"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus
              className="h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus:border-brand/50 focus:outline-none" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value as MemberRole)}
              className="h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus:border-brand/50 focus:outline-none">
              {ROLE_ORDER.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted hover:text-fg">Cancel</button>
          <button onClick={save} disabled={saving || !name.trim()} className="rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
