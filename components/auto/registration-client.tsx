'use client';

import { useState, useTransition } from 'react';
import { FileText, Plus, Pencil, Trash2, ClipboardCheck } from 'lucide-react';
import {
  saveRegistrationAction, deleteRegistrationAction, saveInspectionAction, deleteInspectionAction,
} from '@/app/(app)/dashboard/auto/actions';
import { renewalStatus, vehicleLabel, INSPECTION_TYPES } from '@/lib/auto/renewals';
import { fmtDate } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/home/field';
import { EmptyState } from '@/components/ui/states';

type Registration = Tables<'vehicle_registrations'>;
type Inspection = Tables<'vehicle_inspections'>;
type Vehicle = Tables<'vehicles'>;

export function RegistrationClient({
  registrations, inspections, vehicles,
}: {
  registrations: Registration[]; inspections: Inspection[]; vehicles: Vehicle[];
}) {
  const [regOpen, setRegOpen] = useState(false);
  const [regEdit, setRegEdit] = useState<Registration | null>(null);
  const [inspOpen, setInspOpen] = useState(false);
  const [inspEdit, setInspEdit] = useState<Inspection | null>(null);
  const [pending, start] = useTransition();
  const vName = (id: string | null) => { const v = vehicles.find((x) => x.id === id); return v ? vehicleLabel(v) : '—'; };

  return (
    <div className="space-y-6">
      {/* Registrations */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><FileText className="h-4 w-4 text-brand" /> Registrations</h2>
          <Button onClick={() => { setRegEdit(null); setRegOpen(true); }}><Plus className="h-4 w-4" /> Add</Button>
        </div>
        {registrations.length === 0 ? (
          <EmptyState icon={FileText} title="No registrations" description="Track each vehicle's registration renewal date." />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {registrations.map((r) => {
              const s = renewalStatus(r.expires_on);
              return (
                <Card key={r.id}>
                  <div className="flex items-start justify-between gap-2">
                    <div><p className="font-semibold">{vName(r.vehicle_id)}</p><p className="text-xs text-muted">{[r.plate, r.state].filter(Boolean).join(' · ') || '—'}{r.expires_on ? ` · exp ${fmtDate(r.expires_on)}` : ''}</p></div>
                    <Badge tone={s.tone}>{s.label}</Badge>
                  </div>
                  <div className="mt-3 flex items-center gap-3 border-t border-border/50 pt-2 text-xs">
                    <button onClick={() => { setRegEdit(r); setRegOpen(true); }} className="inline-flex items-center gap-1 text-muted hover:text-fg"><Pencil className="h-3.5 w-3.5" /> Edit</button>
                    <button onClick={() => start(async () => { await deleteRegistrationAction(r.id); })} className="inline-flex items-center gap-1 text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Inspections */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><ClipboardCheck className="h-4 w-4 text-brand" /> Inspection stickers</h2>
          <Button onClick={() => { setInspEdit(null); setInspOpen(true); }}><Plus className="h-4 w-4" /> Add</Button>
        </div>
        {inspections.length === 0 ? (
          <EmptyState icon={ClipboardCheck} title="No inspections" description="Track safety/emissions sticker expiry." />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {inspections.map((i) => {
              const s = renewalStatus(i.expires_on);
              return (
                <Card key={i.id}>
                  <div className="flex items-start justify-between gap-2">
                    <div><p className="font-semibold">{vName(i.vehicle_id)}</p><p className="text-xs capitalize text-muted">{i.inspection_type}{i.result ? ` · ${i.result}` : ''}{i.expires_on ? ` · exp ${fmtDate(i.expires_on)}` : ''}</p></div>
                    <Badge tone={s.tone}>{s.label}</Badge>
                  </div>
                  <div className="mt-3 flex items-center gap-3 border-t border-border/50 pt-2 text-xs">
                    <button onClick={() => { setInspEdit(i); setInspOpen(true); }} className="inline-flex items-center gap-1 text-muted hover:text-fg"><Pencil className="h-3.5 w-3.5" /> Edit</button>
                    <button onClick={() => start(async () => { await deleteInspectionAction(i.id); })} className="inline-flex items-center gap-1 text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Registration modal */}
      <Modal open={regOpen} onClose={() => setRegOpen(false)} title={regEdit ? 'Edit registration' : 'Add registration'}>
        <form action={(fd) => start(async () => { await saveRegistrationAction(fd); setRegOpen(false); })} className="space-y-3">
          {regEdit && <input type="hidden" name="id" value={regEdit.id} />}
          <Field label="Vehicle"><Select name="vehicle_id" defaultValue={regEdit?.vehicle_id ?? ''}><option value="">—</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{vehicleLabel(v)}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Plate"><Input name="plate" defaultValue={regEdit?.plate ?? ''} /></Field>
            <Field label="State"><Input name="state" maxLength={2} defaultValue={regEdit?.state ?? ''} /></Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Registered"><Input type="date" name="registered_on" defaultValue={regEdit?.registered_on ?? ''} /></Field>
            <Field label="Expires"><Input type="date" name="expires_on" defaultValue={regEdit?.expires_on ?? ''} /></Field>
            <Field label="Fee"><Input type="number" name="fee" defaultValue={regEdit?.fee ?? ''} /></Field>
          </div>
          <Field label="Notes"><Textarea name="notes" rows={2} defaultValue={regEdit?.notes ?? ''} /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setRegOpen(false)}>Cancel</Button><Button type="submit" loading={pending}>Save</Button></div>
        </form>
      </Modal>

      {/* Inspection modal */}
      <Modal open={inspOpen} onClose={() => setInspOpen(false)} title={inspEdit ? 'Edit inspection' : 'Add inspection'}>
        <form action={(fd) => start(async () => { await saveInspectionAction(fd); setInspOpen(false); })} className="space-y-3">
          {inspEdit && <input type="hidden" name="id" value={inspEdit.id} />}
          <Field label="Vehicle"><Select name="vehicle_id" defaultValue={inspEdit?.vehicle_id ?? ''}><option value="">—</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{vehicleLabel(v)}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type"><Select name="inspection_type" defaultValue={inspEdit?.inspection_type ?? 'safety'}>{INSPECTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
            <Field label="Result"><Select name="result" defaultValue={inspEdit?.result ?? ''}><option value="">—</option><option value="pass">Pass</option><option value="fail">Fail</option><option value="advisory">Advisory</option></Select></Field>
          </div>
          <Field label="Station"><Input name="station" defaultValue={inspEdit?.station ?? ''} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Inspected"><Input type="date" name="inspected_on" defaultValue={inspEdit?.inspected_on ?? ''} /></Field>
            <Field label="Sticker expires"><Input type="date" name="expires_on" defaultValue={inspEdit?.expires_on ?? ''} /></Field>
          </div>
          <Field label="Notes"><Textarea name="notes" rows={2} defaultValue={inspEdit?.notes ?? ''} /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setInspOpen(false)}>Cancel</Button><Button type="submit" loading={pending}>Save</Button></div>
        </form>
      </Modal>
    </div>
  );
}
