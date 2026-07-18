'use client';

import { useMemo, useState } from 'react';
import {
  Plane, Plus, Pencil, Trash2, MapPin, CalendarRange, Check, Users,
  Luggage, ListChecks, Ticket, FileText, ChevronRight, ArrowLeft,
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
  tripDurationDays, daysUntil, isUpcoming, checklistProgress, progressByKind,
  TRIP_STATUS_LABELS, TRIP_ITEM_KIND_LABELS, type TripLike, type TripItemLike, type TripItemKind,
} from '@/lib/trips/planner';
import type { Tables, TripStatus } from '@/lib/database.types';

type Trip = Tables<'trips'>;
type TripItem = Tables<'trip_items'>;

const STATUS_STYLES: Record<TripStatus, string> = {
  planning: 'text-slate-300 bg-slate-500/10 border-slate-500/30',
  booked: 'text-violet-300 bg-violet-500/10 border-violet-500/30',
  active: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  completed: 'text-blue-300 bg-blue-500/10 border-blue-500/30',
  cancelled: 'text-rose-300 bg-rose-500/10 border-rose-500/30 line-through',
};
const KIND_ICON: Record<TripItemKind, typeof Luggage> = {
  packing: Luggage, todo: ListChecks, reservation: Ticket, document: FileText,
};
const KIND_ORDER: TripItemKind[] = ['packing', 'todo', 'reservation', 'document'];

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const blankTrip = {
  id: '', name: '', destination: '', start_date: '', end_date: '',
  status: 'planning' as TripStatus, traveler_ids: [] as string[], notes: '',
};

export function TripsModule() {
  const { familyId, userId, members, role } = useApp();
  const { success, error: toastError } = useToast();
  const canEdit = isManager(role);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  const [tripModal, setTripModal] = useState(false);
  const [tripForm, setTripForm] = useState(blankTrip);
  const [savingTrip, setSavingTrip] = useState(false);
  const [itemModal, setItemModal] = useState(false);
  const [itemForm, setItemForm] = useState<{ kind: TripItemKind; label: string; details: string; assignee_id: string }>({ kind: 'packing', label: '', details: '', assignee_id: '' });
  const [savingItem, setSavingItem] = useState(false);

  const { data: trips, loading, error, refresh: refreshTrips } = useRealtimeQuery<Trip>({
    table: 'trips', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('trips').select('*').eq('family_id', familyId).order('start_date', { nullsFirst: false }),
  });
  // The trip checklist is core content (packing/todo shown per trip). A genuine
  // trip_items read failure must surface + be retryable — not silently render as
  // an empty 0%-progress checklist. (Missing-table/offline are degraded to empty
  // by the hook, same as the trips read above.)
  const { data: items, error: itemsError, refresh: refreshItems } = useRealtimeQuery<TripItem>({
    table: 'trip_items', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('trip_items').select('*').eq('family_id', familyId).order('sort_order'),
  });

  const memberName = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? null;
  const tk = todayKey();

  const itemsByTrip = useMemo(() => {
    const map = new Map<string, TripItem[]>();
    for (const it of items ?? []) {
      const arr = map.get(it.trip_id) ?? [];
      arr.push(it); map.set(it.trip_id, arr);
    }
    return map;
  }, [items]);

  const visibleTrips = useMemo(() => {
    const list = trips ?? [];
    return list.filter((t) => showPast ? true : isUpcoming(t as TripLike, tk));
  }, [trips, showPast, tk]);

  const selected = useMemo(() => (trips ?? []).find((t) => t.id === selectedId) ?? null, [trips, selectedId]);
  const selectedItems = selected ? (itemsByTrip.get(selected.id) ?? []) : [];

  // ── Trip CRUD ─────────────────────────────────────────────
  function openNewTrip() { setTripForm(blankTrip); setTripModal(true); }
  function openEditTrip(t: Trip) {
    setTripForm({
      id: t.id, name: t.name, destination: t.destination ?? '', start_date: t.start_date ?? '',
      end_date: t.end_date ?? '', status: t.status, traveler_ids: t.traveler_ids ?? [], notes: t.notes ?? '',
    });
    setTripModal(true);
  }
  async function saveTrip(e: React.FormEvent) {
    e.preventDefault();
    if (!tripForm.name.trim()) { toastError('Trip name is required'); return; }
    setSavingTrip(true);
    const sb = createClient();
    const fields = {
      name: tripForm.name.trim(), destination: tripForm.destination.trim() || null,
      start_date: tripForm.start_date || null, end_date: tripForm.end_date || null,
      status: tripForm.status, traveler_ids: tripForm.traveler_ids, notes: tripForm.notes.trim() || null,
    };
    const { error: err } = tripForm.id
      ? await sb.from('trips').update(fields).eq('id', tripForm.id)
      : await sb.from('trips').insert({ ...fields, family_id: familyId, created_by: userId });
    setSavingTrip(false);
    if (err) { toastError(describeDbError(err)); return; }
    success(tripForm.id ? 'Trip updated' : 'Trip created');
    setTripModal(false);
  }
  async function removeTrip(t: Trip) {
    if (!confirm(`Delete "${t.name}" and its checklist?`)) return;
    const sb = createClient();
    const { error: err } = await sb.from('trips').delete().eq('id', t.id);
    if (err) { toastError(describeDbError(err)); return; }
    success('Trip deleted');
    if (selectedId === t.id) setSelectedId(null);
  }
  function toggleTraveler(id: string) {
    setTripForm((f) => ({ ...f, traveler_ids: f.traveler_ids.includes(id) ? f.traveler_ids.filter((x) => x !== id) : [...f.traveler_ids, id] }));
  }

  // ── Item CRUD ─────────────────────────────────────────────
  function openNewItem(kind: TripItemKind) { setItemForm({ kind, label: '', details: '', assignee_id: '' }); setItemModal(true); }
  async function saveItem(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    if (!itemForm.label.trim()) { toastError('Label is required'); return; }
    setSavingItem(true);
    const sb = createClient();
    const { error: err } = await sb.from('trip_items').insert({
      family_id: familyId, trip_id: selected.id, kind: itemForm.kind, label: itemForm.label.trim(),
      details: itemForm.details.trim() || null, assignee_id: itemForm.assignee_id || null,
      sort_order: selectedItems.length, created_by: userId,
    });
    setSavingItem(false);
    if (err) { toastError(describeDbError(err)); return; }
    success('Item added');
    setItemModal(false);
  }
  async function toggleItem(it: TripItem) {
    const sb = createClient();
    const { error: err } = await sb.from('trip_items').update({ is_done: !it.is_done }).eq('id', it.id);
    if (err) toastError(describeDbError(err));
  }
  async function removeItem(it: TripItem) {
    const sb = createClient();
    const { error: err } = await sb.from('trip_items').delete().eq('id', it.id);
    if (err) toastError(describeDbError(err));
  }

  const fmtRange = (t: Trip) => {
    if (!t.start_date) return 'Dates TBD';
    const opt: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    const s = new Date(`${t.start_date}T00:00:00`).toLocaleDateString('en-US', opt);
    if (!t.end_date) return s;
    const e = new Date(`${t.end_date}T00:00:00`).toLocaleDateString('en-US', { ...opt, year: 'numeric' });
    return `${s} – ${e}`;
  };

  if (loading) return <SkeletonList count={5} />;
  const loadError = error || itemsError;
  if (loadError) return <ErrorState message={typeof loadError === 'string' ? loadError : 'Failed to load trips'} onRetry={() => { refreshTrips(); refreshItems(); }} />;

  // ── Trip detail view ──────────────────────────────────────
  if (selected) {
    const progress = checklistProgress(selectedItems as TripItemLike[]);
    const byKind = progressByKind(selectedItems as TripItemLike[]);
    const until = daysUntil(selected as TripLike, tk);
    const duration = tripDurationDays(selected as TripLike);
    return (
      <div>
        <button onClick={() => setSelectedId(null)} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg mb-4">
          <ArrowLeft className="h-4 w-4" /> All trips
        </button>

        <div className="rounded-2xl bg-gradient-to-r from-sky-900/40 to-indigo-900/40 border border-sky-500/20 p-6 mb-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold text-fg">{selected.name}</h1>
                <span className={cn('text-[10px] uppercase tracking-wide rounded border px-1.5 py-0.5', STATUS_STYLES[selected.status])}>
                  {TRIP_STATUS_LABELS[selected.status]}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg/80">
                {selected.destination && <span className="inline-flex items-center gap-1"><MapPin className="h-4 w-4" />{selected.destination}</span>}
                <span className="inline-flex items-center gap-1"><CalendarRange className="h-4 w-4" />{fmtRange(selected)}{duration ? ` · ${duration} day${duration > 1 ? 's' : ''}` : ''}</span>
                {until != null && until > 0 && <span className="text-sky-300 font-medium">{until} day{until > 1 ? 's' : ''} to go</span>}
                {until != null && until === 0 && <span className="text-emerald-300 font-medium">Starts today!</span>}
              </div>
              {selected.traveler_ids.length > 0 && (
                <div className="mt-2 flex items-center gap-1.5">
                  <Users className="h-4 w-4 text-muted" />
                  <div className="flex flex-wrap gap-1">
                    {selected.traveler_ids.map((id) => (
                      <span key={id} className="inline-flex items-center gap-1 text-xs bg-surface/50 border border-border rounded-full px-2 py-0.5">
                        <Avatar name={memberName(id) ?? '?'} size={14} />{memberName(id)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {canEdit && (
              <div className="flex items-center gap-1 flex-shrink-0">
                <button onClick={() => openEditTrip(selected)} aria-label="Edit trip" className="p-1.5 rounded-lg text-muted hover:text-fg hover:bg-elevated"><Pencil className="h-4 w-4" /></button>
                <button onClick={() => removeTrip(selected)} aria-label="Delete trip" className="p-1.5 rounded-lg text-muted hover:text-rose-400 hover:bg-elevated"><Trash2 className="h-4 w-4" /></button>
              </div>
            )}
          </div>
          {/* Overall progress */}
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-muted mb-1">
              <span>Trip checklist</span><span>{progress.done}/{progress.total} done</span>
            </div>
            <div className="h-2 bg-elevated rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 rounded-full transition-all duration-700" style={{ width: `${progress.percent}%` }} />
            </div>
          </div>
          {selected.notes && <p className="mt-4 text-sm text-fg/80">{selected.notes}</p>}
        </div>

        {/* Checklist sections */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {KIND_ORDER.map((kind) => {
            const Icon = KIND_ICON[kind];
            const list = selectedItems.filter((i) => i.kind === kind);
            const kp = byKind[kind];
            return (
              <div key={kind} className="rounded-2xl bg-surface/50 border border-border p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-fg uppercase tracking-wider flex items-center gap-2">
                    <Icon className="h-4 w-4 text-brand-text" /> {TRIP_ITEM_KIND_LABELS[kind]}
                    {kp.total > 0 && <span className="text-xs text-muted font-normal">{kp.done}/{kp.total}</span>}
                  </h3>
                  {canEdit && (
                    <button onClick={() => openNewItem(kind)} className="text-xs font-medium text-brand-text hover:underline inline-flex items-center gap-1">
                      <Plus className="h-3.5 w-3.5" /> Add
                    </button>
                  )}
                </div>
                {list.length === 0 ? (
                  <p className="text-xs text-muted py-2">Nothing here yet.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {list.map((it) => (
                      <li key={it.id} className="flex items-start gap-2.5 group">
                        <button onClick={() => toggleItem(it)} aria-label={it.is_done ? 'Mark not done' : 'Mark done'}
                          className={cn('mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded border flex-shrink-0 transition',
                            it.is_done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-border hover:border-emerald-500/50')}>
                          {it.is_done && <Check className="h-3.5 w-3.5" />}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className={cn('text-sm', it.is_done ? 'text-muted line-through' : 'text-fg')}>{it.label}</div>
                          {it.details && <div className="text-xs text-muted">{it.details}</div>}
                          {it.assignee_id && <div className="text-[11px] text-muted mt-0.5">{memberName(it.assignee_id)}</div>}
                        </div>
                        {canEdit && (
                          <button onClick={() => removeItem(it)} aria-label="Remove" className="p-1 rounded text-muted opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 hover:text-rose-400 transition"><Trash2 className="h-3.5 w-3.5" /></button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>

        {/* Item modal */}
        <Modal open={itemModal} onClose={() => setItemModal(false)} title={`Add ${TRIP_ITEM_KIND_LABELS[itemForm.kind].toLowerCase()} item`}>
          <form onSubmit={saveItem} className="space-y-4">
            <Field label="Item" required>
              {(id) => <Input id={id} value={itemForm.label} onChange={(e) => setItemForm((f) => ({ ...f, label: e.target.value }))} placeholder="e.g. Passports, sunscreen, hotel check-in" autoFocus />}
            </Field>
            <Field label="Details">
              {(id) => <Input id={id} value={itemForm.details} onChange={(e) => setItemForm((f) => ({ ...f, details: e.target.value }))} placeholder="Confirmation #, notes…" />}
            </Field>
            <Field label="Assign to">
              {(id) => (
                <Select id={id} value={itemForm.assignee_id} onChange={(e) => setItemForm((f) => ({ ...f, assignee_id: e.target.value }))}>
                  <option value="">Anyone</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                </Select>
              )}
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setItemModal(false)}>Cancel</Button>
              <Button type="submit" disabled={savingItem}>{savingItem ? 'Saving…' : 'Add item'}</Button>
            </div>
          </form>
        </Modal>
      </div>
    );
  }

  // ── Trip list view ────────────────────────────────────────
  return (
    <div>
      <PageHeader
        title="Trip Planner"
        description="Plan family travel end to end — itinerary, packing lists, reservations, and documents."
        action={
          <div className="flex items-center gap-2">
            <AiInsight kind="trips" />
            {canEdit && <Button onClick={openNewTrip} className="gap-1.5"><Plus className="h-4 w-4" /> New trip</Button>}
          </div>
        }
      />

      <div className="flex items-center gap-1.5 mb-4">
        <button onClick={() => setShowPast(false)} className={cn('px-3 py-1.5 rounded-lg text-sm font-medium transition', !showPast ? 'bg-brand text-white' : 'bg-surface/50 text-muted hover:text-fg border border-border')}>Upcoming</button>
        <button onClick={() => setShowPast(true)} className={cn('px-3 py-1.5 rounded-lg text-sm font-medium transition', showPast ? 'bg-brand text-white' : 'bg-surface/50 text-muted hover:text-fg border border-border')}>All trips</button>
      </div>

      {visibleTrips.length === 0 ? (
        <EmptyState icon={Plane} title={showPast ? 'No trips yet' : 'No upcoming trips'}
          description={canEdit ? 'Plan your next family getaway with packing lists, reservations, and a shared checklist.' : 'No trips are planned yet.'}
          action={canEdit && <Button onClick={openNewTrip} className="gap-1.5"><Plus className="h-4 w-4" /> New trip</Button>} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleTrips.map((t) => {
            const tItems = itemsByTrip.get(t.id) ?? [];
            const prog = checklistProgress(tItems as TripItemLike[]);
            const until = daysUntil(t as TripLike, tk);
            return (
              <button key={t.id} onClick={() => setSelectedId(t.id)}
                className="text-left rounded-2xl bg-surface/50 border border-border p-5 hover:border-brand/40 transition group">
                <div className="flex items-start justify-between">
                  <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand-text"><Plane className="h-5 w-5" /></div>
                  <ChevronRight className="h-4 w-4 text-muted group-hover:text-brand-text transition" />
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <h3 className="font-semibold text-fg truncate">{t.name}</h3>
                  <span className={cn('text-[10px] uppercase tracking-wide rounded border px-1.5 py-0.5 flex-shrink-0', STATUS_STYLES[t.status])}>{TRIP_STATUS_LABELS[t.status]}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                  {t.destination && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{t.destination}</span>}
                  <span className="inline-flex items-center gap-1"><CalendarRange className="h-3.5 w-3.5" />{fmtRange(t)}</span>
                </div>
                {until != null && until > 0 && t.status !== 'completed' && <div className="mt-2 text-xs font-medium text-sky-300">{until} day{until > 1 ? 's' : ''} to go</div>}
                {prog.total > 0 && (
                  <div className="mt-3">
                    <div className="h-1.5 bg-elevated rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${prog.percent}%` }} />
                    </div>
                    <div className="mt-1 text-[11px] text-muted">{prog.done}/{prog.total} checklist done</div>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Trip modal */}
      <Modal open={tripModal} onClose={() => setTripModal(false)} title={tripForm.id ? 'Edit trip' : 'New trip'}>
        <form onSubmit={saveTrip} className="space-y-4">
          <Field label="Trip name" required>
            {(id) => <Input id={id} value={tripForm.name} onChange={(e) => setTripForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Summer at the lake" autoFocus />}
          </Field>
          <Field label="Destination">
            {(id) => <Input id={id} value={tripForm.destination} onChange={(e) => setTripForm((f) => ({ ...f, destination: e.target.value }))} placeholder="Lake Tahoe, CA" />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start date">
              {(id) => <Input id={id} type="date" value={tripForm.start_date} onChange={(e) => setTripForm((f) => ({ ...f, start_date: e.target.value }))} />}
            </Field>
            <Field label="End date">
              {(id) => <Input id={id} type="date" value={tripForm.end_date} onChange={(e) => setTripForm((f) => ({ ...f, end_date: e.target.value }))} />}
            </Field>
          </div>
          <Field label="Status">
            {(id) => (
              <Select id={id} value={tripForm.status} onChange={(e) => setTripForm((f) => ({ ...f, status: e.target.value as TripStatus }))}>
                {(Object.keys(TRIP_STATUS_LABELS) as TripStatus[]).map((s) => <option key={s} value={s}>{TRIP_STATUS_LABELS[s]}</option>)}
              </Select>
            )}
          </Field>
          <div>
            <span className="block text-sm font-medium text-fg mb-1.5">Travelers</span>
            <div className="flex flex-wrap gap-1.5">
              {members.map((m) => (
                <button key={m.id} type="button" onClick={() => toggleTraveler(m.id)}
                  className={cn('inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition',
                    tripForm.traveler_ids.includes(m.id) ? 'bg-brand text-white border-brand' : 'bg-surface/50 text-muted border-border hover:text-fg')}>
                  <Avatar name={m.display_name} size={16} />{m.display_name}
                </button>
              ))}
            </div>
          </div>
          <Field label="Notes">
            {(id) => <Textarea id={id} value={tripForm.notes} onChange={(e) => setTripForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Flights, budget, ideas…" />}
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setTripModal(false)}>Cancel</Button>
            <Button type="submit" disabled={savingTrip}>{savingTrip ? 'Saving…' : tripForm.id ? 'Save changes' : 'Create trip'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
