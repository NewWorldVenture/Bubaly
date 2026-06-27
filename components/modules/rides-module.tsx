'use client';

import { useMemo, useState } from 'react';
import {
  Car, Plus, Pencil, Trash2, MapPin, Clock, AlertTriangle, Users,
  CheckCircle2, UserX,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { cn } from '@/lib/utils/cn';
import {
  groupByDate, driverConflicts, upcomingRides, needsDriverCount, shortTime,
  RIDE_STATUS_LABELS, type RideLike,
} from '@/lib/rides/schedule';
import type { Tables, RideStatus } from '@/lib/database.types';

type Ride = Tables<'rides'>;

const STATUS_STYLES: Record<RideStatus, string> = {
  planned: 'text-slate-300 bg-slate-500/10 border-slate-500/30',
  confirmed: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  completed: 'text-blue-300 bg-blue-500/10 border-blue-500/30',
  cancelled: 'text-rose-300 bg-rose-500/10 border-rose-500/30 line-through',
};

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const blankRide = {
  id: '', title: '', ride_date: todayKey(), pickup_time: '', dropoff_time: '',
  pickup_location: '', dropoff_location: '', driver_id: '', rider_ids: [] as string[],
  status: 'planned' as RideStatus, notes: '',
};

export function RidesModule() {
  const { familyId, userId, members, role } = useApp();
  const { success, error: toastError } = useToast();
  const canEdit = isManager(role);

  const [showPast, setShowPast] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(blankRide);
  const [saving, setSaving] = useState(false);

  const { data: rides, loading, error } = useRealtimeQuery<Ride>({
    table: 'rides', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('rides').select('*').eq('family_id', familyId).order('ride_date').order('pickup_time', { nullsFirst: false }),
  });

  const memberName = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? null;

  const rideLikes = useMemo<RideLike[]>(() =>
    (rides ?? []).map((r) => ({
      id: r.id, title: r.title, ride_date: r.ride_date, pickup_time: r.pickup_time,
      driver_id: r.driver_id, rider_ids: r.rider_ids, status: r.status,
    })), [rides]);

  const conflicts = useMemo(() => driverConflicts(rideLikes), [rideLikes]);
  const tk = todayKey();
  const upcoming = useMemo(() => upcomingRides(rides ?? [], tk), [rides, tk]);
  const needsDriver = needsDriverCount(rideLikes);

  const grouped = useMemo(
    () => groupByDate((showPast ? (rides ?? []) : upcoming) as RideLike[]),
    [showPast, rides, upcoming],
  );
  const rideById = useMemo(() => new Map((rides ?? []).map((r) => [r.id, r])), [rides]);

  function openNew() { setForm({ ...blankRide, ride_date: tk }); setModalOpen(true); }
  function openEdit(r: Ride) {
    setForm({
      id: r.id, title: r.title, ride_date: r.ride_date,
      pickup_time: r.pickup_time ? shortTime(r.pickup_time) : '',
      dropoff_time: r.dropoff_time ? shortTime(r.dropoff_time) : '',
      pickup_location: r.pickup_location ?? '', dropoff_location: r.dropoff_location ?? '',
      driver_id: r.driver_id ?? '', rider_ids: r.rider_ids ?? [], status: r.status, notes: r.notes ?? '',
    });
    setModalOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) { toastError('Title is required'); return; }
    setSaving(true);
    const sb = createClient();
    const fields = {
      title: form.title.trim(),
      ride_date: form.ride_date,
      pickup_time: form.pickup_time || null,
      dropoff_time: form.dropoff_time || null,
      pickup_location: form.pickup_location.trim() || null,
      dropoff_location: form.dropoff_location.trim() || null,
      driver_id: form.driver_id || null,
      rider_ids: form.rider_ids,
      status: form.status,
      notes: form.notes.trim() || null,
    };
    const { error: err } = form.id
      ? await sb.from('rides').update(fields).eq('id', form.id)
      : await sb.from('rides').insert({ ...fields, family_id: familyId, created_by: userId });
    setSaving(false);
    if (err) { toastError(describeDbError(err)); return; }
    success(form.id ? 'Ride updated' : 'Ride added');
    setModalOpen(false);
  }

  async function remove(r: Ride) {
    if (!confirm(`Delete the ride "${r.title}"?`)) return;
    const sb = createClient();
    const { error: err } = await sb.from('rides').delete().eq('id', r.id);
    if (err) { toastError(describeDbError(err)); return; }
    success('Ride deleted');
  }

  async function setStatus(r: Ride, status: RideStatus) {
    const sb = createClient();
    const { error: err } = await sb.from('rides').update({ status }).eq('id', r.id);
    if (err) toastError(describeDbError(err));
  }

  function toggleRider(id: string) {
    setForm((f) => ({ ...f, rider_ids: f.rider_ids.includes(id) ? f.rider_ids.filter((x) => x !== id) : [...f.rider_ids, id] }));
  }

  const fmtDay = (key: string) =>
    new Date(`${key}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  if (loading) return <SkeletonList count={5} />;
  if (error) return <ErrorState message={typeof error === 'string' ? error : 'Failed to load rides'} />;

  return (
    <div>
      <PageHeader
        title="Rides & Carpool"
        description="Coordinate who's driving whom, when, and where — with conflict detection."
        action={
          <div className="flex items-center gap-2">
            <AiInsight kind="rides" iconOnly />
            {canEdit && <Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> Add ride</Button>}
          </div>
        }
      />

      {/* Alerts */}
      {(conflicts.size > 0 || needsDriver > 0) && (
        <div className="flex flex-wrap gap-3 mb-5">
          {conflicts.size > 0 && (
            <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-300">
              <AlertTriangle className="h-4 w-4" /> {conflicts.size} ride{conflicts.size > 1 ? 's have' : ' has'} a driver double-booked
            </div>
          )}
          {needsDriver > 0 && (
            <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-sm text-rose-300">
              <UserX className="h-4 w-4" /> {needsDriver} ride{needsDriver > 1 ? 's need' : ' needs'} a driver
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-1.5 mb-4">
        <button onClick={() => setShowPast(false)}
          className={cn('px-3 py-1.5 rounded-lg text-sm font-medium transition', !showPast ? 'bg-brand text-white' : 'bg-surface/50 text-muted hover:text-fg border border-border')}>
          Upcoming
        </button>
        <button onClick={() => setShowPast(true)}
          className={cn('px-3 py-1.5 rounded-lg text-sm font-medium transition', showPast ? 'bg-brand text-white' : 'bg-surface/50 text-muted hover:text-fg border border-border')}>
          All rides
        </button>
      </div>

      {grouped.length === 0 ? (
        <EmptyState icon={Car} title={showPast ? 'No rides yet' : 'No upcoming rides'}
          description={canEdit ? 'Add a ride to coordinate pickups, drop-offs, and drivers across the family.' : 'No rides are scheduled.'}
          action={canEdit && <Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> Add ride</Button>} />
      ) : (
        <div className="space-y-6">
          {grouped.map(([date, dayRides]) => (
            <div key={date}>
              <h2 className="text-sm font-semibold text-fg mb-2.5">{fmtDay(date)}</h2>
              <div className="space-y-2.5">
                {dayRides.map((rl) => {
                  const r = rideById.get(rl.id)!;
                  const conflicted = conflicts.has(r.id);
                  return (
                    <div key={r.id} className={cn('rounded-2xl border p-4', conflicted ? 'border-amber-500/40 bg-amber-500/[0.03]' : 'border-border bg-surface/50')}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 min-w-0">
                          <div className="mt-0.5 inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand/10 text-brand flex-shrink-0">
                            <Car className="h-5 w-5" />
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold text-fg flex items-center gap-2 flex-wrap">
                              {r.title}
                              <span className={cn('text-[10px] uppercase tracking-wide rounded border px-1.5 py-0.5', STATUS_STYLES[r.status])}>
                                {RIDE_STATUS_LABELS[r.status]}
                              </span>
                              {conflicted && <span className="text-[10px] uppercase tracking-wide rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 px-1.5 py-0.5">Conflict</span>}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                              {r.pickup_time && <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" />{shortTime(r.pickup_time)}{r.dropoff_time ? `–${shortTime(r.dropoff_time)}` : ''}</span>}
                              {r.pickup_location && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{r.pickup_location}{r.dropoff_location ? ` → ${r.dropoff_location}` : ''}</span>}
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-3">
                              <span className="inline-flex items-center gap-1.5 text-xs">
                                <span className="text-muted">Driver:</span>
                                {r.driver_id ? (
                                  <span className="inline-flex items-center gap-1 text-fg"><Avatar name={memberName(r.driver_id) ?? '?'} size={16} />{memberName(r.driver_id)}</span>
                                ) : <span className="text-rose-400">Unassigned</span>}
                              </span>
                              {r.rider_ids.length > 0 && (
                                <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                                  <Users className="h-3.5 w-3.5" />
                                  {r.rider_ids.map((id) => memberName(id)).filter(Boolean).join(', ')}
                                </span>
                              )}
                            </div>
                            {r.notes && <p className="mt-2 text-sm text-fg/80">{r.notes}</p>}
                          </div>
                        </div>
                        {canEdit && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {r.status !== 'completed' && r.status !== 'cancelled' && (
                              <button onClick={() => setStatus(r, 'completed')} aria-label="Mark completed" className="p-1.5 rounded-lg text-muted hover:text-emerald-400 hover:bg-elevated"><CheckCircle2 className="h-4 w-4" /></button>
                            )}
                            <button onClick={() => openEdit(r)} aria-label="Edit" className="p-1.5 rounded-lg text-muted hover:text-fg hover:bg-elevated"><Pencil className="h-4 w-4" /></button>
                            <button onClick={() => remove(r)} aria-label="Delete" className="p-1.5 rounded-lg text-muted hover:text-rose-400 hover:bg-elevated"><Trash2 className="h-4 w-4" /></button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Ride modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={form.id ? 'Edit ride' : 'Add ride'}>
        <form onSubmit={save} className="space-y-4">
          <Field label="What's the ride for?" required>
            {(id) => <Input id={id} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Soccer practice drop-off" autoFocus />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date" required>
              {(id) => <Input id={id} type="date" value={form.ride_date} onChange={(e) => setForm((f) => ({ ...f, ride_date: e.target.value }))} />}
            </Field>
            <Field label="Status">
              {(id) => (
                <Select id={id} value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as RideStatus }))}>
                  {(Object.keys(RIDE_STATUS_LABELS) as RideStatus[]).map((s) => <option key={s} value={s}>{RIDE_STATUS_LABELS[s]}</option>)}
                </Select>
              )}
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Pickup time">
              {(id) => <Input id={id} type="time" value={form.pickup_time} onChange={(e) => setForm((f) => ({ ...f, pickup_time: e.target.value }))} />}
            </Field>
            <Field label="Drop-off time">
              {(id) => <Input id={id} type="time" value={form.dropoff_time} onChange={(e) => setForm((f) => ({ ...f, dropoff_time: e.target.value }))} />}
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Pickup location">
              {(id) => <Input id={id} value={form.pickup_location} onChange={(e) => setForm((f) => ({ ...f, pickup_location: e.target.value }))} placeholder="Home" />}
            </Field>
            <Field label="Drop-off location">
              {(id) => <Input id={id} value={form.dropoff_location} onChange={(e) => setForm((f) => ({ ...f, dropoff_location: e.target.value }))} placeholder="Field #3" />}
            </Field>
          </div>
          <Field label="Driver">
            {(id) => (
              <Select id={id} value={form.driver_id} onChange={(e) => setForm((f) => ({ ...f, driver_id: e.target.value }))}>
                <option value="">Needs a driver</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
              </Select>
            )}
          </Field>
          <div>
            <span className="block text-sm font-medium text-fg mb-1.5">Riders</span>
            <div className="flex flex-wrap gap-1.5">
              {members.map((m) => (
                <button key={m.id} type="button" onClick={() => toggleRider(m.id)}
                  className={cn('inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition',
                    form.rider_ids.includes(m.id) ? 'bg-brand text-white border-brand' : 'bg-surface/50 text-muted border-border hover:text-fg')}>
                  <Avatar name={m.display_name} size={16} />{m.display_name}
                </button>
              ))}
            </div>
          </div>
          <Field label="Notes">
            {(id) => <Textarea id={id} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Car seat needed, bring cleats…" />}
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : form.id ? 'Save changes' : 'Add ride'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
