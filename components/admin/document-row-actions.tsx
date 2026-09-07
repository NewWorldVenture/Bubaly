'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ExternalLink, Trash2 } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { adminGetDocumentUrlAction, adminDeleteDocumentAction } from '@/app/(app)/admin/actions';
import { preOpenWindow } from '@/lib/utils/open-url';
import { useTranslations } from '@/components/i18n/locale-provider';

export function DocumentRowActions({ documentId, storagePath }: { documentId: string; storagePath: string }) {
  const t = useTranslations();
  const router = useRouter();
  const { error: toastError, success } = useToast();
  const [busy, setBusy] = useState<'view' | 'delete' | null>(null);

  async function view() {
    const tab = preOpenWindow(); // sync, inside the tap gesture (iOS popup blocker)
    setBusy('view');
    const res = await adminGetDocumentUrlAction(storagePath);
    setBusy(null);
    if (!res.ok) { tab.cancel(); return toastError(res.error); }
    tab.navigate(res.data!.url);
  }

  async function remove() {
    if (!confirm(t('documentRowActions.deleteThisDocumentPermanentlyThis'))) return;
    setBusy('delete');
    const res = await adminDeleteDocumentAction(documentId, storagePath);
    setBusy(null);
    if (!res.ok) return toastError(res.error);
    success(t('documentRowActions.documentDeleted'));
    router.refresh();
  }

  return (
    <div className="flex items-center gap-1">
      <button onClick={view} disabled={busy !== null} className="rounded-lg p-1.5 text-muted hover:text-brand-text disabled:opacity-50" aria-label={t('documentRowActions.viewDocument')} title={t('documentRowActions.view')}>
        <ExternalLink className="h-4 w-4" />
      </button>
      <button onClick={remove} disabled={busy !== null} className="rounded-lg p-1.5 text-muted hover:text-danger disabled:opacity-50" aria-label={t('documentRowActions.deleteDocument')} title={t('documentRowActions.delete')}>
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
