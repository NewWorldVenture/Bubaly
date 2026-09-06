'use client';

import { useState, useTransition } from 'react';
import { IdCard, Plus, Pencil, Trash2 } from 'lucide-react';
import { saveLicenseAction, deleteLicenseAction } from '@/app/(app)/dashboard/auto/actions';
import { renewalStatus } from '@/lib/auto/renewals';
import { fmtDate } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/home/field';
import { EmptyState } from '@/components/ui/states';
import { useTranslations } from '@/components/i18n/locale-provider';

type License = Tables<'driver_licenses'>;
type Member = { id: string; display_name: string | null };

export function LicensesClient({ licenses, members }: { licenses: License[]; members: Member[] }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<License | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t('licensesClient.driverAposSLicenses')}</h2>
        <Button onClick={() => { setEditing(null); setOpen(true); }}><Plus className="h-4 w-4" /> {t('licensesClient.addLicense')}</Button>
      </div>

      {licenses.length === 0 ? (
        <EmptyState icon={IdCard} title={t('licensesClient.noLicensesYet')} description="Store each driver's license with its renewal date so nobody drives on an expired one." action={<Button onClick={() => { setEditing(null); setOpen(true); }}><Plus className="h-4 w-4" /> {t('licensesClient.addLicense')}</Button>} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {licenses.map((l) => {
            const s = renewalStatus(l.expires_on);
            return (
              <Card key={l.id}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold">{l.holder_name}</p>
                    <p className="text-xs text-muted">{[l.state, l.license_class && `Class ${l.license_class}`].filter(Boolean).join(' · ') || '—'}</p>
                  </div>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                  {l.license_number && <Badge tone="brand">#{l.license_number}</Badge>}
                  {l.expires_on && <Badge tone="neutral">Exp {fmtDate(l.expires_on)}</Badge>}
                </div>
                <div className="mt-3 flex items-center gap-3 border-t border-border/50 pt-2 text-xs">
                  <button onClick={() => { setEditing(l); setOpen(true); }} className="inline-flex items-center gap-1 text-muted hover:text-fg"><Pencil className="h-3.5 w-3.5" /> Edit</button>
                  <button onClick={() => start(async () => { await deleteLicenseAction(l.id); })} className="inline-flex items-center gap-1 text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? 'Edit license' : 'Add license'}>
        <form action={(fd) => start(async () => { await saveLicenseAction(fd); setOpen(false); })} className="space-y-3">
          {editing && <input type="hidden" name="id" value={editing.id} />}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('licensesClient.holderName')}><Input name="holder_name" required defaultValue={editing?.holder_name ?? ''} /></Field>
            <Field label={t('licensesClient.familyMember')}><Select name="member_id" defaultValue={editing?.member_id ?? ''}><option value="">—</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name ?? 'Member'}</option>)}</Select></Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label={t('licensesClient.license')}><Input name="license_number" defaultValue={editing?.license_number ?? ''} /></Field>
            <Field label={t('licensesClient.state')}><Input name="state" maxLength={2} defaultValue={editing?.state ?? ''} placeholder="CA" /></Field>
            <Field label={t('licensesClient.class')}><Input name="license_class" defaultValue={editing?.license_class ?? ''} placeholder="C" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('licensesClient.issued')}><Input type="date" name="issued_on" defaultValue={editing?.issued_on ?? ''} /></Field>
            <Field label={t('licensesClient.expires')}><Input type="date" name="expires_on" defaultValue={editing?.expires_on ?? ''} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('licensesClient.endorsements')}><Input name="endorsements" defaultValue={editing?.endorsements ?? ''} /></Field>
            <Field label={t('licensesClient.restrictions')}><Input name="restrictions" defaultValue={editing?.restrictions ?? ''} placeholder={t('licensesClient.correctiveLenses')} /></Field>
          </div>
          <Field label={t('licensesClient.notes')}><Textarea name="notes" rows={2} defaultValue={editing?.notes ?? ''} /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t('licensesClient.cancel')}</Button><Button type="submit" loading={pending}>{editing ? 'Save' : 'Add'}</Button></div>
        </form>
      </Modal>
    </div>
  );
}
