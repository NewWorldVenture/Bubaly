'use client';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Cloud, Loader2, Trash2 } from 'lucide-react';
import { createBackupNow, deleteBackup } from '@/app/(app)/admin/backup/actions';

export function BackupNowButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" disabled={pending} onClick={() => start(async () => { await createBackupNow('full'); router.refresh(); })} className="btn-cta">
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />} Backup Now
    </button>
  );
}

export function DeleteBackupButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" aria-label="Delete backup" disabled={pending}
      onClick={() => start(async () => { await deleteBackup(id); router.refresh(); })}
      className="text-muted transition hover:text-danger disabled:opacity-50">
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
    </button>
  );
}
