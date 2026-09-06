'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, UserMinus, Pencil } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ROLE_LABELS } from '@/lib/constants/roles';
import { adminRemoveMemberAction, adminUpdateMemberAction } from '@/app/(app)/admin/actions';
import type { MemberRole } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

export function MemberRowActions({ memberId, displayName, role }: { memberId: string; displayName: string; role: MemberRole }) {
  const t = useTranslations();
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

  async function saveEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const newName = String(form.get('display_name') ?? '').trim();
    const newRole = String(form.get('role') ?? role) as MemberRole;
    if (!newName) { toastError('Name is required'); return; }
    setBusy(true);
    const res = await adminUpdateMemberAction(memberId, { displayName: newName, role: newRole });
    setBusy(false);
    if (!res.ok) return toastError(res.error);
    success('Member updated');
    setEditing(false);
    router.refresh();
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="rounded-lg p-1.5 text-muted hover:bg-elevated" aria-label={t('memberRowActions.rowActions')}>
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-xl popover-surface p-1 shadow-glass animate-fade-in">
            <button onClick={() => { setOpen(false); setEditing(true); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-elevated">
              <Pencil className="h-4 w-4" /> {t('memberRowActions.editMember')}
            </button>
            <button onClick={removeFromFamily} disabled={busy} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-elevated disabled:opacity-50">
              <UserMinus className="h-4 w-4" /> {t('memberRowActions.removeFromFamily')}
            </button>
          </div>
        </>
      )}

      {editing && (
        <Modal open onClose={() => setEditing(false)} title={t('memberRowActions.editMember')}>
          <form onSubmit={saveEdit} className="space-y-4">
            <Field label={t('memberRowActions.name')} required>
              {(id) => <Input id={id} name="display_name" defaultValue={displayName} autoFocus />}
            </Field>
            <Field label={t('memberRowActions.role')}>
              {(id) => (
                <Select id={id} name="role" defaultValue={role}>
                  {(Object.keys(ROLE_LABELS) as MemberRole[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </Select>
              )}
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>{t('memberRowActions.cancel')}</Button>
              <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
