'use client';

// components/family/pending-invites.tsx — the household's open invites, with
// a way to cancel one.
//
// An invite row is what grants access, and nothing in the app could take one
// back: only the site's super admin console set an invite to 'revoked'. So a
// mistaken invite, a resubmitted one after a failed email, or a second invite
// still held by someone the family since removed stayed live for its full 14
// days. A manager can now revoke it here. invites_update (0482) lets a
// manager move pending -> revoked and nothing else, which is all this writes.

import { useEffect, useState } from 'react';
import { MailX } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { settle } from '@/lib/supabase/settle';
import { describeDbError, wroteNoRows } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useFormat } from '@/components/i18n/use-format';
import { useTranslations } from '@/components/i18n/locale-provider';
import { isManager, roleLabel } from '@/lib/constants/roles';
import { useApp } from '@/components/app/app-context';

type PendingInvite = { id: string; email: string; role: string; expires_at: string };

export function PendingInvites({ familyId, reloadKey = 0 }: { familyId: string; reloadKey?: number }) {
  const t = useTranslations();
  const { role } = useApp();
  // A manager's list (invites_update is can_manage_family): anyone else is
  // shown nothing rather than a Revoke that the database would refuse.
  const manages = isManager(role);
  const { fmtDate } = useFormat();
  const { success, error: toastError } = useToast();
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    if (!manages) return () => { live = false; };
    void settle(createClient().from('invites')
      .select('id, email, role, expires_at')
      .eq('family_id', familyId).eq('status', 'pending').gt('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: true }).order('id', { ascending: true })
      .limit(100))
      .then(({ data, error }) => {
        if (!live) return;
        setLoadFailed(Boolean(error));
        setInvites(error ? [] : ((data ?? []) as PendingInvite[]));
      });
    return () => { live = false; };
  }, [familyId, reloadKey, version, manages]);

  async function revoke(invite: PendingInvite) {
    if (!manages) return;
    setBusyId(invite.id);
    // RLS FILTERS an update it refuses, so the readback is what says it landed.
    const { data, error } = await settle(createClient().from('invites')
      .update({ status: 'revoked' })
      .eq('id', invite.id).eq('family_id', familyId).eq('status', 'pending')
      .select('id'));
    setBusyId(null);
    if (error) { toastError(describeDbError(error, t('errors.thatChangeWasNotSaved'))); return; }
    if (wroteNoRows(data)) { toastError(t('errors.thatChangeWasNotSaved')); return; }
    success(t('pendingInvites.revoked', { email: invite.email }));
    setVersion((v) => v + 1);
  }

  if (!manages || (!loadFailed && invites.length === 0)) return null;

  return (
    <Card>
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
        <MailX className="h-4 w-4 text-brand-text" aria-hidden="true" /> {t('pendingInvites.title')}
      </h2>
      {loadFailed ? (
        <p role="alert" className="text-sm text-danger">{t('pendingInvites.couldNotLoad')}</p>
      ) : (
        <ul className="space-y-2">
          {invites.map((invite) => (
            <li key={invite.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{invite.email}</p>
                <p className="text-xs text-muted">
                  <Badge tone="neutral">{roleLabel(t, invite.role)}</Badge>{' '}
                  {t('pendingInvites.expires', { date: fmtDate(invite.expires_at) })}
                </p>
              </div>
              <button
                type="button"
                disabled={busyId === invite.id}
                onClick={() => revoke(invite)}
                aria-label={t('pendingInvites.revokeFor', { email: invite.email })}
                className="inline-flex h-11 items-center rounded-lg px-3 text-sm font-medium text-muted hover:text-danger disabled:opacity-50 focus-ring"
              >
                {t('pendingInvites.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
