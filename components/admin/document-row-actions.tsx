'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ExternalLink, Trash2 } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { adminGetDocumentUrlAction, adminDeleteDocumentAction } from '@/app/(app)/admin/actions';

export function DocumentRowActions({ documentId, storagePath }: { documentId: string; storagePath: string }) {
  const router = useRouter();
  const { error: toastError, success } = useToast();
  const [busy, setBusy] = useState<'view' | 'delete' | null>(null);

  async function view() {
    setBusy('view');
    const res = await adminGetDocumentUrlAction(storagePath);
    setBusy(null);
    if (!res.ok) return toastError(res.error);
    window.open(res.data!.url, '_blank', 'noopener,noreferrer');
  }

  async function remove() {
    if (!confirm('Delete this document permanently? This cannot be undone.')) return;
    setBusy('delete');
    const res = await adminDeleteDocumentAction(documentId, storagePath);
    setBusy(null);
    if (!res.ok) return toastError(res.error);
    success('Document deleted');
    router.refresh();
  }

  return (
    <div className="flex items-center gap-1">
      <button onClick={view} disabled={busy !== null} className="rounded-lg p-1.5 text-muted hover:text-brand disabled:opacity-50" aria-label="View document" title="View">
        <ExternalLink className="h-4 w-4" />
      </button>
      <button onClick={remove} disabled={busy !== null} className="rounded-lg p-1.5 text-muted hover:text-danger disabled:opacity-50" aria-label="Delete document" title="Delete">
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
