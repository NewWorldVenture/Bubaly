'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Download, Plus, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { ROLE_LABELS, INVITABLE_ROLES, type MemberRole } from '@/lib/constants/roles';
import { adminCreateUserAction, adminCreateFamilyAction } from '@/app/(app)/admin/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

type ExportRow = { name: string; email: string; family: string; role: string; plan: string; status: string; joined: string };

function downloadCsv(rows: ExportRow[]) {
  const header = ['Name', 'Email', 'Family', 'Role', 'Plan', 'Status', 'Joined'];
  const lines = [header, ...rows.map((r) => [r.name, r.email, r.family, r.role, r.plan, r.status, r.joined])]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([lines], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bubaly-users-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function UsersToolbar({ families, exportRows }: {
  families: { id: string; name: string }[];
  exportRows: ExportRow[];
}) {
  const t = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [modal, setModal] = useState<'user' | 'family' | null>(null);
  const [loading, setLoading] = useState(false);

  async function onCreateUser(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get('email') ?? '');
    const familyId = String(fd.get('familyId') ?? '');
    const role = String(fd.get('role') ?? '') as MemberRole;
    setLoading(true);
    const res = await adminCreateUserAction({ email, familyId: familyId || undefined, role: familyId ? role : undefined });
    setLoading(false);
    if (!res.ok) return toastError(res.error);
    success('Invite sent — they’ll get a Supabase sign-in email');
    setModal(null);
    router.refresh();
  }

  async function onCreateFamily(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setLoading(true);
    const res = await adminCreateFamilyAction({
      name: String(fd.get('name') ?? ''),
      timezone: String(fd.get('timezone') ?? 'UTC'),
      ownerEmail: String(fd.get('ownerEmail') ?? ''),
    });
    setLoading(false);
    if (!res.ok) return toastError(res.error);
    success('Family created');
    setModal(null);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => downloadCsv(exportRows)}>
        <Download className="h-4 w-4" /> {t('usersToolbar.export')}
      </Button>
      <Button variant="secondary" size="sm" onClick={() => setModal('family')}>
        <Home className="h-4 w-4" /> {t('usersToolbar.createFamily')}
      </Button>
      <Button size="sm" onClick={() => setModal('user')}>
        <Plus className="h-4 w-4" /> {t('usersToolbar.addUser')}
      </Button>

      {modal === 'user' && (
        <Modal open onClose={() => setModal(null)} title={t('usersToolbar.addNewUser')} description="Sends a real Supabase sign-in invite to this email.">
          <form onSubmit={onCreateUser} className="space-y-4">
            <Field label={t('usersToolbar.email')} required>{(id) => <Input id={id} name="email" type="email" placeholder="person@example.com" autoFocus />}</Field>
            <Field label={t('usersToolbar.addDirectlyToAFamilyOptional')}>
              {(id) => (
                <Select id={id} name="familyId" defaultValue="">
                  <option value="">Don’t add to a family yet</option>
                  {families.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label={t('usersToolbar.roleInThatFamily')}>
              {(id) => (
                <Select id={id} name="role" defaultValue="adult">
                  {INVITABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </Select>
              )}
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setModal(null)}>{t('usersToolbar.cancel')}</Button>
              <Button type="submit" loading={loading}>{t('usersToolbar.sendInvite')}</Button>
            </div>
          </form>
        </Modal>
      )}

      {modal === 'family' && (
        <Modal open onClose={() => setModal(null)} title={t('usersToolbar.createAFamily')} description="Creates the family with an existing user as its parent/admin.">
          <form onSubmit={onCreateFamily} className="space-y-4">
            <Field label={t('usersToolbar.familyName')} required>{(id) => <Input id={id} name="name" placeholder="The Rivera Family" autoFocus />}</Field>
            <Field label={t('usersToolbar.ownersEmail')} hint="They must already have an account." required>
              {(id) => <Input id={id} name="ownerEmail" type="email" placeholder="owner@example.com" />}
            </Field>
            <Field label={t('usersToolbar.timeZone')}>{(id) => <Input id={id} name="timezone" defaultValue="America/New_York" />}</Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setModal(null)}>{t('usersToolbar.cancel')}</Button>
              <Button type="submit" loading={loading}>{t('usersToolbar.createFamily')}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
