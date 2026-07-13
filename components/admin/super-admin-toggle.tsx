'use client';

// Per-user site super-admin toggle for the Admin → Users table. Writes the
// super_admins row via the guarded, audited adminSetSuperAdminAction. Built-in/
// env admins are shown locked (managed in code), and you can't toggle yourself
// off (the action also enforces both).

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { adminSetSuperAdminAction } from '@/app/(app)/admin/actions';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';

export function SuperAdminToggle({ email, isAdmin, locked }: { email: string; isAdmin: boolean; locked: boolean }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [on, setOn] = useState(isAdmin);
  const [pending, start] = useTransition();

  if (locked) {
    return (
      <span title="Set via code / SUPER_ADMIN_EMAILS env" className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-text/80">
        <ShieldCheck className="h-3.5 w-3.5" /> Admin (code)
      </span>
    );
  }

  function toggle() {
    if (pending) return;
    const next = !on;
    if (!window.confirm(next ? `Grant super-admin to ${email}?` : `Remove super-admin from ${email}?`)) return;
    setOn(next); // optimistic
    start(async () => {
      const res = await adminSetSuperAdminAction({ email, makeAdmin: next });
      if (!res.ok) {
        setOn(!next);
        toastError(res.error ?? 'Could not update super-admin access.');
        return;
      }
      success(next ? `${email} is now a super-admin` : `Removed super-admin from ${email}`);
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-pressed={on}
      aria-label={`Super-admin for ${email}`}
      className={cn('relative h-6 w-10 rounded-full transition disabled:opacity-50', on ? 'bg-brand' : 'bg-border')}
    >
      <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white transition', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}
