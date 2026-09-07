'use client';

import { useMemo, useState } from 'react';
import { Gauge, Plus, Trash2, TrendingUp, TrendingDown, Sparkles, Loader2, Lightbulb } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { AiInsight } from '@/components/ai/ai-insight';
import { fmtDate } from '@/lib/utils/format';
import { UTILITY_KINDS, utilityLabel, usd, latestByKind, monthlyTotalCents, trendForKind, deltaPct, type BillLike } from '@/lib/home/utilities';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Bill = Tables<'utility_bills'>;
const blank = () => ({ kind: 'electric', provider: '', period_month: new Date().toISOString().slice(0, 7) + '-01', amount: '', usage: '', unit: '', note: '' });

type SavingsFinding = { kind: string; severity: 'high' | 'medium' | 'info'; title: string; detail: string };
type SavingsResult = {
  findings: SavingsFinding[];
  recommendations: string | null;
  aiUsed: boolean;
  summary: { monthlyTotalCents: number; annualTotalCents: number; topCostKind: string | null };
};
const SEVERITY_CLS: Record<SavingsFinding['severity'], string> = {
  high: 'border-danger/40 bg-danger/10',
  medium: 'border-amber-500/40 bg-amber-500/10',
  info: 'border-border bg-surface/40',
};

export function UtilitiesModule() {
  const t = useTranslations();
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const { data: bills, loading, error, refresh } = useRealtimeQuery<Bill>({
    table: 'utility_bills', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('utility_bills').select('*').eq('family_id', familyId).order('period_month', { ascending: false }),
  });

  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const [savings, setSavings] = useState<SavingsResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const all = useMemo(() => bills ?? [], [bills]);
  const total = useMemo(() => monthlyTotalCents(all as BillLike[]), [all]);
  const latest = useMemo(() => latestByKind(all), [all]);
  const kinds = useMemo(() => [...new Set(all.map((b) => b.kind))], [all]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const cents = Math.round(parseFloat(form.amount || '0') * 100);
    const row = {
      kind: form.kind, provider: form.provider.trim() || null, period_month: form.period_month,
      amount_cents: cents, usage: form.usage ? parseFloat(form.usage) : null, unit: form.unit.trim() || null, note: form.note.trim() || null,
    };
    const { error } = await createClient().from('utility_bills').insert({ ...row, family_id: familyId, created_by: userId });
    if (error) return toastError(describeDbError(error));
    success(t('utilitiesModule.billAdded')); setForm(null);
  }
  async function remove(id: string) {
    if (!confirm(t('utilitiesModule.deleteThisBill'))) return;
    const { error } = await createClient().from('utility_bills').delete().eq('id', id);
    if (error) toastError(describeDbError(error)); else success(t('utilitiesModule.deleted'));
  }
  async function analyze() {
    setAnalyzing(true);
    try {
      const res = await fetch('/api/ai/home/utility-savings', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { toastError(data.error ?? t('utilitiesModule.couldNotAnalyseUtilities')); return; }
      setSavings(data as SavingsResult);
    } catch {
      toastError(t('utilitiesModule.couldNotAnalyseUtilities'));
    } finally {
      setAnalyzing(false);
    }
  }

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={t('utilitiesModule.couldNotLoadUtilityBills')} onRetry={refresh} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold"><Gauge className="h-4 w-4 text-brand-text" /> {t('utilities.utilityTracking')}</h3>
        <div className="flex items-center gap-2">
          {kinds.length > 0 && (
            <Button variant="secondary" onClick={analyze} disabled={analyzing}>
              {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {t('utilities.aiSavings')}
            </Button>
          )}
          <AiInsight kind="utilities" iconOnly />
          <Button onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> {t('utilities.addBill')}</Button>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-surface/40 p-4">
        <p className="text-xs text-muted">{t('utilities.currentMonthlyRunRateLatestBill')}</p>
        <p className="text-2xl font-bold">{usd(total)}<span className="text-sm font-normal text-muted">/mo</span></p>
      </div>

      {savings && (
        <div className="rounded-2xl border border-brand/30 bg-brand/5 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="flex items-center gap-2 text-sm font-semibold"><Lightbulb className="h-4 w-4 text-brand-text" /> {t('utilities.savingsAnalysis')}</h4>
            <span className="text-xs text-muted">~{usd(savings.summary.annualTotalCents)}/yr {savings.aiUsed ? '· AI' : '· data-based'}</span>
          </div>
          {savings.findings.length === 0 && !savings.recommendations ? (
            <p className="text-sm text-muted">{t('utilities.yourUtilitiesLookSteadyNoSpikes')}</p>
          ) : (
            <>
              {savings.findings.length > 0 && (
                <div className="space-y-2">
                  {savings.findings.map((f, i) => (
                    <div key={i} className={`rounded-xl border p-3 ${SEVERITY_CLS[f.severity]}`}>
                      <p className="text-sm font-medium">{f.title}</p>
                      <p className="text-xs text-muted mt-0.5">{f.detail}</p>
                    </div>
                  ))}
                </div>
              )}
              {savings.recommendations && (
                <div className="rounded-xl border border-border bg-surface/40 p-3">
                  <p className="whitespace-pre-wrap text-sm text-fg/90">{savings.recommendations}</p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {kinds.length === 0 ? (
        <EmptyState icon={Gauge} title={t('utilities.noUtilityBillsYet')} description={t('utilitiesModule.logBillsToMonitorCosts')} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {kinds.map((kind) => {
            const cur = latest.get(kind);
            const delta = deltaPct(all as BillLike[], kind);
            const series = trendForKind(all as BillLike[], kind);
            const max = Math.max(1, ...series.map((s) => s.amount_cents));
            return (
              <div key={kind} className="rounded-2xl border border-border bg-surface/40 p-4">
                <div className="flex items-center justify-between">
                  <p className="font-semibold">{utilityLabel(kind)}</p>
                  {delta !== null && (
                    <span className={`inline-flex items-center gap-1 text-xs ${delta > 0 ? 'text-danger' : 'text-success'}`}>
                      {delta > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}{Math.abs(delta)}%
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xl font-bold">{cur ? usd(cur.amount_cents) : '—'}</p>
                <p className="text-xs text-muted">{cur ? fmtDate(cur.period_month) : ''}{cur?.provider ? ` · ${cur.provider}` : ''}</p>
                <div className="mt-3 flex h-8 items-end gap-1">
                  {series.slice(-8).map((s) => (
                    <div key={s.period_month} className="flex-1 rounded-sm bg-brand/60" style={{ height: `${(s.amount_cents / max) * 100}%` }} title={`${s.period_month}: ${usd(s.amount_cents)}`} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-2">
        {all.slice(0, 30).map((b) => (
          <div key={b.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface/40 p-3 text-sm">
            <span>{utilityLabel(b.kind)} · <span className="font-medium">{usd(b.amount_cents)}</span> · {fmtDate(b.period_month)}{b.usage ? ` · ${b.usage}${b.unit ?? ''}` : ''}</span>
            <button onClick={() => remove(b.id)} className="text-muted hover:text-danger" aria-label={t('utilities.delete')}><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
      </div>

      {form && (
        <Modal open onClose={() => setForm(null)} title={t('utilities.addUtilityBill')}>
          <form onSubmit={save} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('utilities.utility')}>{(id) => <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{UTILITY_KINDS.map((k) => <option key={k} value={k}>{utilityLabel(k)}</option>)}</Select>}</Field>
              <Field label={t('utilities.month')}>{(id) => <Input id={id} type="date" value={form.period_month} onChange={(e) => setForm({ ...form, period_month: e.target.value })} />}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('utilities.amount')}>{(id) => <Input id={id} type="number" inputMode="decimal" step="0.01" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />}</Field>
              <Field label={t('utilities.provider')}>{(id) => <Input id={id} value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} />}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('utilities.usageOptional')}>{(id) => <Input id={id} type="number" inputMode="decimal" step="0.01" value={form.usage} onChange={(e) => setForm({ ...form, usage: e.target.value })} />}</Field>
              <Field label={t('utilities.unitKwhGal')}>{(id) => <Input id={id} value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />}</Field>
            </div>
            <Field label={t('utilities.note')}>{(id) => <Textarea id={id} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setForm(null)}>{t('utilities.cancel')}</Button>
              <Button type="submit">Add</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
