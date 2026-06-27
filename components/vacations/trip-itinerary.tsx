'use client';

import { useMemo, useState } from 'react';
import { CalendarRange, Plus, Trash2, Pencil, AlertTriangle, Wand2 } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { ITEM_KINDS, DAY_PARTS, dollars, lookup } from '@/lib/vacations/meta';
import { dateRange } from '@/lib/vacations/dates';
import { detectConflicts, type ItemLike } from '@/lib/vacations/conflicts';
import type { Tables } from '@/lib/database.types';

type Trip = Tables<'vacations'>;
type Day = Tables<'vacation_itinerary_days'>;
type Item = Tables<'vacation_itinerary_items'>;

const blankItem = (day_id: string, day_part: string) => ({ id: '', day_id, day_part, kind: 'activity', title: '', location: '', start_time: '', end_time: '', cost: '', booked: false, notes: '' });

export function TripItinerary({ vacationId }: { vacationId: string }) {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();

  const { data: tripRows } = useRealtimeQuery<Trip>({
    table: 'vacations', familyId, deps: [familyId, vacationId],
    fetcher: (sb) => sb.from('vacations').select('*').eq('id', vacationId),
  });
  const trip = tripRows[0];

  const { data: days, loading: daysLoading } = useRealtimeQuery<Day>({
    table: 'vacation_itinerary_days', familyId, deps: [familyId, vacationId],
    fetcher: (sb) => sb.from('vacation_itinerary_days').select('*').eq('family_id', familyId).eq('vacation_id', vacationId),
  });
  const { data: items } = useRealtimeQuery<Item>({
    table: 'vacation_itinerary_items', familyId, deps: [familyId, vacationId],
    fetcher: (sb) => sb.from('vacation_itinerary_items').select('*').eq('family_id', familyId).eq('vacation_id', vacationId),
  });

  const sortedDays = useMemo(() => [...days].sort((a, b) => a.day_date.localeCompare(b.day_date)), [days]);
  const dayById = useMemo(() => new Map(days.map((d) => [d.id, d])), [days]);
  const itemsByDayPart = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const it of items) {
      const key = `${it.day_id}:${it.day_part}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(it);
    }
    for (const list of m.values()) list.sort((a, b) => (a.start_time ?? '~').localeCompare(b.start_time ?? '~') || a.sort_order - b.sort_order);
    return m;
  }, [items]);

  const hasYoungChildren = members.some((m) => m.role === 'child');
  const conflicts = useMemo(() => detectConflicts(
    items.map((it): ItemLike => ({ id: it.id, day_id: it.day_id, day_date: it.day_id ? dayById.get(it.day_id)?.day_date ?? null : null, kind: it.kind, day_part: it.day_part, title: it.title, start_time: it.start_time, end_time: it.end_time })),
    { hasYoungChildren },
  ), [items, dayById, hasYoungChildren]);

  const [form, setForm] = useState<ReturnType<typeof blankItem> | null>(null);
  const [busy, setBusy] = useState(false);

  async function generateDays() {
    if (!trip?.start_date || !trip?.end_date) return toastError('Set trip start and end dates first');
    setBusy(true);
    const range = dateRange(trip.start_date, trip.end_date);
    const existing = new Set(days.map((d) => d.day_date));
    const toAdd = range.filter((d) => !existing.has(d)).map((d) => ({ family_id: familyId, vacation_id: vacationId, day_date: d, created_by: userId }));
    if (toAdd.length === 0) { setBusy(false); return toastError('All days already exist'); }
    const { error } = await createClient().from('vacation_itinerary_days').insert(toAdd);
    setBusy(false);
    if (error) toastError(error.message); else success(`Added ${toAdd.length} days`);
  }

  async function saveItem(e: React.FormEvent) {
    e.preventDefault();
    if (!form?.title.trim()) return toastError('Title required');
    const row = {
      day_id: form.day_id || null, kind: form.kind as Item['kind'], day_part: form.day_part as Item['day_part'],
      title: form.title.trim(), location: form.location.trim() || null,
      start_time: form.start_time || null, end_time: form.end_time || null,
      cost_cents: form.cost ? Math.round(parseFloat(form.cost) * 100) : null,
      booked: form.booked, notes: form.notes.trim() || null,
    };
    const { error } = form.id
      ? await createClient().from('vacation_itinerary_items').update(row).eq('id', form.id)
      : await createClient().from('vacation_itinerary_items').insert({ ...row, family_id: familyId, vacation_id: vacationId, created_by: userId });
    if (error) return toastError(error.message);
    success(form.id ? 'Saved' : 'Added');
    setForm(null);
  }

  async function removeItem(id: string) {
    if (!confirm('Delete this item?')) return;
    const { error } = await createClient().from('vacation_itinerary_items').delete().eq('id', id);
    if (error) toastError(error.message);
  }

  function editItem(it: Item) {
    setForm({ id: it.id, day_id: it.day_id ?? '', day_part: it.day_part, kind: it.kind, title: it.title, location: it.location ?? '', start_time: it.start_time?.slice(0, 5) ?? '', end_time: it.end_time?.slice(0, 5) ?? '', cost: it.cost_cents != null ? String(it.cost_cents / 100) : '', booked: it.booked, notes: it.notes ?? '' });
  }

  if (daysLoading) return <LoadingBlock />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><CalendarRange className="h-5 w-5 text-brand" /> Daily itinerary</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={generateDays} loading={busy}><Wand2 className="h-4 w-4" /> Build days from dates</Button>
        </div>
      </div>

      {conflicts.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-amber-300"><AlertTriangle className="h-3.5 w-3.5" /> {conflicts.length} potential conflict{conflicts.length > 1 ? 's' : ''}</p>
          <ul className="space-y-1 text-sm">
            {conflicts.slice(0, 5).map((c) => <li key={c.id}><span className="font-medium">{c.title}:</span> <span className="text-muted">{c.detail}</span></li>)}
          </ul>
        </div>
      )}

      {sortedDays.length === 0 ? (
        <EmptyState icon={CalendarRange} title="No days planned yet" description="Set trip dates then click “Build days from dates”, or add days as you go." />
      ) : (
        <div className="space-y-4">
          {sortedDays.map((day, i) => (
            <div key={day.id} className="rounded-2xl border border-border bg-surface/40 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-semibold">Day {i + 1} · {fmtDate(day.day_date)}</h3>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {DAY_PARTS.map((part) => {
                  const list = itemsByDayPart.get(`${day.id}:${part.value}`) ?? [];
                  return (
                    <div key={part.value} className="rounded-xl border border-border/60 bg-elevated/30 p-2">
                      <div className="mb-1.5 flex items-center justify-between">
                        <p className="text-xs font-semibold text-muted">{part.emoji} {part.label}</p>
                        <button onClick={() => setForm(blankItem(day.id, part.value))} className="rounded p-0.5 text-muted hover:text-brand"><Plus className="h-3.5 w-3.5" /></button>
                      </div>
                      <ul className="space-y-1.5">
                        {list.map((it) => (
                          <li key={it.id} className="group rounded-lg bg-surface/60 p-2 text-sm">
                            <div className="flex items-start justify-between gap-1">
                              <span className="flex-1">{lookup(ITEM_KINDS, it.kind).emoji} {it.title}</span>
                              <span className="hidden shrink-0 gap-0.5 group-hover:flex">
                                <button onClick={() => editItem(it)} className="text-muted hover:text-fg"><Pencil className="h-3 w-3" /></button>
                                <button onClick={() => removeItem(it.id)} className="text-muted hover:text-danger"><Trash2 className="h-3 w-3" /></button>
                              </span>
                            </div>
                            {(it.start_time || it.location || it.cost_cents != null) && (
                              <p className="mt-0.5 text-[11px] text-muted">{[it.start_time?.slice(0, 5), it.location, it.cost_cents != null && dollars(it.cost_cents)].filter(Boolean).join(' · ')}</p>
                            )}
                          </li>
                        ))}
                        {list.length === 0 && <li className="py-1 text-center text-[11px] text-muted">—</li>}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {form && (
        <Modal open onClose={() => setForm(null)} title={form.id ? 'Edit item' : 'Add itinerary item'}>
          <form onSubmit={saveItem} className="space-y-3">
            <Field label="Title" required>{(id) => <Input id={id} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Magic Kingdom" required />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type">{(id) => <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{ITEM_KINDS.map((k) => <option key={k.value} value={k.value}>{k.emoji} {k.label}</option>)}</Select>}</Field>
              <Field label="Time of day">{(id) => <Select id={id} value={form.day_part} onChange={(e) => setForm({ ...form, day_part: e.target.value })}>{DAY_PARTS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start time">{(id) => <Input id={id} type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} />}</Field>
              <Field label="End time">{(id) => <Input id={id} type="time" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} />}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Location">{(id) => <Input id={id} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />}</Field>
              <Field label="Cost ($)">{(id) => <Input id={id} type="number" step="0.01" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />}</Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.booked} onChange={(e) => setForm({ ...form, booked: e.target.checked })} className="h-4 w-4 rounded border-border" /> Booked</label>
            <Field label="Notes">{(id) => <Textarea id={id} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />}</Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit">{form.id ? 'Save' : 'Add'}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
