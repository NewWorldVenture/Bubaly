'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Stethoscope, Loader2, Wrench, AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/home/field';
import { Button } from '@/components/ui/button';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Asset = Tables<'home_assets'>;

export function DiagnoseClient({ assets }: { assets: Asset[] }) {
  const tr = useTranslations();
  const t = useTranslations();
  const [assetId, setAssetId] = useState('');
  const [category, setCategory] = useState('');
  const [symptom, setSymptom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ text: string; trade: string; tradeLabel: string } | null>(null);

  function onPickAsset(id: string) {
    setAssetId(id);
    const a = assets.find((x) => x.id === id);
    setCategory(a?.category ?? '');
  }

  async function run() {
    setBusy(true); setError(''); setResult(null);
    const a = assets.find((x) => x.id === assetId);
    try {
      const res = await fetch('/api/ai/home/diagnose', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          assetId: assetId || null, assetName: a?.name ?? '', category: category || a?.category || '',
          brand: a?.brand ?? '', model: a?.model ?? '', symptom,
        }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? tr('diagnoseClient.diagnosisFailed'));
      else setResult({ text: data.text, trade: data.recommendedTrade, tradeLabel: data.recommendedTradeLabel });
    } catch { setError(tr('diagnoseClient.networkError')); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t('diagnoseClient.repairHelp')}</h1>
        <p className="text-sm text-muted">{t('diagnoseClient.describeWhatAposSWrongAnd')}</p>
      </div>

      <Card>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('diagnoseClient.whichItem')}>
            <Select value={assetId} onChange={(e) => onPickAsset(e.target.value)}>
              <option value="">{t('diagnoseClient.pickOrDescribeBelow')}</option>
              {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label={t('diagnoseClient.categoryIfNotListed')}>
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">—</option>
              <option value="hvac">HVAC</option><option value="water_heater">{t('diagnoseClient.waterHeater')}</option>
              <option value="refrigerator">{t('diagnoseClient.refrigerator')}</option><option value="dishwasher">{t('diagnoseClient.dishwasher')}</option>
              <option value="washer">{t('diagnoseClient.washer')}</option><option value="dryer">{t('diagnoseClient.dryer')}</option>
              <option value="oven">Oven/Range</option><option value="roof">{t('diagnoseClient.roof')}</option>
              <option value="garbage_disposal">{t('diagnoseClient.garbageDisposal')}</option><option value="other">{t('diagnoseClient.other')}</option>
            </Select>
          </Field>
        </div>
        <Field label={tr('diagnoseClient.whatsHappening')}>
          <Textarea rows={4} value={symptom} onChange={(e) => setSymptom(e.target.value)} placeholder={tr('diagnoseClient.eGTheDishwasherWontDrain')} />
        </Field>
        <Button onClick={run} loading={busy} disabled={!symptom.trim()}><Stethoscope className="h-4 w-4" /> {t('diagnoseClient.diagnose')}</Button>
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </Card>

      {result && (
        <Card>
          <p className="whitespace-pre-wrap text-sm">{result.text}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
            <span className="inline-flex items-center gap-1.5 text-sm"><Wrench className="h-4 w-4 text-brand-text" /> {t('diagnoseClient.recommendedPro')} <strong>{result.tradeLabel}</strong></span>
            <Link href={`/dashboard/home/pros?trade=${result.trade}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand px-2.5 text-xs font-medium text-brand-fg">
              {t('diagnoseClient.findA')} {result.tradeLabel} pro
            </Link>
          </div>
          <p className="mt-2 inline-flex items-start gap-1 text-[11px] text-muted"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {t('diagnoseClient.aiGuidanceForTriageOnlyFor')}</p>
        </Card>
      )}
    </div>
  );
}
