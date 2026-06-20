'use client';

import { useState, useTransition } from 'react';
import { MoreHorizontal, CheckCircle, XCircle, RefreshCw, User } from 'lucide-react';
import { resolveTicketAction, closeTicketAction, reopenTicketAction } from '@/app/(app)/admin/support-tickets/actions';

export function TicketRowActions({ ticketId, status }: { ticketId: string; status: string }) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function act(fn: (id: string) => Promise<void>) {
    startTransition(async () => {
      await fn(ticketId);
      setOpen(false);
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
          <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-xl glass-card p-1 shadow-glass animate-fade-in">
            {status !== 'resolved' && status !== 'closed' && (
              <button
                onClick={() => act(resolveTicketAction)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-success hover:bg-elevated"
              >
                <CheckCircle className="h-4 w-4" /> Mark Resolved
              </button>
            )}
            {status !== 'closed' && (
              <button
                onClick={() => act(closeTicketAction)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-elevated"
              >
                <XCircle className="h-4 w-4" /> Close Ticket
              </button>
            )}
            {(status === 'resolved' || status === 'closed') && (
              <button
                onClick={() => act(reopenTicketAction)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-brand hover:bg-elevated"
              >
                <RefreshCw className="h-4 w-4" /> Reopen
              </button>
            )}
            <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-elevated">
              <User className="h-4 w-4" /> Assign Agent
            </button>
          </div>
        </>
      )}
    </div>
  );
}
