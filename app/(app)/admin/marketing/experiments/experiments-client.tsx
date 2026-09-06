'use client';

import { useState, useTransition } from 'react';
import { Plus } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { createExperiment, setExperimentStatus, setExperimentWinner } from './actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export function NewExperimentForm() {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  return (
    <div>
      {!open ? (
        <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-brand/90">
          <Plus className="h-4 w-4" /> {t('adminMarketingExperimentsExperimentsClient.newExperiment')}
        </button>
      ) : (
        <form
          action={(fd) => start(async () => {
            const res = await createExperiment(fd);
            if (res?.ok) { success('Experiment created'); setOpen(false); }
            else toastError(res?.error ?? 'Could not create');
          })}
          className="space-y-3 rounded-2xl border border-border bg-surface/40 p-4"
        >
          <input name="name" required placeholder={t('adminMarketingExperimentsExperimentsClient.experimentNameEGHeroCta')} className="h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm" />
          <input name="hypothesis" placeholder={t('adminMarketingExperimentsExperimentsClient.hypothesisOptional')} className="h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm" />
          <input name="metric" defaultValue="signup" placeholder={t('adminMarketingExperimentsExperimentsClient.conversionMetricLabel')} className="h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm" />
          <label className="block text-xs text-muted">{t('adminMarketingExperimentsExperimentsClient.variantsOnePerLineFirstIs')}
            <textarea name="variants" rows={3} defaultValue={'Control\nVariant B'} className="mt-1 w-full rounded-lg border border-border bg-bg p-2 text-sm" />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-border px-3 py-1.5 text-sm">{t('adminMarketingExperimentsExperimentsClient.cancel')}</button>
            <button type="submit" disabled={pending} className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60">{pending ? 'Creating…' : 'Create'}</button>
          </div>
        </form>
      )}
    </div>
  );
}

export function ExperimentControls({ id, status, variants }: {
  id: string; status: string; variants: { key: string; label: string }[];
}) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [pending, start] = useTransition();

  function go(fn: () => Promise<{ ok: boolean; error?: string }>) {
    start(async () => {
      const res = await fn();
      if (res?.ok) success('Updated'); else toastError(res?.error ?? 'Failed');
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status !== 'running' && <button disabled={pending} onClick={() => go(() => setExperimentStatus(id, 'running'))} className="rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-elevated">{t('adminMarketingExperimentsExperimentsClient.start')}</button>}
      {status === 'running' && <button disabled={pending} onClick={() => go(() => setExperimentStatus(id, 'paused'))} className="rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-elevated">{t('adminMarketingExperimentsExperimentsClient.pause')}</button>}
      <select
        disabled={pending}
        defaultValue=""
        onChange={(e) => { if (e.target.value) go(() => setExperimentWinner(id, e.target.value)); }}
        className="rounded-lg border border-border bg-surface px-2 py-1 text-xs"
      >
        <option value="">{t('adminMarketingExperimentsExperimentsClient.declareWinner')}</option>
        {variants.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
      </select>
    </div>
  );
}
