'use client';

import { useMemo, useState } from 'react';
import { Luggage, Plus, Trash2, Wand2, Sparkles } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingBlock, EmptyState } from '@/components/ui/states';
import { Progress } from './shared';
import { PACK_CATEGORIES, lookup } from '@/lib/vacations/meta';
import { tripNights } from '@/lib/vacations/dates';
import { suggestPacking } from '@/lib/vacations/packing';
import type { Tables, VacPackCategory } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Trip = Tables<'vacations'>;
type List = Tables<'vacation_packing_lists'>;
type PackItem = Tables<'vacation_packing_items'>;
type Weather = Tables<'vacation_weather_snapshots'>;
type Activity = Tables<'vacation_activities'>;

const blank = () => ({ name: '', category: 'other' as VacPackCategory, quantity: '1' });

export function TripPacking({ vacationId }: { vacationId: string }) {
  const tr = useTranslations();
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();

  const tripQuery = useRealtimeQuery<Trip>({ table: 'vacations', familyId, deps: [familyId, vacationId], fetcher: (sb) => sb.from('vacations').select('*').eq('id', vacationId) });
  const listsQuery = useRealtimeQuery<List>({ table: 'vacation_packing_lists', familyId, deps: [familyId, vacationId], fetcher: (sb) => sb.from('vacation_packing_lists').select('*').eq('family_id', familyId).eq('vacation_id', vacationId) });
  const itemsQuery = useRealtimeQuery<PackItem>({ table: 'vacation_packing_items', familyId, deps: [familyId, vacationId], fetcher: (sb) => sb.from('vacation_packing_items').select('*').eq('family_id', familyId).eq('vacation_id', vacationId) });
  const weatherQuery = useRealtimeQuery<Weather>({ table: 'vacation_weather_snapshots', familyId, deps: [familyId, vacationId], fetcher: (sb) => sb.from('vacation_weather_snapshots').select('*').eq('family_id', familyId).eq('vacation_id', vacationId) });
  const activitiesQuery = useRealtimeQuery<Activity>({ table: 'vacation_activities', familyId, deps: [familyId, vacationId], fetcher: (sb) => sb.from('vacation_activities').select('*').eq('family_id', familyId).eq('vacation_id', vacationId) });
  const trip = tripQuery.data[0];
  const lists = listsQuery.data;
  const items = itemsQuery.data;
  const weather = weatherQuery.data;
  const activities = activitiesQuery.data;
  const readQueries = [tripQuery, listsQuery, itemsQuery, weatherQuery, activitiesQuery];
  const loading = readQueries.some((query) => query.loading);
  const readError = readQueries.some((query) => query.error);
  const refreshAll = () => { void Promise.all(readQueries.map((query) => query.refresh())); };

  const byCategory = useMemo(() => {
    const m = new Map<VacPackCategory, PackItem[]>();
    for (const it of items) { if (!m.has(it.category)) m.set(it.category, []); m.get(it.category)!.push(it); }
    for (const list of m.values()) list.sort((a, b) => Number(a.packed) - Number(b.packed) || a.name.localeCompare(b.name));
    return m;
  }, [items]);
  const packed = items.filter((i) => i.packed).length;
  const pct = items.length ? Math.round((packed / items.length) * 100) : 0;

  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const [busy, setBusy] = useState(false);

  async function ensureMasterList(): Promise<string | null> {
    const master = lists.find((l) => l.is_master);
    if (master) return master.id;
    const { data, error } = await createClient().from('vacation_packing_lists').insert({ family_id: familyId, vacation_id: vacationId, name: 'Master list', is_master: true, created_by: userId }).select('id').single();
    if (error) { toastError(error.message); return null; }
    return data.id;
  }

  async function generate() {
    setBusy(true);
    const listId = await ensureMasterList();
    if (!listId) { setBusy(false); return; }
    const nights = tripNights(trip?.start_date, trip?.end_date) ?? 5;
    const temps = weather.map((w) => w.temp_high_c).filter((t): t is number => t != null);
    const lows = weather.map((w) => w.temp_low_c).filter((t): t is number => t != null);
    const rainy = weather.some((w) => (w.precip_prob ?? 0) >= 50);
    const suggestions = suggestPacking({
      kind: trip?.kind ?? 'domestic', nights, isInternational: trip?.is_international ?? false,
      hasChildren: members.some((m) => m.role === 'child'), hasBaby: false,
      maxTempC: temps.length ? Math.max(...temps) : null, minTempC: lows.length ? Math.min(...lows) : null,
      rainy, activities: activities.map((a) => a.name),
    });
    const existing = new Set(items.map((i) => i.name.toLowerCase()));
    const toAdd = suggestions.filter((s) => !existing.has(s.name.toLowerCase()))
      .map((s) => ({ family_id: familyId, vacation_id: vacationId, list_id: listId, name: s.name, category: s.category, quantity: s.quantity, ai_suggested: true, created_by: userId }));
    if (toAdd.length === 0) { setBusy(false); return toastError('Your list already covers the essentials'); }
    const { error } = await createClient().from('vacation_packing_items').insert(toAdd);
    setBusy(false);
    if (error) toastError(error.message); else success(`Added ${toAdd.length} suggested items`);
  }

  async function toggle(it: PackItem) {
    const { error } = await createClient().from('vacation_packing_items').update({ packed: !it.packed }).eq('id', it.id);
    if (error) toastError(error.message);
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!form?.name.trim()) return;
    const listId = await ensureMasterList();
    const { error } = await createClient().from('vacation_packing_items').insert({ family_id: familyId, vacation_id: vacationId, list_id: listId, name: form.name.trim(), category: form.category, quantity: parseInt(form.quantity) || 1, created_by: userId });
    if (error) toastError(error.message); else success('Added');
    setForm(null);
  }
  async function remove(id: string) {
    const { error } = await createClient().from('vacation_packing_items').delete().eq('id', id);
    if (error) toastError(error.message);
  }

  if (loading) return <LoadingBlock />;
  if (readError) return <ErrorState message="Could not load the packing plan. Refresh and try again." onRetry={refreshAll} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><Luggage className="h-5 w-5 text-brand-text" /> {tr('tripPacking.packing')}</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={generate} loading={busy}><Wand2 className="h-4 w-4" /> {tr('tripPacking.smartList')}</Button>
          <Button size="sm" onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> Add</Button>
        </div>
      </div>

      {items.length > 0 && (
        <div className="rounded-xl border border-border bg-surface/40 p-3">
          <div className="mb-1.5 flex items-center justify-between text-sm"><span className="font-medium">{tr('tripPacking.packed')} {packed} / {items.length}</span><span className="text-muted">{pct}%</span></div>
          <Progress pct={pct} tone={pct === 100 ? 'bg-emerald-500' : 'bg-brand'} />
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState icon={Luggage} title={tr('tripPacking.nothingPackedYet')} description="Tap “Smart list” to auto-generate a packing list from your trip type, weather, and activities." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {PACK_CATEGORIES.filter((c) => byCategory.has(c.value)).map((cat) => (
            <div key={cat.value} className="rounded-2xl border border-border bg-surface/40 p-4">
              <p className="mb-2 text-sm font-semibold">{cat.emoji} {cat.label}</p>
              <ul className="space-y-1">
                {byCategory.get(cat.value)!.map((it) => (
                  <li key={it.id} className="group flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={it.packed} onChange={() => toggle(it)} className="h-4 w-4 rounded border-border" />
                    <span className={it.packed ? 'flex-1 text-muted line-through' : 'flex-1'}>{it.name}{it.quantity > 1 ? ` ×${it.quantity}` : ''}</span>
                    {it.ai_suggested && <Sparkles className="h-3 w-3 text-brand-text/60" />}
                    <button onClick={() => remove(it.id)} className="hidden text-muted hover:text-danger group-hover:block"><Trash2 className="h-3.5 w-3.5" /></button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {form && (
        <Modal open onClose={() => setForm(null)} title={tr('tripPacking.addPackingItem')}>
          <form onSubmit={add} className="space-y-3">
            <Field label={tr('tripPacking.item')} required>{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={tr('tripPacking.category')}>{(id) => <Select id={id} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as VacPackCategory })}>{PACK_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select>}</Field>
              <Field label={tr('tripPacking.quantity')}>{(id) => <Input id={id} type="number" min="1" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />}</Field>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setForm(null)}>{tr('tripPacking.cancel')}</Button>
              <Button type="submit">Add</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

