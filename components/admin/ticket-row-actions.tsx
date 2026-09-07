'use client';

import { useState, useTransition } from 'react';
import { MoreHorizontal, CheckCircle, XCircle, RefreshCw, User } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { resolveTicketAction, closeTicketAction, reopenTicketAction } from '@/app/(app)/admin/support-tickets/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export function TicketRowActions({ ticketId, status }: { ticketId: string; status: string }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const { success, error: toastError } = useToast();

  function act(fn: (id: string) => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      try {
        const result = await fn(ticketId);
        if (!result.ok) {
          toastError(result.error ?? 'Could not update that ticket.');
          return;
        }
        success(t('ticketRowActions.ticketStatusUpdated'));
        setOpen(false);
      } catch {
        toastError(t('ticketRowActions.couldNotUpdateThatTicket'));
      }
    });
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={isPending}
        className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-elevated focus-ring disabled:opacity-50"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-xl popover-surface p-1 shadow-glass animate-fade-in">
            {status !== 'resolved' && status !== 'closed' && (
              <button
                onClick={() => act(resolveTicketAction)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-success hover:bg-elevated"
              >
                <CheckCircle className="h-4 w-4" /> {t('ticketRowActions.markResolved')}
              </button>
            )}
            {status !== 'closed' && (
              <button
                onClick={() => act(closeTicketAction)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-elevated"
              >
                <XCircle className="h-4 w-4" /> {t('ticketRowActions.closeTicket')}
              </button>
            )}
            {(status === 'resolved' || status === 'closed') && (
              <button
                onClick={() => act(reopenTicketAction)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-brand-text hover:bg-elevated"
              >
                <RefreshCw className="h-4 w-4" /> {t('ticketRowActions.reopen')}
              </button>
            )}
            <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-elevated">
              <User className="h-4 w-4" /> {t('ticketRowActions.assignAgent')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
