'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, UserMinus, Pencil, X } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { ROLE_LABELS, ROLE_ORDER, type MemberRole } from '@/lib/constants/roles';
import { adminRemoveMemberAction, adminUpdateMemberAction } from '@/app/(app)/admin/actions';

export function MemberRowActions({ memberId, name, role }: { memberId: string; name?: string | null; role?: MemberRole | null }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
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
