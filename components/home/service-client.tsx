'use client';

import { useState, useTransition } from 'react';
import { Wrench, Plus, Trash2, CalendarClock } from 'lucide-react';
import { saveServiceRecordAction, deleteServiceRecordAction } from '@/app/(app)/dashboard/home/actions';
import { fmtDate } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/home/field';
import { EmptyState } from '@/components/ui/states';

type ServiceRecord = Tables<'home_service_records'>;
type Asset = Tables<'home_assets'>;

export function ServiceClient({ records, assets }: { records: ServiceRecord[]; assets: Asset[] }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const assetName = (id: string | null) => assets.find((a) => a.id === id)?.name ?? null;
  const totalSpend = records.reduce((s, r) => s + (Number(r.cost) || 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Service Log</h1>
          <p className="text-sm text-muted">A complete repair &amp; maintenance history — great for resale and warranty claims.</p>
        </div>
        <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Log service</Button>
      </div>

      {records.length > 0 && (
        <div className="grid-stats">
          <div className="stat-card"><div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand-text"><Wrench className="h-5 w-5" /></div><div><p className="text-xl font-bold leading-none">{records.length}</p><p className="mt-1 text-xs text-muted">Records</p></div></div>
          <div className="stat-card"><div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-success/10 text-success"><CalendarClock className="h-5 w-5" /></div><div><p className="text-xl font-bold leading-none">${totalSpend.toLocaleString()}</p><p className="mt-1 text-xs text-muted">Total logged spend</p></div></div>
        </div>
      )}

      {records.length === 0 ? (
        <EmptyState icon={Wrench} title="No service history yet" description="Log repairs and maintenance as they happen to build a full home record." action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Log service</Button>} />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-elevated text-left text-xs text-muted">
              <tr><th className="px-3 py-2 font-medium">Service</th><th className="px-3 py-2 font-medium">Asset</th><th className="px-3 py-2 font-medium">Date</th><th className="px-3 py-2 font-medium">Cost</th><th className="px-3 py-2 font-medium">Next due</th><th /></tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2"><p className="font-medium">{r.title}</p>{r.provider && <p className="text-xs text-muted">{r.provider}</p>}</td>
                  <td className="px-3 py-2 text-muted">{assetName(r.asset_id) ?? '—'}</td>
                  <td className="px-3 py-2 text-muted">{fmtDate(r.service_date)}</td>
                  <td className="px-3 py-2">{r.cost != null ? `$${Number(r.cost).toLocaleString()}` : '—'}</td>
                  <td className="px-3 py-2">{r.next_due_on ? <Badge tone="warning">{fmtDate(r.next_due_on)}</Badge> : '—'}</td>
                  <td className="px-3 py-2 text-right"><button onClick={() => start(async () => { await deleteServiceRecordAction(r.id); })} className="text-muted hover:text-danger"><Trash2 className="h-4 w-4" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Log a service">
        <form action={(fd) => start(async () => { await saveServiceRecordAction(fd); setOpen(false); })} className="space-y-3">
          <Field label="What was done"><Input name="title" required placeholder="HVAC annual tune-up" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Asset">
              <Select name="asset_id" defaultValue=""><option value="">— none —</option>{assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
            </Field>
            <Field label="Date"><Input type="date" name="service_date" defaultValue={new Date().toISOString().slice(0, 10)} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Provider"><Input name="provider" placeholder="Acme Heating" /></Field>
            <Field label="Cost"><Input type="number" step="0.01" name="cost" /></Field>
          </div>
          <Field label="Next due (optional)"><Input type="date" name="next_due_on" /></Field>
          <Field label="Notes"><Textarea name="description" rows={2} /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" loading={pending}>Save</Button></div>
        </form>
      </Modal>
    </div>
  );
}
