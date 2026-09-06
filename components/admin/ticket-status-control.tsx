'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/ui/toast';
import { adminUpdateTicketStatusAction, type TicketStatus } from '@/app/(app)/admin/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

const STATUSES: TicketStatus[] = ['open', 'pending', 'resolved', 'closed'];

export function TicketStatusControl({ ticketId, status }: { ticketId: string; status: TicketStatus }) {
  const t = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [value, setValue] = useState<TicketStatus>(status);
  const [pending, start] = useTransition();

  function onChange(next: TicketStatus) {
    const previous = value;
    setValue(next);
    start(async () => {
      const res = await adminUpdateTicketStatusAction(ticketId, next);
      if (!res.ok) {
        setValue(previous);
        return toastError(res.error);
      }
      success(`Marked ${next}`);
      router.refresh();
    });
  }

  return (
    <select
      value={value}
      disabled={pending}
      onChange={(e) => onChange(e.target.value as TicketStatus)}
      className="rounded-lg border border-border bg-surface px-2 py-1 text-xs font-medium capitalize outline-none focus:border-brand disabled:opacity-50"
      aria-label={t('ticketStatusControl.ticketStatus')}
    >
      {STATUSES.map((s) => (
        <option key={s} value={s} className="capitalize">{s}</option>
      ))}
    </select>
  );
}
