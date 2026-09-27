'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useTranslations } from '@/components/i18n/locale-provider';
import { createTicketAction } from '@/app/(app)/admin/support-tickets/actions';

const CATEGORIES = ['general', 'technical', 'billing', 'account', 'family', 'feature_request'] as const;
const PRIORITIES = ['medium', 'low', 'high', 'urgent'] as const;

/**
 * "New Ticket" on /admin/support-tickets was a button with no handler, over a
 * createTicketAction nothing called. Audit C1-S9-105.
 */
export function NewTicketButton() {
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
        const result = await createTicketAction(data);
        if (!result.ok) { setError(result.error ?? t('supportTickets.couldNotCreateThatTicket')); return; }
        success(t('adminNewTicket.created'));
        setOpen(false);
        router.refresh();
      } catch {
        setError(t('supportTickets.couldNotCreateThatTicket'));
      }
    });
  }

  return (
    <>
      <button type="button" onClick={() => { setError(null); setOpen(true); }}
        className="flex h-9 items-center gap-1.5 rounded-lg bg-brand px-4 text-sm font-semibold text-brand-fg hover:brightness-110">
        <Plus className="h-4 w-4" /> {t('adminSupportTickets.newTicket')}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('adminSupportTickets.newTicket')}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }}>
          <Field label={t('adminSupportTickets.subject')} required>{(_id, c) => <Input {...c} name="subject" maxLength={240} />}</Field>
          <Field label={t('adminNewTicket.requesterEmail')} required>{(_id, c) => <Input {...c} name="requester_email" type="email" autoComplete="off" />}</Field>
          <Field label={t('adminNewTicket.requesterName')}>{(_id, c) => <Input {...c} name="requester_name" maxLength={120} />}</Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('adminSupportTickets.category')}>{(_id, c) => (
              <Select {...c} name="category" defaultValue="general">
                {CATEGORIES.map((v) => <option key={v} value={v}>{t(`adminNewTicket.category.${v}`)}</option>)}
              </Select>
            )}</Field>
            <Field label={t('adminSupportTickets.priority')}>{(_id, c) => (
              <Select {...c} name="priority" defaultValue="medium">
                {PRIORITIES.map((v) => <option key={v} value={v}>{t(`adminNewTicket.priority.${v}`)}</option>)}
              </Select>
            )}</Field>
          </div>
          <Field label={t('adminNewTicket.description')}>{(_id, c) => <Textarea {...c} name="description" rows={4} maxLength={4000} />}</Field>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t('adminInvite.cancel')}</Button>
            <Button type="submit" loading={pending}>{t('adminNewTicket.create')}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
