'use client';

import { useState, useTransition } from 'react';
import { MoreHorizontal, UserX, UserCheck, ShieldOff } from 'lucide-react';
import { deactivateAdminAction, activateAdminAction, revokeAdminAction } from '@/app/(app)/admin/admins/actions';

export function AdminRowActions({ adminId, status, email }: { adminId: string; status: string; email: string }) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function act(fn: (id: string) => Promise<void>) {
    startTransition(async () => {
      await fn(adminId);
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
          <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-xl popover-surface p-1 shadow-glass animate-fade-in">
            {status === 'active' ? (
              <button
                onClick={() => act(deactivateAdminAction)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-warning hover:bg-elevated"
              >
                <UserX className="h-4 w-4" /> Deactivate
              </button>
            ) : (
              <button
                onClick={() => act(activateAdminAction)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-success hover:bg-elevated"
              >
                <UserCheck className="h-4 w-4" /> Activate
              </button>
            )}
            <button
              onClick={() => {
                if (confirm(`Remove admin access for ${email}?`)) act(revokeAdminAction);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-elevated"
            >
              <ShieldOff className="h-4 w-4" /> Remove Access
            </button>
          </div>
        </>
      )}
    </div>
  );
}
