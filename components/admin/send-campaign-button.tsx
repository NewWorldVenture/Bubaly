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
    // Confirm with a real recipient count before sending. A preflight that
    // failed is not "No eligible recipients": the count was not read, so the
    // route's own answer is shown and nothing is asked (review
    // R9-SEND-CAMPAIGN-FAILED-PREFLIGHT-IS-NO-RECIPIENTS).
    let count: number;
    // Everyone still to be reached. Past the per-send cap it is more than
    // `count`, and the dialog says this send reaches only the first of them.
    let audience: number;
    try {
      const pre = await fetch(`/api/admin/marketing/email/send?id=${id}`);
      const pj = await pre.json().catch(() => ({})) as { recipients?: unknown; audience?: unknown; error?: unknown };
      if (!pre.ok || pj.error || typeof pj.recipients !== 'number') {
        toastError(typeof pj.error === 'string' && pj.error ? pj.error : t('send.couldNotLoadCampaignRecipients'));
        return;
      }
      count = pj.recipients;
      audience = typeof pj.audience === 'number' ? pj.audience : count;
    } catch {
      toastError(t('send.couldNotLoadCampaignRecipients'));
      return;
    }

    const ok = window.confirm(count > 0
      ? (audience > count ? t('sendCampaignButton.confirmFirstOf', { n: count, total: audience })
        : count === 1 ? t('sendCampaignButton.confirmOne') : t('sendCampaignButton.confirmMany', { n: count }))
      : t('sendCampaignButton.noRecipientsSendAnyway'));
    if (!ok || count === 0) { if (count === 0) toastError(t('sendCampaignButton.noEligibleRecipients')); return; }

    setBusy(true);
    try {
      const res = await fetch('/api/admin/marketing/email/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (!res.ok) { toastError(json.error ?? 'Send failed.'); return; }
      success(typeof json.remaining === 'number' && json.remaining > 0
        ? t('sendCampaign.sentSomeRestRemain', { count: json.sent ?? 0, remaining: json.remaining })
        : json.sent === 1 ? t('sendCampaign.sentToRecipientOne', { count: json.sent }) : t('sendCampaign.sentToRecipientsMany', { count: json.sent ?? 0 }));
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
