'use client';

import { useState, useTransition } from 'react';
import { Wrench, Plus, Trash2 } from 'lucide-react';
import { saveAutoServiceAction, deleteAutoServiceAction } from '@/app/(app)/dashboard/auto/actions';
import { vehicleLabel } from '@/lib/auto/renewals';
import { fmtDate } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/home/field';
import { EmptyState } from '@/components/ui/states';

type AutoService = Tables<'auto_service_records'>;
type Vehicle = Tables<'vehicles'>;

export function AutoServiceClient({ records, vehicles }: { records: AutoService[]; vehicles: Vehicle[] }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const vName = (id: string | null) => { const v = vehicles.find((x) => x.id === id); return v ? vehicleLabel(v) : '—'; };
  const totalSpend = records.reduce((s, r) => s + (Number(r.cost) || 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div><h2 className="text-sm font-semibold">Service log</h2><p className="text-xs text-muted">Oil changes, tires, repairs — a full history per vehicle.</p></div>
        <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Log service</Button>
      </div>

      {records.length === 0 ? (
        <EmptyState icon={Wrench} title="No service history" description="Log maintenance as it happens to protect resale value and stay on schedule." action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Log service</Button>} />
      ) : (
        <>
          <Badge tone="neutral">Total logged: ${totalSpend.toLocaleString()}</Badge>
          <div className="overflow-hidden rounded-2xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-elevated text-left text-xs text-muted"><tr><th className="px-3 py-2 font-medium">Service</th><th className="px-3 py-2 font-medium">Vehicle</th><th className="px-3 py-2 font-medium">Date</th><th className="px-3 py-2 font-medium">Mileage</th><th className="px-3 py-2 font-medium">Cost</th><th /></tr></thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-3 py-2"><p className="font-medium">{r.title}</p>{r.provider && <p className="text-xs text-muted">{r.provider}</p>}</td>
                    <td className="px-3 py-2 text-muted">{vName(r.vehicle_id)}</td>
                    <td className="px-3 py-2 text-muted">{fmtDate(r.service_date)}</td>
                    <td className="px-3 py-2 text-muted">{r.mileage != null ? `${r.mileage.toLocaleString()} mi` : '—'}</td>
                    <td className="px-3 py-2">{r.cost != null ? `$${Number(r.cost).toLocaleString()}` : '—'}</td>
                    <td className="px-3 py-2 text-right"><button onClick={() => start(async () => { await deleteAutoServiceAction(r.id); })} className="text-muted hover:text-danger"><Trash2 className="h-4 w-4" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Log a service">
        <form action={(fd) => start(async () => { await saveAutoServiceAction(fd); setOpen(false); })} className="space-y-3">
          <Field label="What was done"><Input name="title" required placeholder="Oil change & rotation" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Vehicle"><Select name="vehicle_id" defaultValue=""><option value="">—</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{vehicleLabel(v)}</option>)}</Select></Field>
            <Field label="Date"><Input type="date" name="service_date" defaultValue={new Date().toISOString().slice(0, 10)} /></Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Provider"><Input name="provider" /></Field>
            <Field label="Cost"><Input type="number" name="cost" /></Field>
            <Field label="Mileage"><Input type="number" name="mileage" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Next due (date)"><Input type="date" name="next_due_on" /></Field>
            <Field label="Next due (mileage)"><Input type="number" name="next_due_mileage" /></Field>
          </div>
          <Field label="Notes"><Textarea name="description" rows={2} /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" loading={pending}>Save</Button></div>
        </form>
      </Modal>
    </div>
  );
}
