'use client';

// Moderation controls for a single marketplace safety report (super-admin).
// Start review, then action (optionally withdrawing the listing) or dismiss,
// with an optional resolution note.
import { useState, useTransition } from 'react';
import { Loader2, ShieldX, ShieldCheck, Eye } from 'lucide-react';
import { resolveReportAction, startReviewAction } from '@/app/(app)/admin/marketplace/reports/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export function ReportModeration({ id, status }: { id: string; status: string }) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [resolution, setResolution] = useState('');
  const [withdraw, setWithdraw] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const resolved = status === 'actioned' || status === 'dismissed';

  if (resolved) return <span className="text-xs text-muted">{t('reportModeration.resolved')}{status})</span>;

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const res = await fn();
      setMsg(res.ok ? 'Done.' : (res.error ?? 'Failed.'));
    });

  return (
    <div className="mt-2 space-y-2">
      {status === 'open' && (
        <button onClick={() => run(() => startReviewAction(id))} disabled={pending}
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium transition hover:bg-elevated disabled:opacity-50">
          <Eye className="h-3 w-3" /> {t('reportModeration.startReview')}
        </button>
      )}
      <textarea value={resolution} onChange={(e) => setResolution(e.target.value)} rows={2}
        placeholder={t('reportModeration.resolutionNoteOptional')}
        className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs outline-none focus:border-brand" />
      <label className="flex items-center gap-1.5 text-xs text-muted">
        <input type="checkbox" checked={withdraw} onChange={(e) => setWithdraw(e.target.checked)} /> {t('reportModeration.withdrawTheListingWhenActioning')}
      </label>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => run(() => resolveReportAction({ id, status: 'actioned', resolution, withdrawListing: withdraw }))} disabled={pending}
          className="inline-flex items-center gap-1 rounded-lg bg-rose-500/90 px-2.5 py-1 text-xs font-bold text-white transition hover:bg-rose-500 disabled:opacity-50">
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldX className="h-3 w-3" />} {t('reportModeration.action')}
        </button>
        <button onClick={() => run(() => resolveReportAction({ id, status: 'dismissed', resolution }))} disabled={pending}
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium transition hover:bg-elevated disabled:opacity-50">
          <ShieldCheck className="h-3 w-3" /> {t('reportModeration.dismiss')}
        </button>
        {msg && <span className="self-center text-xs text-muted">{msg}</span>}
      </div>
    </div>
  );
}
