'use client';

import { useMemo, useState } from 'react';
import {
  PawPrint, Plus, Trash2, Stethoscope, Syringe, Pill, Scissors, Scale,
  CalendarClock, AlertTriangle, Sparkles, X, ChevronRight, Phone,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { SkeletonList, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import {
  PET_SPECIES, CARE_KINDS, speciesMeta, careKindMeta,
  petAgeLabel, careUrgency, upcomingCare, careSummary, recommendedCare,
  type CareUrgency,
} from '@/lib/pets/care';

type Pet = Tables<'pets'>;
type CareRecord = Tables<'pet_care_records'>;

const CARE_ICON: Record<string, typeof Pill> = {
  vaccination: Syringe, vet_visit: Stethoscope, medication: Pill,
  grooming: Scissors, weight: Scale, other: PawPrint,
};

const URGENCY_STYLE: Record<CareUrgency, string> = {
  overdue: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  due_soon: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  upcoming: 'border-border bg-surface/50 text-muted',
  ok: 'border-border bg-surface/50 text-muted',
};

function fmtDate(d: string): string {
  return new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function PetsModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const pets = useRealtimeQuery<Pet>({
    table: 'pets', familyId,
    fetcher: (s) => s.from('pets').select('*').eq('family_id', familyId).eq('is_active', true).order('created_at'),
    deps: [familyId],
  });
  const records = useRealtimeQuery<CareRecord>({
    table: 'pet_care_records', familyId,
    fetcher: (s) => s.from('pet_care_records').select('*').eq('family_id', familyId).order('record_date', { ascending: false }),
    deps: [familyId],
  });

  const [addPetOpen, setAddPetOpen] = useState(false);
  const [selected, setSelected] = useState<Pet | null>(null);
  const [careForPet, setCareForPet] = useState<Pet | null>(null);

  const summary = useMemo(
    () => careSummary(pets.data.length, records.data, new Date()),
    [pets.data.length, records.data],
  );
  const upcoming = useMemo(() => upcomingCare(records.data).slice(0, 6), [records.data]);

  // The AI care engine: deterministic recommendations across all pets.
  const recommendations = useMemo(
    () => pets.data.flatMap((p) => recommendedCare({ id: p.id, species: p.species }, records.data)),
    [pets.data, records.data],
  );

  async function removePet(id: string) {
    if (!confirm('Remove this pet and all its care records?')) return;
    const { error } = await createClient().from('pets').update({ is_active: false }).eq('id', id);
    if (error) return toastError(describeDbError(error));
    setSelected(null);
    success('Pet removed');
  }

  const petById = (id: string) => pets.data.find((p) => p.id === id);

  if (pets.loading) return <SkeletonList />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pets"
        description="Profiles and complete care operations for every family pet."
        action={<div className="flex items-center gap-2"><AiInsight kind="pets" iconOnly /><Button onClick={() => setAddPetOpen(true)}><Plus className="h-4 w-4" /> Add pet</Button></div>}
      />

      {/* Care summary + AI recommendations */}
      {pets.data.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <CalendarClock className="h-4 w-4 text-brand" /> Care status
            </div>
            <p className={cn('mt-2 text-2xl font-bold', summary.overdue > 0 ? 'text-rose-300' : summary.dueSoon > 0 ? 'text-amber-300' : 'text-emerald-300')}>
              {summary.text}
            </p>
            <p className="mt-1 text-xs text-muted">{pets.data.length} pet{pets.data.length === 1 ? '' : 's'} in your household</p>
          </div>

          <div className="rounded-2xl border border-brand/20 bg-brand/5 p-5 lg:col-span-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-brand">
              <Sparkles className="h-4 w-4" /> Care needs
            </div>
            {recommendations.length === 0 ? (
              <p className="mt-2 text-sm text-muted">Everything looks on track. New recommendations appear here as due dates approach.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {recommendations.slice(0, 5).map((r, i) => {
                  const pet = petById(r.petId);
                  const Icon = CARE_ICON[r.kind] ?? PawPrint;
                  return (
                    <li key={i} className={cn('flex items-center gap-3 rounded-xl border px-3 py-2', URGENCY_STYLE[r.urgency])}>
                      <Icon className="h-4 w-4 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-fg">{pet?.name}: {r.title}</p>
                        <p className="text-xs opacity-90">{r.reason}</p>
                      </div>
                      {r.urgency === 'overdue' && <AlertTriangle className="h-4 w-4 shrink-0" />}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Pet grid */}
      {pets.data.length === 0 ? (
        <EmptyState icon={PawPrint} title="No pets yet" description="Add your first pet to track vaccinations, vet visits, medications, and grooming." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {pets.data.map((pet) => {
            const meta = speciesMeta(pet.species);
            const age = petAgeLabel(pet.birthday);
            const petRecords = records.data.filter((r) => r.pet_id === pet.id);
            const nextDue = upcomingCare(petRecords)[0];
            return (
              <button
                key={pet.id}
                onClick={() => setSelected(pet)}
                className="flex items-center gap-4 rounded-2xl border border-border bg-surface/40 p-4 text-left transition hover:bg-elevated"
              >
                <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-brand/10 text-3xl">{meta.emoji}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{pet.name}</p>
                  <p className="truncate text-xs text-muted">
                    {meta.label}{pet.breed ? ` · ${pet.breed}` : ''}{age ? ` · ${age}` : ''}
                  </p>
                  {nextDue && (
                    <span className={cn('mt-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]', URGENCY_STYLE[nextDue.urgency])}>
                      {careKindMeta(nextDue.kind).emoji} {nextDue.urgency === 'overdue' ? 'Overdue' : `Due ${fmtDate(nextDue.nextDue)}`}
                    </span>
                  )}
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
              </button>
            );
          })}
        </div>
      )}

      {/* Upcoming care timeline */}
      {upcoming.length > 0 && (
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <CalendarClock className="h-4 w-4 text-brand" /> Upcoming care
          </div>
          <ul className="space-y-2">
            {upcoming.map((u) => {
              const pet = petById(u.petId);
              const Icon = CARE_ICON[u.kind] ?? PawPrint;
              return (
                <li key={u.id} className="flex items-center gap-3 rounded-xl border border-border px-3 py-2">
                  <Icon className="h-4 w-4 shrink-0 text-brand" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{pet?.name}: {u.title}</p>
                  </div>
                  <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-xs', URGENCY_STYLE[u.urgency])}>
                    {u.urgency === 'overdue' ? `${Math.abs(u.daysUntil)}d overdue` : fmtDate(u.nextDue)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {addPetOpen && (
        <PetForm familyId={familyId} userId={userId} onClose={() => setAddPetOpen(false)} onSaved={() => { setAddPetOpen(false); success('Pet added'); }} />
      )}

      {selected && (
        <PetDetail
          pet={selected}
          records={records.data.filter((r) => r.pet_id === selected.id)}
          onClose={() => setSelected(null)}
          onAddCare={() => { setCareForPet(selected); setSelected(null); }}
          onRemove={() => removePet(selected.id)}
        />
      )}

      {careForPet && (
        <CareForm
          familyId={familyId} userId={userId} pet={careForPet}
          onClose={() => setCareForPet(null)}
          onSaved={() => { setCareForPet(null); success('Care record added'); }}
        />
      )}
    </div>
  );
}

function PetForm({ familyId, userId, onClose, onSaved }: { familyId: string; userId: string; onClose: () => void; onSaved: () => void }) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name') ?? '').trim();
    if (!name) return toastError('Name is required');
    setLoading(true);
    const { error } = await createClient().from('pets').insert({
      family_id: familyId,
      name,
      species: String(f.get('species') ?? 'dog') as Pet['species'],
      breed: String(f.get('breed') ?? '').trim() || null,
      birthday: String(f.get('birthday') ?? '') || null,
      weight_kg: f.get('weight_kg') ? Number(f.get('weight_kg')) : null,
      color: String(f.get('color') ?? '').trim() || null,
      microchip_id: String(f.get('microchip_id') ?? '').trim() || null,
      vet_name: String(f.get('vet_name') ?? '').trim() || null,
      vet_phone: String(f.get('vet_phone') ?? '').trim() || null,
      notes: String(f.get('notes') ?? '').trim() || null,
      created_by: userId,
    });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title="Add a pet" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required>{(id) => <Input id={id} name="name" autoFocus placeholder="Buddy" />}</Field>
          <Field label="Species">{(id) => <Select id={id} name="species" defaultValue="dog">{PET_SPECIES.map((s) => <option key={s.value} value={s.value}>{s.emoji} {s.label}</option>)}</Select>}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Breed">{(id) => <Input id={id} name="breed" placeholder="Labrador" />}</Field>
          <Field label="Birthday">{(id) => <Input id={id} name="birthday" type="date" />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Weight (kg)">{(id) => <Input id={id} name="weight_kg" type="number" step="0.1" min="0" placeholder="12.5" />}</Field>
          <Field label="Color">{(id) => <Input id={id} name="color" placeholder="Golden" />}</Field>
        </div>
        <Field label="Microchip ID">{(id) => <Input id={id} name="microchip_id" placeholder="Optional" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vet name">{(id) => <Input id={id} name="vet_name" placeholder="Dr. Smith" />}</Field>
          <Field label="Vet phone">{(id) => <Input id={id} name="vet_phone" type="tel" placeholder="(555) 000-0000" />}</Field>
        </div>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" placeholder="Allergies, behavior, diet…" />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Add pet</Button>
        </div>
      </form>
    </Modal>
  );
}

function CareForm({ familyId, userId, pet, onClose, onSaved }: { familyId: string; userId: string; pet: Pet; onClose: () => void; onSaved: () => void }) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const title = String(f.get('title') ?? '').trim();
    if (!title) return toastError('Title is required');
    setLoading(true);
    const { error } = await createClient().from('pet_care_records').insert({
      family_id: familyId,
      pet_id: pet.id,
      kind: String(f.get('kind') ?? 'vet_visit') as CareRecord['kind'],
      title,
      record_date: String(f.get('record_date') ?? '') || new Date().toISOString().slice(0, 10),
      next_due: String(f.get('next_due') ?? '') || null,
      dose: String(f.get('dose') ?? '').trim() || null,
      weight_kg: f.get('weight_kg') ? Number(f.get('weight_kg')) : null,
      notes: String(f.get('notes') ?? '').trim() || null,
      created_by: userId,
    });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title={`Add care · ${pet.name}`} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">{(id) => <Select id={id} name="kind" defaultValue="vet_visit">{CARE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.emoji} {k.label}</option>)}</Select>}</Field>
          <Field label="Date">{(id) => <Input id={id} name="record_date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} />}</Field>
        </div>
        <Field label="Title" required>{(id) => <Input id={id} name="title" autoFocus placeholder="Rabies booster" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Next due" hint="Powers care reminders">{(id) => <Input id={id} name="next_due" type="date" />}</Field>
          <Field label="Dose / amount">{(id) => <Input id={id} name="dose" placeholder="1 tablet" />}</Field>
        </div>
        <Field label="Weight (kg)" hint="Optional — for weight check-ins">{(id) => <Input id={id} name="weight_kg" type="number" step="0.1" min="0" />}</Field>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" placeholder="Vet remarks, reactions…" />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Save record</Button>
        </div>
      </form>
    </Modal>
  );
}

function PetDetail({ pet, records, onClose, onAddCare, onRemove }: {
  pet: Pet; records: CareRecord[]; onClose: () => void; onAddCare: () => void; onRemove: () => void;
}) {
  const meta = speciesMeta(pet.species);
  const age = petAgeLabel(pet.birthday);
  const sorted = [...records].sort((a, b) => (a.record_date < b.record_date ? 1 : -1));

  async function deleteRecord(id: string) {
    await createClient().from('pet_care_records').delete().eq('id', id);
  }

  return (
    <Modal open title={pet.name} onClose={onClose}>
      <div className="space-y-5">
        <div className="flex items-center gap-4">
          <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-brand/10 text-4xl">{meta.emoji}</span>
          <div className="min-w-0">
            <p className="text-sm text-muted">{meta.label}{pet.breed ? ` · ${pet.breed}` : ''}</p>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
              {age && <span>{age} old</span>}
              {pet.color && <span>{pet.color}</span>}
              {pet.weight_kg && <span>{pet.weight_kg} kg</span>}
              {pet.microchip_id && <span>Chip {pet.microchip_id}</span>}
            </div>
          </div>
        </div>

        {(pet.vet_name || pet.vet_phone) && (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm">
            <Stethoscope className="h-4 w-4 text-brand" />
            <span>{pet.vet_name || 'Veterinarian'}</span>
            {pet.vet_phone && <a href={`tel:${pet.vet_phone}`} className="ml-auto inline-flex items-center gap-1 text-brand"><Phone className="h-3.5 w-3.5" /> {pet.vet_phone}</a>}
          </div>
        )}

        {pet.notes && <p className="rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm text-muted">{pet.notes}</p>}

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Care history</h3>
            <Button size="sm" variant="secondary" onClick={onAddCare}><Plus className="h-3.5 w-3.5" /> Add care</Button>
          </div>
          {sorted.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border py-6 text-center text-sm text-muted">No care records yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {sorted.map((r) => {
                const Icon = CARE_ICON[r.kind] ?? PawPrint;
                const u = careUrgency(r.next_due);
                return (
                  <li key={r.id} className="group flex items-center gap-3 rounded-xl border border-border px-3 py-2">
                    <Icon className="h-4 w-4 shrink-0 text-brand" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{r.title}</p>
                      <p className="text-xs text-muted">
                        {fmtDate(r.record_date)}{r.dose ? ` · ${r.dose}` : ''}
                        {r.next_due && <span className={cn('ml-1', u === 'overdue' ? 'text-rose-300' : u === 'due_soon' ? 'text-amber-300' : '')}>· next {fmtDate(r.next_due)}</span>}
                      </p>
                    </div>
                    <button onClick={() => deleteRecord(r.id)} aria-label="Delete record" className="shrink-0 p-1 text-muted/50 opacity-0 transition hover:text-rose-400 group-hover:opacity-100">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex justify-between border-t border-border pt-3">
          <Button variant="ghost" onClick={onRemove} className="text-rose-400 hover:text-rose-300"><Trash2 className="h-4 w-4" /> Remove pet</Button>
          <Button variant="ghost" onClick={onClose}><X className="h-4 w-4" /> Close</Button>
        </div>
      </div>
    </Modal>
  );
}
