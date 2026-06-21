'use client';

import { useState, useTransition } from 'react';
import { KeyRound, Plus, Pencil, Trash2, MapPin } from 'lucide-react';
import { saveRentalAction, deleteRentalAction } from '@/app/(app)/dashboard/auto/actions';
import { RENTAL_STATUSES } from '@/lib/auto/renewals';
import { fmtDate } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/home/field';
import { EmptyState } from '@/components/ui/states';

type Rental = Tables<'rental_cars'>;
const TONE: Record<string, 'success' | 'brand' | 'neutral' | 'danger'> = { active: 'success', upcoming: 'brand', returned: 'neutral', cancelled: 'danger' };
const toLocal = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16) : '');

export function RentalsClient({ rentals }: { rentals: Rental[] }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Rental | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Rental cars</h2>
        <Button onClick={() => { setEditing(null); setOpen(true); }}><Plus className="h-4 w-4" /> Add rental</Button>
      </div>

      {rentals.length === 0 ? (
        <EmptyState icon={KeyRound} title="No rentals" description="Track rental reservations — confirmation, pickup/return, and coverage — all in one place." action={<Button onClick={() => { setEditing(null); setOpen(true); }}><Plus className="h-4 w-4" /> Add rental</Button>} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rentals.map((r) => (
            <Card key={r.id}>
              <div className="flex items-start justify-between gap-2">
                <div><p className="font-semibold">{r.company ?? 'Rental'}</p><p className="text-xs text-muted">{r.vehicle_desc ?? '—'}{r.confirmation_number ? ` · #${r.confirmation_number}` : ''}</p></div>
                <Badge tone={TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
              </div>
              <div className="mt-2 space-y-1 text-xs text-muted">
                {r.pickup_at && <p><MapPin className="mr-1 inline h-3 w-3" />Pick up {fmtDate(r.pickup_at)}{r.pickup_location ? ` · ${r.pickup_location}` : ''}</p>}
                {r.return_at && <p><MapPin className="mr-1 inline h-3 w-3" />Return {fmtDate(r.return_at)}{r.dropoff_location ? ` · ${r.dropoff_location}` : ''}</p>}
                {r.total_cost != null && <p>Total ${Number(r.total_cost).toLocaleString()}</p>}
              </div>
              <div className="mt-3 flex items-center gap-3 border-t border-border/50 pt-2 text-xs">
                <button onClick={() => { setEditing(r); setOpen(true); }} className="inline-flex items-center gap-1 text-muted hover:text-fg"><Pencil className="h-3.5 w-3.5" /> Edit</button>
                <button onClick={() => start(async () => { await deleteRentalAction(r.id); })} className="inline-flex items-center gap-1 text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? 'Edit rental' : 'Add rental'}>
        <form action={(fd) => start(async () => { await saveRentalAction(fd); setOpen(false); })} className="space-y-3">
          {editing && <input type="hidden" name="id" value={editing.id} />}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Company"><Input name="company" defaultValue={editing?.company ?? ''} placeholder="Enterprise" /></Field>
            <Field label="Confirmation #"><Input name="confirmation_number" defaultValue={editing?.confirmation_number ?? ''} /></Field>
          </div>
          <Field label="Vehicle"><Input name="vehicle_desc" defaultValue={editing?.vehicle_desc ?? ''} placeholder="Midsize SUV" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Pickup"><Input type="datetime-local" name="pickup_at" defaultValue={toLocal(editing?.pickup_at ?? null)} /></Field>
            <Field label="Return"><Input type="datetime-local" name="return_at" defaultValue={toLocal(editing?.return_at ?? null)} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Pickup location"><Input name="pickup_location" defaultValue={editing?.pickup_location ?? ''} /></Field>
            <Field label="Dropoff location"><Input name="dropoff_location" defaultValue={editing?.dropoff_location ?? ''} /></Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Daily rate"><Input type="number" name="daily_rate" defaultValue={editing?.daily_rate ?? ''} /></Field>
            <Field label="Total cost"><Input type="number" name="total_cost" defaultValue={editing?.total_cost ?? ''} /></Field>
            <Field label="Status"><Select name="status" defaultValue={editing?.status ?? 'upcoming'}>{RENTAL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>
          </div>
          <Field label="Coverage"><Input name="coverage" defaultValue={editing?.coverage ?? ''} placeholder="CDW / LDW included" /></Field>
          <Field label="Notes"><Textarea name="notes" rows={2} defaultValue={editing?.notes ?? ''} /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" loading={pending}>Save</Button></div>
        </form>
      </Modal>
    </div>
  );
}
