'use client';

// "Report" control on a listing detail page. Opens a small dialog to pick a
// reason + add optional details, then files it to the platform safety queue.
// Shown only to non-owners. Once filed, it stays acknowledged for the session.
import { useState, useTransition } from 'react';
import { Flag, Loader2, Check } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { REPORT_REASONS, type ReportReason } from '@/lib/marketplace/reports';
import { reportListingAction } from '@/app/(app)/marketplace/report/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export function ReportButton({ listingId }: { listingId: string }) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [reason, setReason] = useState<ReportReason>('prohibited');
  const [details, setDetails] = useState('');
  const [pending, start] = useTransition();

  if (done) {
    return <span className="inline-flex items-center gap-1 text-xs text-muted"><Check className="h-3.5 w-3.5 text-emerald-500" /> {t('reportButton.reportedThankYou')}</span>;
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-xs text-muted transition hover:text-rose-500">
        <Flag className="h-3.5 w-3.5" /> {t('reportButton.report')}
      </button>
    );
  }

  function submit() {
    start(async () => {
      const res = await reportListingAction({ listingId, reason, details });
      if (!res.ok) { toastError(res.error); return; }
      setOpen(false); setDone(true);
      success('Report sent to our safety team.');
    });
  }

  return (
    <div className="w-full rounded-xl border border-border bg-surface/60 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Flag className="h-4 w-4 text-rose-500" /> {t('reportButton.reportThisListing')}</p>
      <div className="space-y-1" role="radiogroup" aria-label={t('reportButton.reason')}>
        {REPORT_REASONS.map((r) => (
          <label key={r.value} className={cn('flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-xs transition',
            reason === r.value ? 'border-brand bg-brand/5' : 'border-border hover:bg-elevated')}>
            <input type="radio" name="report-reason" value={r.value} checked={reason === r.value}
              onChange={() => setReason(r.value)} className="mt-0.5" />
            <span><span className="font-medium">{r.label}</span> <span className="text-muted">— {r.hint}</span></span>
          </label>
        ))}
      </div>
      <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={2} maxLength={1000}
        placeholder={t('reportButton.anythingElseWeShouldKnowOptional')}
        className="mt-2 w-full rounded-lg border border-border bg-bg px-3 py-2 text-xs outline-none focus:border-brand" />
      <div className="mt-2 flex gap-2">
        <button onClick={submit} disabled={pending}
          className="inline-flex items-center gap-1 rounded-lg bg-rose-500/90 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-rose-500 disabled:opacity-50">
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Flag className="h-3 w-3" />} {t('reportButton.submitReport')}
        </button>
        <button onClick={() => setOpen(false)} className="text-xs text-muted hover:text-fg">{t('reportButton.cancel')}</button>
      </div>
    </div>
  );
}
