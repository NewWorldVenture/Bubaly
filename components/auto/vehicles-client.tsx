'use client';

import { useState, useTransition } from 'react';
import { Car, Plus, Pencil, Trash2, Gauge } from 'lucide-react';
import { saveVehicleAction, deleteVehicleAction } from '@/app/(app)/dashboard/auto/actions';
import { vehicleLabel, BODY_TYPES, FUEL_TYPES } from '@/lib/auto/renewals';
import type { Tables } from '@/lib/database.types';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/home/field';
import { EmptyState } from '@/components/ui/states';
import { useTranslations } from '@/components/i18n/locale-provider';

type Vehicle = Tables<'vehicles'>;
type Member = { id: string; display_name: string | null };

export function VehiclesClient({ vehicles, members }: { vehicles: Vehicle[]; members: Member[] }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Vehicle | null>(null);
  const [pending, start] = useTransition();
  const driverName = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t('vehiclesClient.vehicles')}</h2>
        <Button onClick={() => { setEditing(null); setOpen(true); }}><Plus className="h-4 w-4" /> {t('vehiclesClient.addVehicle')}</Button>
      </div>

      {vehicles.length === 0 ? (
        <EmptyState icon={Car} title={t('vehiclesClient.noVehiclesYet')} description="Add your cars to track registration, inspection, insurance, and service." action={<Button onClick={() => { setEditing(null); setOpen(true); }}><Plus className="h-4 w-4" /> {t('vehiclesClient.addVehicle')}</Button>} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {vehicles.map((v) => (
            <Card key={v.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{vehicleLabel(v)}</p>
                  <p className="text-xs text-muted">{[v.color, v.body_type, v.fuel_type].filter(Boolean).join(' · ') || '—'}</p>
                </div>
                <Badge tone={v.status === 'active' ? 'success' : 'neutral'}>{v.status}</Badge>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                {v.license_plate && <Badge tone="brand">{v.license_plate}{v.plate_state ? ` ${v.plate_state}` : ''}</Badge>}
                {v.vin && <Badge tone="neutral">VIN …{v.vin.slice(-6)}</Badge>}
                {v.mileage != null && <Badge tone="neutral"><Gauge className="mr-1 h-3 w-3" />{v.mileage.toLocaleString()} mi</Badge>}
                {driverName(v.primary_driver) && <Badge tone="accent">{driverName(v.primary_driver)}</Badge>}
              </div>
              <div className="mt-3 flex items-center gap-3 border-t border-border/50 pt-2 text-xs">
                <button onClick={() => { setEditing(v); setOpen(true); }} className="inline-flex items-center gap-1 text-muted hover:text-fg"><Pencil className="h-3.5 w-3.5" /> Edit</button>
                <button onClick={() => start(async () => { await deleteVehicleAction(v.id); })} className="inline-flex items-center gap-1 text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? 'Edit vehicle' : 'Add vehicle'}>
        <form action={(fd) => start(async () => { await saveVehicleAction(fd); setOpen(false); })} className="space-y-3">
          {editing && <input type="hidden" name="id" value={editing.id} />}
          <div className="grid grid-cols-3 gap-3">
            <Field label={t('vehiclesClient.year')}><Input type="number" name="year" defaultValue={editing?.year ?? ''} /></Field>
            <Field label={t('vehiclesClient.make')}><Input name="make" defaultValue={editing?.make ?? ''} placeholder={t('vehiclesClient.toyota')} /></Field>
            <Field label={t('vehiclesClient.model')}><Input name="model" defaultValue={editing?.model ?? ''} placeholder="RAV4" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('vehiclesClient.nickname')}><Input name="nickname" defaultValue={editing?.nickname ?? ''} placeholder="Mom's car" /></Field>
            <Field label={t('vehiclesClient.color')}><Input name="color" defaultValue={editing?.color ?? ''} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('vehiclesClient.licensePlate')}><Input name="license_plate" defaultValue={editing?.license_plate ?? ''} /></Field>
            <Field label={t('vehiclesClient.plateState')}><Input name="plate_state" defaultValue={editing?.plate_state ?? ''} maxLength={2} placeholder="CA" /></Field>
          </div>
          <Field label="VIN"><Input name="vin" defaultValue={editing?.vin ?? ''} /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label={t('vehiclesClient.bodyType')}><Select name="body_type" defaultValue={editing?.body_type ?? ''}><option value="">—</option>{BODY_TYPES.map((b) => <option key={b} value={b}>{b}</option>)}</Select></Field>
            <Field label={t('vehiclesClient.fuel')}><Select name="fuel_type" defaultValue={editing?.fuel_type ?? ''}><option value="">—</option>{FUEL_TYPES.map((f) => <option key={f} value={f}>{f}</option>)}</Select></Field>
            <Field label={t('vehiclesClient.mileage')}><Input type="number" name="mileage" defaultValue={editing?.mileage ?? ''} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('vehiclesClient.primaryDriver')}><Select name="primary_driver" defaultValue={editing?.primary_driver ?? ''}><option value="">—</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name ?? 'Member'}</option>)}</Select></Field>
            <Field label={t('vehiclesClient.status')}><Select name="status" defaultValue={editing?.status ?? 'active'}><option value="active">{t('vehiclesClient.active')}</option><option value="sold">{t('vehiclesClient.sold')}</option><option value="stored">{t('vehiclesClient.stored')}</option></Select></Field>
          </div>
          <Field label={t('vehiclesClient.notes')}><Textarea name="notes" rows={2} defaultValue={editing?.notes ?? ''} /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t('vehiclesClient.cancel')}</Button><Button type="submit" loading={pending}>{editing ? 'Save' : 'Add'}</Button></div>
        </form>
      </Modal>
    </div>
  );
}
