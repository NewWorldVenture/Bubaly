'use client';

import { useMemo, useState } from 'react';
import {
  Plus, Trash2, ChevronRight, Phone, Mail, Users, MapPin,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import {
  REUNION_STATUSES, RSVP_RESPONSES, reunionStatusMeta, rsvpMeta,
  rsvpSummary, reunionSummaryResult, fmtMoney, fmtDate,
} from '@/lib/reunion/planner';

type Reunion = Tables<'family_reunions'>;
type Rsvp = Tables<'reunion_rsvps'>;

const STATUS_STYLE: Record<string, string> = {
  planning: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  confirmed: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  active: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
  completed: 'bg-gray-500/10 text-gray-400 border-gray-500/30',
  cancelled: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
};

export function ReunionModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const reunions = useRealtimeQuery<Reunion>({
    table: 'family_reunions', familyId,
    fetcher: (s) => s.from('family_reunions').select('*').eq('family_id', familyId).eq('is_active', true).order('start_date'),
    deps: [familyId],
  });

  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<Reunion | null>(null);

  const summary = useMemo(() => {
    if (!reunions.data) return null;
    return reunionSummaryResult(reunions.data);
  }, [reunions.data]);

  if (reunions.loading) return <LoadingBlock />;

  return (
    <div className="space-y-6">
      <PageHeader title="Family Reunion Planner" />

      {summary && summary.totalReunions > 0 && (
        <div className="rounded-xl border border-border bg-surface/60 p-4">
          <p className="text-sm font-medium">{summary.text}</p>
        </div>
      )}

      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="w-4 h-4 mr-1" /> Plan Reunion</Button>
      </div>

      {(!reunions.data || reunions.data.length === 0) ? (
        <EmptyState title="No reunions" description="Plan your family reunions, track RSVPs, and coordinate logistics." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {reunions.data.map((r) => {
            const meta = reunionStatusMeta(r.status);
            return (
              <button key={r.id} onClick={() => setSelected(r)}
                className="text-left rounded-xl border border-border bg-surface/60 p-4 hover:border-primary/40 transition-colors">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-semibold">{r.title}</p>
                    <p className="text-xs text-muted">{r.location || r.venue || 'Location TBD'}</p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted" />
                </div>
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <span className={cn('text-xs px-2 py-0.5 rounded-full border', STATUS_STYLE[r.status] || STATUS_STYLE.planning)}>
                    {meta.emoji} {meta.label}
                  </span>
                  {r.start_date && <span className="text-xs text-muted">{fmtDate(r.start_date)}</span>}
                  {r.headcount > 0 && (
                    <span className="text-xs text-muted flex items-center gap-0.5">
                      <Users className="w-3 h-3" /> {r.headcount}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {addOpen && (
        <AddReunionModal familyId={familyId} userId={userId}
          onClose={() => setAddOpen(false)}
          onSuccess={() => { setAddOpen(false); success('Reunion planned'); }} />
      )}
      {selected && (
        <ReunionDetailModal reunion={selected} familyId={familyId}
          onClose={() => setSelected(null)}
          onDelete={() => { setSelected(null); success('Reunion removed'); }} />
      )}
    </div>
  );
}

function AddReunionModal({ familyId, userId, onClose, onSuccess }: {
  familyId: string; userId: string; onClose: () => void; onSuccess: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const f = new FormData(e.currentTarget);
    const { error } = await createClient().from('family_reunions').insert({
      family_id: familyId,
      created_by: userId,
      title: String(f.get('title') ?? ''),
      description: String(f.get('description') ?? ''),
      location: String(f.get('location') ?? ''),
      venue: String(f.get('venue') ?? ''),
      status: String(f.get('status') ?? 'planning') as Reunion['status'],
      start_date: String(f.get('start_date') ?? '') || null,
      end_date: String(f.get('end_date') ?? '') || null,
      budget: f.get('budget') ? Number(f.get('budget')) : null,
      theme: String(f.get('theme') ?? ''),
      contact_name: String(f.get('contact_name') ?? ''),
      contact_phone: String(f.get('contact_phone') ?? ''),
      contact_email: String(f.get('contact_email') ?? ''),
      notes: String(f.get('notes') ?? ''),
    });
    setLoading(false);
    if (error) return toastError(error.message);
    onSuccess();
  }

  return (
    <Modal open onClose={onClose} title="Plan a Family Reunion">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Title" required>{(id) => <Input id={id} name="title" autoFocus placeholder="Annual Family Reunion 2026" />}</Field>
        <Field label="Description">{(id) => <Textarea id={id} name="description" rows={2} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Location">{(id) => <Input id={id} name="location" placeholder="Austin, TX" />}</Field>
          <Field label="Venue">{(id) => <Input id={id} name="venue" placeholder="Zilker Park" />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start Date">{(id) => <Input id={id} name="start_date" type="date" />}</Field>
          <Field label="End Date">{(id) => <Input id={id} name="end_date" type="date" />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">{(id) =>
            <Select id={id} name="status" defaultValue="planning">
              {REUNION_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.emoji} {s.label}</option>)}
            </Select>
          }</Field>
          <Field label="Budget">{(id) => <Input id={id} name="budget" type="number" step="1" min="0" />}</Field>
        </div>
        <Field label="Theme">{(id) => <Input id={id} name="theme" placeholder="BBQ, Beach, Heritage..." />}</Field>
        <Field label="Organizer Name">{(id) => <Input id={id} name="contact_name" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone">{(id) => <Input id={id} name="contact_phone" type="tel" />}</Field>
          <Field label="Email">{(id) => <Input id={id} name="contact_email" type="email" />}</Field>
        </div>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" rows={2} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

function ReunionDetailModal({ reunion, familyId, onClose, onDelete }: {
  reunion: Reunion; familyId: string; onClose: () => void; onDelete: () => void;
}) {
  const { error: toastError } = useToast();
  const meta = reunionStatusMeta(reunion.status);

  const rsvps = useRealtimeQuery<Rsvp>({
    table: 'reunion_rsvps', familyId,
    fetcher: (s) => s.from('reunion_rsvps').select('*').eq('reunion_id', reunion.id).order('guest_name'),
    deps: [reunion.id],
  });

  const rsvpStats = useMemo(() => {
    if (!rsvps.data) return null;
    return rsvpSummary(rsvps.data);
  }, [rsvps.data]);

  async function handleDelete() {
    const { error } = await createClient().from('family_reunions').update({ is_active: false }).eq('id', reunion.id);
    if (error) { toastError(error.message); return; }
    onDelete();
  }

  const rows: [string, string][] = [
    ['Status', `${meta.emoji} ${meta.label}`],
    ['Location', reunion.location || '—'],
    ['Venue', reunion.venue || '—'],
    ['Dates', `${fmtDate(reunion.start_date)}${reunion.end_date ? ` – ${fmtDate(reunion.end_date)}` : ''}`],
    ['Budget', fmtMoney(reunion.budget)],
    ['Theme', reunion.theme || '—'],
  ];

  return (
    <Modal open onClose={onClose} title={reunion.title}>
      <div className="space-y-4">
        {reunion.description && <p className="text-sm text-muted">{reunion.description}</p>}

        <div className="space-y-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between text-sm">
              <span className="text-muted">{k}</span>
              <span className="font-medium">{v}</span>
            </div>
          ))}
        </div>

        {rsvpStats && (
          <div className="rounded-lg border border-border bg-surface/40 p-3 space-y-1">
            <p className="text-xs text-muted font-semibold uppercase tracking-wide">RSVPs</p>
            <div className="flex gap-3 text-sm">
              <span className="text-emerald-400">{rsvpStats.attending} attending</span>
              <span className="text-amber-400">{rsvpStats.maybe} maybe</span>
              <span className="text-gray-400">{rsvpStats.pending} pending</span>
            </div>
            {rsvpStats.totalGuests > 0 && (
              <p className="text-xs text-muted">{rsvpStats.totalGuests} total guests</p>
            )}
          </div>
        )}

        {(reunion.contact_name || reunion.contact_phone || reunion.contact_email) && (
          <div className="rounded-lg border border-border bg-surface/40 p-3 space-y-1">
            <p className="text-xs text-muted font-semibold uppercase tracking-wide">Organizer</p>
            {reunion.contact_name && <p className="text-sm font-medium">{reunion.contact_name}</p>}
            {reunion.contact_phone && (
              <a href={`tel:${reunion.contact_phone}`} className="flex items-center gap-1 text-sm text-primary hover:underline">
                <Phone className="w-3.5 h-3.5" /> {reunion.contact_phone}
              </a>
            )}
            {reunion.contact_email && (
              <a href={`mailto:${reunion.contact_email}`} className="flex items-center gap-1 text-sm text-primary hover:underline">
                <Mail className="w-3.5 h-3.5" /> {reunion.contact_email}
              </a>
            )}
          </div>
        )}

        {reunion.notes && (
          <div className="rounded-lg border border-border bg-surface/40 p-3">
            <p className="text-xs text-muted mb-1">Notes</p>
            <p className="text-sm whitespace-pre-wrap">{reunion.notes}</p>
          </div>
        )}

        <div className="flex justify-between pt-2 border-t border-border">
          <Button variant="ghost" size="sm" className="text-rose-400" onClick={handleDelete}>
            <Trash2 className="w-4 h-4 mr-1" /> Remove
          </Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}
