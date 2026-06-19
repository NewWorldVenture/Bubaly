'use client';

import { useState } from 'react';
import { HeartPulse, Plus, Trash2, Pill, Calendar } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { LoadingBlock, EmptyState, ErrorState } from '@/components/ui/states';
import { fmtDateTime } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';

type Medication = Tables<'medications'>;
type Appointment = Tables<'appointments'>;

export function HealthModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const [openMed, setOpenMed] = useState(false);
  const [openAppt, setOpenAppt] = useState(false);

  const { data: meds, loading: medsLoading, error: medsError, refresh: refreshMeds } = useRealtimeQuery<Medication>({
    table: 'medications',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('medications').select('*').eq('family_id', familyId).eq('is_active', true).order('name'),
  });

  const { data: appts, loading: apptsLoading, error: apptsError, refresh: refreshAppts } = useRealtimeQuery<Appointment>({
    table: 'appointments',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('appointments').select('*').eq('family_id', familyId)
        .gte('starts_at', new Date().toISOString()).order('starts_at'),
  });

  const memberById = new Map(members.map((m) => [m.id, m]));

  async function removeMed(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('medications').update({ is_active: false }).eq('id', id);
    if (error) return toastError(error.message);
    success('Medication archived');
    void refreshMeds();
  }

  async function removeAppt(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('appointments').delete().eq('id', id);
    if (error) return toastError(error.message);
    success('Appointment removed');
    void refreshAppts();
  }

  if (medsLoading || apptsLoading) return <LoadingBlock />;
  if (medsError) return <ErrorState message={medsError} onRetry={refreshMeds} />;
  if (apptsError) return <ErrorState message={apptsError} onRetry={refreshAppts} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Health"
        description="Medications, appointments, and health records for the whole family."
        action={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpenMed(true)}><Pill className="h-4 w-4" /> Add medication</Button>
            <Button onClick={() => setOpenAppt(true)}><Plus className="h-4 w-4" /> Add appointment</Button>
          </div>
        }
      />

      {/* Upcoming Appointments */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Calendar className="h-4 w-4 text-brand" /> Upcoming appointments
          </h2>
          <Badge tone="neutral">{appts.length}</Badge>
        </div>
        {appts.length === 0 ? (
          <EmptyState icon={Calendar} title="No upcoming appointments" description="Add doctor visits, dental checkups, and more." />
        ) : (
          <ul className="space-y-2">
            {appts.map((a) => {
              const m = a.member_id ? memberById.get(a.member_id) : null;
              return (
                <li key={a.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
                  {m && <Avatar name={m.display_name} color={m.color} size={32} />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{a.title}</p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      <span>{fmtDateTime(a.starts_at)}</span>
                      {a.provider && <span>· {a.provider}</span>}
                      {a.location && <span>· {a.location}</span>}
                    </div>
                  </div>
                  <button onClick={() => removeAppt(a.id)} className="rounded-lg p-2 text-muted hover:text-danger" aria-label="Delete">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Medications */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Pill className="h-4 w-4 text-accent" /> Active medications
          </h2>
          <Badge tone="neutral">{meds.length}</Badge>
        </div>
        {meds.length === 0 ? (
          <EmptyState icon={Pill} title="No medications tracked" description="Add medications to track dosage and schedules." />
        ) : (
          <ul className="space-y-2">
            {meds.map((m) => {
              const member = m.member_id ? memberById.get(m.member_id) : null;
              return (
                <li key={m.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10">
                    <Pill className="h-4 w-4 text-accent" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{m.name}</p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      {m.dosage && <span>{m.dosage}</span>}
                      {member && (
                        <span className="flex items-center gap-1">
                          <Avatar name={member.display_name} color={member.color} size={14} />
                          {member.display_name.split(' ')[0]}
                        </span>
                      )}
                    </div>
                  </div>
                  <button onClick={() => removeMed(m.id)} className="rounded-lg p-2 text-muted hover:text-danger" aria-label="Archive">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {openMed && (
        <NewMedicationModal familyId={familyId} userId={userId} members={members}
          onClose={() => setOpenMed(false)} onCreated={() => { setOpenMed(false); void refreshMeds(); }} />
      )}
      {openAppt && (
        <NewAppointmentModal familyId={familyId} userId={userId} members={members}
          onClose={() => setOpenAppt(false)} onCreated={() => { setOpenAppt(false); void refreshAppts(); }} />
      )}
    </div>
  );
}

function NewMedicationModal({ familyId, userId, members, onClose, onCreated }: {
  familyId: string; userId: string; members: Tables<'family_members'>[];
  onClose: () => void; onCreated: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    if (!name) return toastError('Name is required');
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.from('medications').insert({
      family_id: familyId, created_by: userId, name,
      dosage: String(form.get('dosage') ?? '').trim() || null,
      instructions: String(form.get('instructions') ?? '').trim() || null,
      member_id: String(form.get('member_id') ?? '') || null,
      is_active: true,
    });
    setLoading(false);
    if (error) return toastError(error.message);
    success('Medication added');
    onCreated();
  }

  return (
    <Modal open onClose={onClose} title="Add medication">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Medication name" required>
          {(id) => <Input id={id} name="name" placeholder="Amoxicillin" autoFocus />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Dosage">{(id) => <Input id={id} name="dosage" placeholder="250mg twice daily" />}</Field>
          <Field label="For">
            {(id) => (
              <Select id={id} name="member_id" defaultValue="">
                <option value="">Whole family</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Instructions">{(id) => <Textarea id={id} name="instructions" placeholder="Take with food…" />}</Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Add</Button>
        </div>
      </form>
    </Modal>
  );
}

function NewAppointmentModal({ familyId, userId, members, onClose, onCreated }: {
  familyId: string; userId: string; members: Tables<'family_members'>[];
  onClose: () => void; onCreated: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    if (!title) return toastError('Title is required');
    if (!form.get('starts_at')) return toastError('Date is required');
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.from('appointments').insert({
      family_id: familyId, created_by: userId, title,
      provider: String(form.get('provider') ?? '').trim() || null,
      location: String(form.get('location') ?? '').trim() || null,
      starts_at: new Date(String(form.get('starts_at'))).toISOString(),
      ends_at: form.get('ends_at') ? new Date(String(form.get('ends_at'))).toISOString() : null,
      notes: String(form.get('notes') ?? '').trim() || null,
      member_id: String(form.get('member_id') ?? '') || null,
    });
    setLoading(false);
    if (error) return toastError(error.message);
    success('Appointment added');
    onCreated();
  }

  return (
    <Modal open onClose={onClose} title="Add appointment">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Appointment" required>
          {(id) => <Input id={id} name="title" placeholder="Annual checkup" autoFocus />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Doctor / Provider">{(id) => <Input id={id} name="provider" placeholder="Dr. Smith" />}</Field>
          <Field label="Location">{(id) => <Input id={id} name="location" placeholder="City Medical" />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date & time" required>{(id) => <Input id={id} name="starts_at" type="datetime-local" required />}</Field>
          <Field label="End time">{(id) => <Input id={id} name="ends_at" type="datetime-local" />}</Field>
        </div>
        <Field label="For">
          {(id) => (
            <Select id={id} name="member_id" defaultValue="">
              <option value="">Whole family</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" placeholder="Any prep or notes…" />}</Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Add appointment</Button>
        </div>
      </form>
    </Modal>
  );
}
