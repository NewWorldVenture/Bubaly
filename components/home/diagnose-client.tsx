'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Stethoscope, Loader2, Wrench, AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/home/field';
import { Button } from '@/components/ui/button';
import type { Tables } from '@/lib/database.types';

type Asset = Tables<'home_assets'>;

export function DiagnoseClient({ assets }: { assets: Asset[] }) {
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
      if (!res.ok) setError(data.error ?? 'Diagnosis failed.');
      else setResult({ text: data.text, trade: data.recommendedTrade, tradeLabel: data.recommendedTradeLabel });
    } catch { setError('Network error.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Repair Help</h1>
        <p className="text-sm text-muted">Describe what&apos;s wrong and get an AI triage: likely causes, safe DIY checks, and when to call a pro.</p>
      </div>

      <Card>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Which item?">
            <Select value={assetId} onChange={(e) => onPickAsset(e.target.value)}>
              <option value="">— pick or describe below —</option>
              {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label="Category (if not listed)">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">—</option>
              <option value="hvac">HVAC</option><option value="water_heater">Water Heater</option>
              <option value="refrigerator">Refrigerator</option><option value="dishwasher">Dishwasher</option>
              <option value="washer">Washer</option><option value="dryer">Dryer</option>
              <option value="oven">Oven/Range</option><option value="roof">Roof</option>
              <option value="garbage_disposal">Garbage Disposal</option><option value="other">Other</option>
            </Select>
          </Field>
        </div>
        <Field label="What's happening?">
          <Textarea rows={4} value={symptom} onChange={(e) => setSymptom(e.target.value)} placeholder="e.g. The dishwasher won't drain and there's standing water at the bottom after every cycle." />
        </Field>
        <Button onClick={run} loading={busy} disabled={!symptom.trim()}><Stethoscope className="h-4 w-4" /> Diagnose</Button>
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </Card>

      {result && (
        <Card>
          <p className="whitespace-pre-wrap text-sm">{result.text}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
            <span className="inline-flex items-center gap-1.5 text-sm"><Wrench className="h-4 w-4 text-brand" /> Recommended pro: <strong>{result.tradeLabel}</strong></span>
            <Link href={`/dashboard/home/pros?trade=${result.trade}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand px-2.5 text-xs font-medium text-brand-fg">
              Find a {result.tradeLabel} pro
            </Link>
          </div>
          <p className="mt-2 inline-flex items-start gap-1 text-[11px] text-muted"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> AI guidance for triage only — for gas, high-voltage, or structural issues, call a licensed professional.</p>
        </Card>
      )}
    </div>
  );
}
