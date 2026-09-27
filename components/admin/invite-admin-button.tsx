'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useTranslations } from '@/components/i18n/locale-provider';
import { inviteAdminAction } from '@/app/(app)/admin/admins/actions';

const ROLES = ['administrator', 'super_administrator', 'content_manager', 'billing_manager', 'moderator', 'viewer'] as const;

/**
 * "Invite Admin" on /admin/admins was a button with no handler. The action
 * behind it (inviteAdminAction) existed and was never called from anywhere.
 * This opens a form that calls it, and says what the action said when it
 * refuses. Audit C1-S9-105.
 */
export function InviteAdminButton() {
  const t = useTranslations();
  const router = useRouter();
  const { success } = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(form: HTMLFormElement) {
    setError(null);
    const data = new FormData(form);
    startTransition(async () => {
      try {
        const result = await inviteAdminAction(data);
        if (!result.ok) { setError(result.error ?? t('admins.couldNotInviteThatAdmin')); return; }
        success(t('adminInvite.invited'));
        setOpen(false);
        router.refresh();
      } catch {
        setError(t('admins.couldNotInviteThatAdmin'));
      }
    });
  }

  return (
    <>
      <button type="button" onClick={() => { setError(null); setOpen(true); }}
        className="flex h-9 items-center gap-1.5 self-start rounded-lg bg-brand px-4 text-sm font-semibold text-brand-fg hover:brightness-110 sm:self-auto">
        <Plus className="h-4 w-4" />{' '}{t('admins.inviteAdmin')}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('admins.inviteAdmin')}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }}>
          <Field label={t('adminInvite.email')} required>{(_id, c) => <Input {...c} name="email" type="email" autoComplete="off" />}</Field>
          <Field label={t('adminInvite.fullName')}>{(_id, c) => <Input {...c} name="full_name" maxLength={120} />}</Field>
          <Field label={t('admins.role')}>{(_id, c) => (
            <Select {...c} name="admin_role" defaultValue="administrator">
              {ROLES.map((r) => <option key={r} value={r}>{t(`adminInvite.role.${r}`)}</option>)}
            </Select>
          )}</Field>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t('adminInvite.cancel')}</Button>
            <Button type="submit" loading={pending}>{t('adminInvite.sendInvite')}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
