'use client';

import { useState } from 'react';
import { AlertTriangle, Phone, Loader2, Stethoscope } from 'lucide-react';
import { vehicleLabel } from '@/lib/auto/renewals';
import type { Tables } from '@/lib/database.types';
import { Card } from '@/components/ui/card';
import { Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/home/field';
import { Button } from '@/components/ui/button';

type Vehicle = Tables<'vehicles'>;

export function AccidentClient({ vehicles, claimsPhone }: { vehicles: Vehicle[]; claimsPhone: string | null }) {
  const [vehicleId, setVehicleId] = useState('');
  const [situation, setSituation] = useState('');
  const [injuries, setInjuries] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');

  async function run() {
    setBusy(true); setError(''); setText('');
    const v = vehicles.find((x) => x.id === vehicleId);
    try {
      const res = await fetch('/api/ai/auto/accident', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vehicleId: vehicleId || null, vehicleDesc: v ? vehicleLabel(v) : '', situation, injuries, hasInsurance: Boolean(claimsPhone) }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Request failed.');
      else setText(data.text ?? '');
    } catch { setError('Network error.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <Card className="border-danger/30 bg-danger/5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-danger"><AlertTriangle className="h-4 w-4" /> If anyone is hurt or in danger, call 911 first.</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          <a href="tel:911" className="inline-flex h-10 items-center gap-2 rounded-xl bg-danger px-4 text-sm font-semibold text-white"><Phone className="h-4 w-4" /> Call 911</a>
          {claimsPhone && <a href={`tel:${claimsPhone}`} className="inline-flex h-10 items-center gap-2 rounded-xl border border-border px-4 text-sm font-medium hover:bg-elevated"><Phone className="h-4 w-4" /> Call insurance claims</a>}
        </div>
      </Card>

      <Card>
        <h2 className="mb-1 text-sm font-semibold">AI accident assistant</h2>
        <p className="mb-3 text-xs text-muted">Tell me what happened and I&apos;ll walk you through what to do, document, and who to call.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Vehicle"><Select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}><option value="">—</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{vehicleLabel(v)}</option>)}</Select></Field>
          <label className="mt-7 flex items-center gap-2 text-sm"><input type="checkbox" checked={injuries} onChange={(e) => setInjuries(e.target.checked)} /> Someone may be injured</label>
        </div>
        <Field label="What happened?"><Textarea rows={4} value={situation} onChange={(e) => setSituation(e.target.value)} placeholder="e.g. Rear-ended at a red light. Minor bumper damage, everyone okay. Other driver stopped." /></Field>
        <Button onClick={run} loading={busy} disabled={!situation.trim()}><Stethoscope className="h-4 w-4" /> Get step-by-step help</Button>
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </Card>

      {text && <Card><p className="whitespace-pre-wrap text-sm">{text}</p></Card>}
    </div>
  );
}
