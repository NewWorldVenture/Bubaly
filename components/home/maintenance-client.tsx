'use client';

import { useState, useTransition } from 'react';
import { Sparkles, Loader2, CalendarPlus, Check, Wrench, CheckCircle2 } from 'lucide-react';
import { scheduleRecommendedTasksAction } from '@/app/(app)/dashboard/home/actions';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { Tone } from '@/lib/home/maintenance';

export type AssetView = {
  id: string;
  name: string;
  category: string | null;
  ageYears: number;
  expectedLife: number | null;
  lastServiced: string | null;
  hasCadence: boolean;
  life: { percentUsed: number; tone: Tone; label: string } | null;
};

export function MaintenanceClient({
  assets, season, seasonTasks,
}: {
  assets: AssetView[];
  season: string;
  seasonTasks: string[];
}) {
  const [forecast, setForecast] = useState('');
  const [forecastBusy, setForecastBusy] = useState(false);
  const [forecastError, setForecastError] = useState('');

  async function runForecast() {
    setForecastBusy(true); setForecastError(''); setForecast('');
    try {
      const res = await fetch('/api/ai/home/forecast', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          assets: assets.map((a) => ({
            name: a.name, category: a.category, ageYears: a.ageYears,
            expectedLife: a.expectedLife, lastServiced: a.lastServiced,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) setForecastError(data.error ?? 'Forecast failed.');
      else setForecast(data.text ?? '');
    } catch { setForecastError('Network error.'); }
    finally { setForecastBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Maintenance &amp; AI</h1>
        <p className="text-sm text-muted">Stay ahead of repairs — seasonal tasks, an AI 12-month outlook, and one-tap schedules.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Seasonal checklist */}
        <Card>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><CheckCircle2 className="h-4 w-4 text-success" /> This season — <span className="capitalize">{season}</span></h2>
          <ul className="space-y-1.5 text-sm">
            {seasonTasks.map((t) => (
              <li key={t} className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> {t}</li>
            ))}
          </ul>
        </Card>

        {/* AI forecast */}
        <Card>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-brand-text" /> AI maintenance forecast</h2>
          <p className="mb-2 text-xs text-muted">A budget-aware 12-month outlook based on your assets&apos; ages and lifespans.</p>
          <button onClick={runForecast} disabled={forecastBusy || assets.length === 0} className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg disabled:opacity-60">
            {forecastBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Forecast my home
          </button>
          {assets.length === 0 && <p className="mt-2 text-xs text-muted">Add assets in Overview first.</p>}
          {forecastError && <p className="mt-2 text-xs text-danger">{forecastError}</p>}
          {forecast && <p className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-elevated p-2 text-xs">{forecast}</p>}
        </Card>
      </div>

      {/* Assets with life + schedule-recommended */}
      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Wrench className="h-4 w-4 text-brand-text" /> Asset health &amp; recommended schedules</h2>
        {assets.length === 0 ? (
          <p className="text-sm text-muted">No assets yet. Add HVAC, water heater, roof, appliances and more in Overview.</p>
        ) : (
          <div className="space-y-2">
            {assets.map((a) => <AssetRow key={a.id} asset={a} />)}
          </div>
        )}
      </Card>
    </div>
  );
}

function AssetRow({ asset }: { asset: AssetView }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');

  function schedule() {
    setMsg('');
    start(async () => {
      const r = await scheduleRecommendedTasksAction(asset.id);
      if (!r.ok) setMsg(r.error ?? 'Could not schedule.');
      else setMsg(r.created > 0 ? `Scheduled ${r.created} task${r.created === 1 ? '' : 's'}.` : 'Already scheduled.');
    });
  }

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{asset.name}</p>
          <p className="text-xs text-muted">{asset.ageYears > 0 ? `~${asset.ageYears} yr old` : 'Age unknown'}{asset.lastServiced ? ` · last serviced ${asset.lastServiced}` : ''}</p>
        </div>
        {asset.life && <Badge tone={asset.life.tone}>{asset.life.label}</Badge>}
      </div>
      {asset.life && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-elevated">
          <div className={`h-full rounded-full ${asset.life.tone === 'danger' ? 'bg-danger' : asset.life.tone === 'warning' ? 'bg-warning' : 'bg-success'}`} style={{ width: `${asset.life.percentUsed}%` }} />
        </div>
      )}
      <div className="mt-2 flex items-center gap-3">
        {asset.hasCadence ? (
          <button onClick={schedule} disabled={pending} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium hover:bg-elevated disabled:opacity-60">
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarPlus className="h-3.5 w-3.5" />} Schedule recommended maintenance
          </button>
        ) : (
          <span className="text-xs text-muted">No preset schedule for this type.</span>
        )}
        {msg && <span className="text-xs text-success">{msg}</span>}
      </div>
    </div>
  );
}
