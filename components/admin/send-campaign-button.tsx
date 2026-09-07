'use client';

import { useState } from 'react';
import { useTranslations } from '@/components/i18n/locale-provider';
import { useRouter } from 'next/navigation';
import { Send } from 'lucide-react';
import { useToast } from '@/components/ui/toast';

export function SendCampaignButton({ id, disabled }: { id: string; disabled?: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [busy, setBusy] = useState(false);

  async function onSend() {
    if (busy) return;
    // Confirm with a real recipient count before sending.
    let count = 0;
    try {
      const pre = await fetch(`/api/admin/marketing/email/send?id=${id}`);
      const pj = await pre.json();
      count = pj.recipients ?? 0;
    } catch { /* fall through to confirm without count */ }

    const ok = window.confirm(count > 0
      ? `Send this campaign to ${count} recipient${count === 1 ? '' : 's'}? This cannot be undone.`
      : 'No eligible recipients were found. Send anyway?');
    if (!ok || count === 0) { if (count === 0) toastError(t('sendCampaignButton.noEligibleRecipients')); return; }

    setBusy(true);
    try {
      const res = await fetch('/api/admin/marketing/email/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (!res.ok) { toastError(json.error ?? 'Send failed.'); return; }
      success(`Sent to ${json.sent} recipient${json.sent === 1 ? '' : 's'}.`);
      router.refresh();
    } catch {
      toastError(t('sendCampaignButton.networkErrorPleaseTryAgain'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={onSend}
      disabled={busy || disabled}
      className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand/90 disabled:opacity-60"
    >
      <Send className="h-3.5 w-3.5" /> {busy ? 'Sending…' : 'Send'}
    </button>
  );
}
