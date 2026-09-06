'use client';

import { useMemo, useState } from 'react';
import {
  PackageSearch, Plus, Search, MapPin, Trash2, Pencil, Handshake, ArrowRightLeft, ShieldCheck, Boxes, AlertTriangle, Camera, Check, ChevronRight, DoorOpen,
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
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Database, Tables, HomeLocationKind, InventoryCategory, InventoryStatus } from '@/lib/database.types';
import {
  LOCATION_KINDS, ITEM_CATEGORIES, ITEM_STATUSES, categoryMeta, statusMeta, locationKindMeta, locationLabel, locationTree,
  searchItems, lentOut, warrantyAlerts, valueSummary, inventorySummary,
} from '@/lib/inventory/finder';
import { useTranslations } from '@/components/i18n/locale-provider';

type Item = Tables<'inventory_items'>;
type Location = Tables<'home_locations'>;
type Move = Tables<'inventory_moves'>;

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const todayIso = () => new Date().toISOString().slice(0, 10);
function fmtDate(d: string): string {
  return new Date(d.length <= 10 ? `${d}T00:00:00` : d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function photoUrl(path: string | null): string | null {
  if (!path) return null;
  return createClient().storage.from('family-media').getPublicUrl(path).data.publicUrl;
}

export function InventoryModule() {
  const tr = useTranslations();
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();

  const locations = useRealtimeQuery<Location>({
    table: 'home_locations', familyId,
    fetcher: (s) => s.from('home_locations').select('*').eq('family_id', familyId).order('name'),
    deps: [familyId],
  });
  const items = useRealtimeQuery<Item>({
    table: 'inventory_items', familyId,
    fetcher: (s) => s.from('inventory_items').select('*').eq('family_id', familyId).order('updated_at', { ascending: false }),
    deps: [familyId],
  });
  const moves = useRealtimeQuery<Move>({
    table: 'inventory_moves', familyId,
    fetcher: (s) => s.from('inventory_moves').select('*').eq('family_id', familyId).order('moved_at', { ascending: false }).limit(40),
    deps: [familyId],
  });

  const [query, setQuery] = useState('');
  const [locationFilter, setLocationFilter] = useState<'all' | 'none' | string>('all');
  const [categoryFilter, setCategoryFilter] = useState<'all' | InventoryCategory>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | InventoryStatus>('all');
  const [itemForm, setItemForm] = useState<{ open: boolean; item: Item | null }>({ open: false, item: null });
  const [locationForm, setLocationForm] = useState<{ open: boolean; parent: Location | null; location: Location | null }>({ open: false, parent: null, location: null });
  const [moveFor, setMoveFor] = useState<Item | null>(null);
  const [lendFor, setLendFor] = useState<Item | null>(null);

  const today = useMemo(() => new Date(), []);
  const owned = useMemo(() => items.data.filter((i) => i.status !== 'disposed'), [items.data]);
  const hits = useMemo(() => searchItems(items.data, locations.data, query), [items.data, locations.data, query]);
  const tree = useMemo(() => locationTree(locations.data), [locations.data]);
  const summary = useMemo(() => inventorySummary(items.data, locations.data, today), [items.data, locations.data, today]);
  const loans = useMemo(() => lentOut(items.data, today), [items.data, today]);
  const warranties = useMemo(() => warrantyAlerts(items.data, today).slice(0, 5), [items.data, today]);
  const value = useMemo(() => valueSummary(items.data), [items.data]);
  const itemsIn = (locId: string) => owned.filter((i) => i.location_id === locId).length;
  const filtered = useMemo(() => {
    const base = query.trim() ? hits.map((h) => h.item) : items.data;
    return base.filter((i) =>
      (locationFilter === 'all' || (locationFilter === 'none' ? !i.location_id : i.location_id === locationFilter)) &&
      (categoryFilter === 'all' || i.category === categoryFilter) &&
      (statusFilter === 'all' ? i.status !== 'disposed' : i.status === statusFilter));
  }, [items.data, hits, query, locationFilter, categoryFilter, statusFilter]);
  const memberName = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? null;

  async function deleteItem(item: Item) {
    if (!confirm(`Remove ${item.name} from the inventory?`)) return;
    const { error } = await createClient().from('inventory_items').delete().eq('id', item.id);
    if (error) return toastError(describeDbError(error));
    success('Item removed');
  }

  async function setStatus(item: Item, status: InventoryStatus) {
    const patch: Database['public']['Tables']['inventory_items']['Update'] = { status };
    if (status !== 'lent') { patch.lent_to = null; patch.lent_on = null; }
    const { error } = await createClient().from('inventory_items').update(patch).eq('id', item.id);
    if (error) return toastError(describeDbError(error));
    success(`${item.name}: ${statusMeta(status).label}`);
  }

  async function deleteLocation(location: Location) {
    const count = itemsIn(location.id);
    if (!confirm(`Delete “${location.name}”?${count ? ` ${count} item${count === 1 ? '' : 's'} will lose their location.` : ''}`)) return;
    const { error } = await createClient().from('home_locations').delete().eq('id', location.id);
    if (error) return toastError(describeDbError(error));
    success('Location deleted');
  }

  const loading = locations.loading || items.loading || moves.loading;
  const error = locations.error || items.error || moves.error;
  const refresh = () => { void locations.refresh(); void items.refresh(); void moves.refresh(); };
  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message="Could not load the home inventory. Refresh and try again." onRetry={refresh} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title={tr('inventory.homeInventory')}
        description="Where everything lives. Ask “where is the…?”, track what’s lent out, keep serials and warranties, and know what the home is worth."
        action={
          <div className="flex items-center gap-2">
            <AiInsight kind="inventory" iconOnly />
            <Button variant="secondary" onClick={() => setLocationForm({ open: true, parent: null, location: null })}><DoorOpen className="h-4 w-4" /> {tr('inventory.addRoom')}</Button>
            <Button onClick={() => setItemForm({ open: true, item: null })}><Plus className="h-4 w-4" /> {tr('inventory.addItem')}</Button>
          </div>
        }
      />

      {/* Where is it? */}
      <div className="rounded-2xl border border-brand/20 bg-brand/5 p-5">
        <label className="flex items-center gap-3 rounded-xl border border-border bg-surface/70 px-3 py-2">
          <Search className="h-5 w-5 shrink-0 text-brand-text" />
          <input
            value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr('inventory.whereIsThePassportSkiHelmet')}
            aria-label={tr('inventory.searchTheInventory')} className="min-h-10 w-full bg-transparent text-base outline-none placeholder:text-muted"
          />
          {query && <button onClick={() => setQuery('')} className="text-xs text-muted hover:text-fg">{tr('inventory.clear')}</button>}
        </label>
        {query.trim() && (
          <ul className="mt-3 space-y-1.5">
            {hits.length === 0 ? <li className="text-sm text-muted">{tr('inventory.nothingMatches')}{query}{tr('inventory.tryABrandTagSerialOr')}</li> : null}
            {hits.slice(0, 6).map((h) => (
              <li key={h.item.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/60 px-3 py-2">
                <span className="text-xl">{categoryMeta(h.item.category).emoji}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{h.item.name}{h.item.quantity > 1 ? ` ×${h.item.quantity}` : ''}</p>
                  <p className="truncate text-xs text-muted"><MapPin className="mr-1 inline h-3 w-3" />{h.where}{h.item.status !== 'in_place' ? ` · ${statusMeta(h.item.status).label}${h.item.lent_to ? ` to ${h.item.lent_to}` : ''}` : ''}</p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setMoveFor(h.item)}><ArrowRightLeft className="h-3.5 w-3.5" /> {tr('inventory.moved')}</Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Summary + alerts */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold"><Boxes className="h-4 w-4 text-brand-text" /> {tr('inventory.catalog')}</div>
          <p className="mt-2 text-xl font-bold">{summary.text}</p>
          <p className="mt-1 text-xs text-muted">{summary.rooms} {tr('inventory.rooms')} {summary.unlocated} {tr('inventory.withoutALocation')}{summary.overdueLoans ? ` · ${summary.overdueLoans} loan${summary.overdueLoans === 1 ? '' : 's'} overdue` : ''}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-brand-text" /> {tr('inventory.replacementValue')}</div>
          <p className="mt-2 text-xl font-bold">{value.valuedItems ? money(value.totalCents) : '—'}</p>
          <p className="mt-1 text-xs text-muted">{value.valuedItems ? `${value.valuedItems} valued item${value.valuedItems === 1 ? '' : 's'} · top: ${value.byCategory.slice(0, 2).map((c) => `${categoryMeta(c.category).label} ${money(c.cents)}`).join(', ')}` : 'Add values to build an insurance record'}</p>
        </div>
        <div className={cn('rounded-2xl border p-5', loans.some((l) => l.overdue) || warranties.length ? 'border-amber-500/30 bg-amber-500/10' : 'border-border bg-surface/40')}>
          <div className="flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-amber-300" /> {tr('inventory.needsAttention')}</div>
          {loans.length === 0 && warranties.length === 0 ? <p className="mt-2 text-sm text-muted">{tr('inventory.noOpenLoansOrExpiringWarranties')}</p> : (
            <ul className="mt-2 space-y-1 text-xs">
              {loans.slice(0, 3).map((l) => <li key={l.item.id} className={l.overdue ? 'text-amber-200' : 'text-muted'}><Handshake className="mr-1 inline h-3 w-3" />{l.item.name} → {l.item.lent_to || 'someone'}{l.days !== null ? ` · ${l.days}d` : ''}{l.overdue ? ' · overdue' : ''}</li>)}
              {warranties.slice(0, 3).map((w) => <li key={w.item.id} className={w.state === 'expired' ? 'text-muted' : 'text-amber-200'}><ShieldCheck className="mr-1 inline h-3 w-3" />{w.item.name}{tr('inventory.warranty')} {w.state === 'expired' ? `expired ${Math.abs(w.days)}d ago` : `ends in ${w.days}d`}</li>)}
            </ul>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* Rooms + containers */}
        <div className="rounded-2xl border border-border bg-surface/40 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">{tr('inventory.rooms')}</span>
            <button onClick={() => setLocationFilter('all')} className={cn('text-xs', locationFilter === 'all' ? 'text-brand-text' : 'text-muted hover:text-fg')}>{tr('inventory.allItems')}</button>
          </div>
          {tree.length === 0 ? <p className="text-xs text-muted">{tr('inventory.addRoomsThenShelvesBinsAnd')}</p> : (
            <ul className="space-y-1">
              {tree.map(({ location, children }) => (
                <li key={location.id}>
                  <div className="group flex items-center gap-1">
                    <button onClick={() => setLocationFilter(location.id)} className={cn('flex min-h-9 flex-1 items-center gap-2 rounded-lg px-2 text-left text-sm', locationFilter === location.id ? 'bg-brand/15 text-brand-text' : 'hover:bg-elevated')}>
                      <span>{locationKindMeta(location.kind).emoji}</span><span className="truncate">{location.name}</span><span className="ml-auto text-xs text-muted">{itemsIn(location.id)}</span>
                    </button>
                    <button onClick={() => setLocationForm({ open: true, parent: location, location: null })} aria-label={`Add a container in ${location.name}`} className="rounded p-1 text-muted opacity-0 hover:text-fg group-hover:opacity-100"><Plus className="h-3.5 w-3.5" /></button>
                    <button onClick={() => setLocationForm({ open: true, parent: null, location })} aria-label={`Edit ${location.name}`} className="rounded p-1 text-muted opacity-0 hover:text-fg group-hover:opacity-100"><Pencil className="h-3.5 w-3.5" /></button>
                    <button onClick={() => deleteLocation(location)} aria-label={`Delete ${location.name}`} className="rounded p-1 text-muted opacity-0 hover:text-rose-400 group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                  {children.length > 0 && (
                    <ul className="ml-4 border-l border-border pl-2">
                      {children.map((c) => (
                        <li key={c.id} className="group flex items-center gap-1">
                          <button onClick={() => setLocationFilter(c.id)} className={cn('flex min-h-8 flex-1 items-center gap-2 rounded-lg px-2 text-left text-xs', locationFilter === c.id ? 'bg-brand/15 text-brand-text' : 'text-muted hover:bg-elevated hover:text-fg')}>
                            <ChevronRight className="h-3 w-3" /><span className="truncate">{c.name}</span><span className="ml-auto">{itemsIn(c.id)}</span>
                          </button>
                          <button onClick={() => deleteLocation(c)} aria-label={`Delete ${c.name}`} className="rounded p-1 text-muted opacity-0 hover:text-rose-400 group-hover:opacity-100"><Trash2 className="h-3 w-3" /></button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
              <li><button onClick={() => setLocationFilter('none')} className={cn('flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm', locationFilter === 'none' ? 'bg-brand/15 text-brand-text' : 'text-muted hover:bg-elevated hover:text-fg')}>{tr('inventory.noLocation')} <span className="ml-auto text-xs">{owned.filter((i) => !i.location_id).length}</span></button></li>
            </ul>
          )}
        </div>

        {/* Items */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value as 'all' | InventoryCategory)} aria-label={tr('inventory.category')} className="w-auto">
              <option value="all">{tr('inventory.allCategories')}</option>
              {ITEM_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.emoji} {c.label}</option>)}
            </Select>
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | InventoryStatus)} aria-label={tr('inventory.status')} className="w-auto">
              <option value="all">{tr('inventory.owned')}</option>
              {ITEM_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.emoji} {s.label}</option>)}
            </Select>
            <span className="text-xs text-muted">{filtered.length} item{filtered.length === 1 ? '' : 's'}</span>
          </div>
          {items.data.length === 0 ? (
            <EmptyState icon={PackageSearch} title={tr('inventory.nothingCataloguedYet')} description="Start with the things you keep losing: passports, spare keys, seasonal gear. Add a photo and a location and you’ll never hunt again." action={<Button onClick={() => setItemForm({ open: true, item: null })}><Plus className="h-4 w-4" /> {tr('inventory.addTheFirstItem')}</Button>} />
          ) : filtered.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted">{tr('inventory.noItemsMatchTheseFilters')}</p>
          ) : (
            <ul className="grid gap-2 md:grid-cols-2">
              {filtered.slice(0, 120).map((item) => {
                const url = photoUrl(item.photo_path);
                return (
                  <li key={item.id} className="group flex items-center gap-3 rounded-2xl border border-border bg-surface/40 px-3 py-2.5">
                    {url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- family-media public URL, sized thumbnail
                      <img src={url} alt="" className="h-11 w-11 shrink-0 rounded-xl object-cover" />
                    ) : <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/10 text-xl">{categoryMeta(item.category).emoji}</span>}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{item.name}{item.quantity > 1 ? <span className="text-muted"> ×{item.quantity}</span> : null}</p>
                      <p className="truncate text-xs text-muted"><MapPin className="mr-0.5 inline h-3 w-3" />{locationLabel(locations.data, item.location_id)}{item.brand ? ` · ${item.brand}` : ''}{item.value_cents ? ` · ${money(item.value_cents)}` : ''}{memberName(item.owner_member_id) ? ` · ${memberName(item.owner_member_id)}’s` : ''}</p>
                      {item.status !== 'in_place' && <p className="text-[11px] text-amber-300">{statusMeta(item.status).emoji} {statusMeta(item.status).label}{item.lent_to ? ` to ${item.lent_to}` : ''}{item.lent_on ? ` since ${fmtDate(item.lent_on)}` : ''}</p>}
                    </div>
                    <div className="flex items-center gap-0.5 opacity-70 transition group-hover:opacity-100">
                      <button onClick={() => setMoveFor(item)} aria-label={`Move ${item.name}`} title={tr('inventory.movedTo')} className="rounded-lg p-1.5 text-muted hover:text-fg"><ArrowRightLeft className="h-4 w-4" /></button>
                      {item.status === 'lent'
                        ? <button onClick={() => setStatus(item, 'in_place')} aria-label={`${item.name} returned`} title={tr('inventory.returned')} className="rounded-lg p-1.5 text-muted hover:text-fg"><Check className="h-4 w-4" /></button>
                        : <button onClick={() => setLendFor(item)} aria-label={`Lend ${item.name}`} title={tr('inventory.lendOut')} className="rounded-lg p-1.5 text-muted hover:text-fg"><Handshake className="h-4 w-4" /></button>}
                      <button onClick={() => setItemForm({ open: true, item })} aria-label={`Edit ${item.name}`} className="rounded-lg p-1.5 text-muted hover:text-fg"><Pencil className="h-4 w-4" /></button>
                      <button onClick={() => deleteItem(item)} aria-label={`Remove ${item.name}`} className="rounded-lg p-1.5 text-muted hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {moves.data.length > 0 && (
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><ArrowRightLeft className="h-4 w-4 text-brand-text" /> {tr('inventory.recentMoves')}</div>
          <ul className="space-y-1.5">
            {moves.data.slice(0, 6).map((m) => {
              const item = items.data.find((i) => i.id === m.item_id);
              return (
                <li key={m.id} className="flex items-center gap-3 rounded-xl border border-border px-3 py-2 text-sm">
                  <span className="w-14 shrink-0 text-xs text-muted">{fmtDate(m.moved_at)}</span>
                  <span className="min-w-0 flex-1 truncate">{item?.name ?? 'Item'}: {locationLabel(locations.data, m.from_location_id)} → {locationLabel(locations.data, m.to_location_id)}</span>
                  <span className="shrink-0 text-xs text-muted">{memberName(m.moved_by) ?? ''}{m.reason ? ` · ${m.reason.replace(' [seed:inventory]', '')}` : ''}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {itemForm.open && (
        <ItemForm familyId={familyId} userId={userId} members={members} locations={locations.data} item={itemForm.item} defaultLocationId={locationFilter !== 'all' && locationFilter !== 'none' ? locationFilter : null}
          onClose={() => setItemForm({ open: false, item: null })} onSaved={(msg) => { setItemForm({ open: false, item: null }); success(msg); }} />
      )}
      {locationForm.open && (
        <LocationForm familyId={familyId} userId={userId} locations={locations.data} parent={locationForm.parent} location={locationForm.location}
          onClose={() => setLocationForm({ open: false, parent: null, location: null })} onSaved={(msg) => { setLocationForm({ open: false, parent: null, location: null }); success(msg); }} />
      )}
      {moveFor && (
        <MoveForm familyId={familyId} userId={userId} memberId={selfMember?.id ?? null} item={moveFor} locations={locations.data}
          onClose={() => setMoveFor(null)} onSaved={() => { setMoveFor(null); success('Move logged'); }} />
      )}
      {lendFor && (
        <LendForm item={lendFor} onClose={() => setLendFor(null)} onSaved={() => { setLendFor(null); success(`${lendFor.name} marked as lent out`); }} />
      )}
    </div>
  );
}

function LocationOptions({ locations }: { locations: Location[] }) {
  const tr = useTranslations();
  return (
    <>
      <option value="">{tr('inventory.noLocation')}</option>
      {locationTree(locations).flatMap(({ location, children }) => [
        <option key={location.id} value={location.id}>{locationKindMeta(location.kind).emoji} {location.name}</option>,
        ...children.map((c) => <option key={c.id} value={c.id}>&nbsp;&nbsp;› {c.name}</option>),
      ])}
    </>
  );
}

function ItemForm({ familyId, userId, members, locations, item, defaultLocationId, onClose, onSaved }: {
  familyId: string; userId: string; members: Tables<'family_members'>[]; locations: Location[]; item: Item | null; defaultLocationId: string | null;
  onClose: () => void; onSaved: (message: string) => void;
}) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [photoPath, setPhotoPath] = useState<string | null>(item?.photo_path ?? null);

  async function uploadPhoto(file: File) {
    if (file.size > 25 * 1024 * 1024) { toastError('Photo is too large (max 25 MB)'); return; }
    setUploading(true);
    try {
      const ext = file.name.split('.').pop() || 'jpg';
      const path = `${familyId}/inventory/${Date.now()}.${ext}`;
      const { data: stored, error: upErr } = await createClient().storage.from('family-media').upload(path, file, { upsert: false });
      if (upErr || !stored) { toastError(describeDbError(upErr)); return; }
      setPhotoPath(stored.path);
    } finally {
      setUploading(false);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name') ?? '').trim();
    if (!name) return toastError('Name is required');
    setLoading(true);
    const payload = {
      name,
      category: String(f.get('category') ?? 'other') as InventoryCategory,
      location_id: String(f.get('location_id') ?? '') || null,
      owner_member_id: String(f.get('owner_member_id') ?? '') || null,
      quantity: Math.max(0, Number(f.get('quantity') ?? 1)),
      value_cents: f.get('value') ? Math.round(Number(f.get('value')) * 100) : null,
      purchased_on: String(f.get('purchased_on') ?? '') || null,
      brand: String(f.get('brand') ?? '').trim() || null,
      model: String(f.get('model') ?? '').trim() || null,
      serial_number: String(f.get('serial_number') ?? '').trim() || null,
      warranty_until: String(f.get('warranty_until') ?? '') || null,
      tags: String(f.get('tags') ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
      photo_path: photoPath,
      notes: String(f.get('notes') ?? '').trim() || null,
    };
    const supabase = createClient();
    const { error } = item
      ? await supabase.from('inventory_items').update(payload).eq('id', item.id)
      : await supabase.from('inventory_items').insert({ family_id: familyId, created_by: userId, ...payload });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved(item ? 'Item updated' : 'Item added');
  }

  const url = photoUrl(photoPath);
  return (
    <Modal open title={item ? `Edit · ${item.name}` : 'Add an item'} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('inventory.name')} required>{(id) => <Input id={id} name="name" autoFocus defaultValue={item?.name ?? ''} placeholder={tr('inventory.skiHelmet')} />}</Field>
          <Field label={tr('inventory.category')}>{(id) => <Select id={id} name="category" defaultValue={item?.category ?? 'other'}>{ITEM_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.emoji} {c.label}</option>)}</Select>}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('inventory.where')} hint="Room › container">{(id) => <Select id={id} name="location_id" defaultValue={item?.location_id ?? defaultLocationId ?? ''}><LocationOptions locations={locations} /></Select>}</Field>
          <Field label={tr('inventory.whose')}>{(id) => <Select id={id} name="owner_member_id" defaultValue={item?.owner_member_id ?? ''}><option value="">{tr('inventory.theFamily')}</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label={tr('inventory.quantity')}>{(id) => <Input id={id} name="quantity" type="number" min={0} defaultValue={item?.quantity ?? 1} />}</Field>
          <Field label={tr('inventory.value')} hint="For insurance">{(id) => <Input id={id} name="value" type="number" inputMode="decimal" step="0.01" min="0" defaultValue={item?.value_cents != null ? (item.value_cents / 100).toFixed(2) : ''} />}</Field>
          <Field label={tr('inventory.purchased')}>{(id) => <Input id={id} name="purchased_on" type="date" defaultValue={item?.purchased_on ?? ''} />}</Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label={tr('inventory.brand')}>{(id) => <Input id={id} name="brand" defaultValue={item?.brand ?? ''} />}</Field>
          <Field label={tr('inventory.model')}>{(id) => <Input id={id} name="model" defaultValue={item?.model ?? ''} />}</Field>
          <Field label={tr('inventory.serial')}>{(id) => <Input id={id} name="serial_number" defaultValue={item?.serial_number ?? ''} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('inventory.warrantyUntil')}>{(id) => <Input id={id} name="warranty_until" type="date" defaultValue={item?.warranty_until ?? ''} />}</Field>
          <Field label={tr('inventory.tags')} hint="Comma-separated">{(id) => <Input id={id} name="tags" defaultValue={item?.tags.join(', ') ?? ''} placeholder={tr('inventory.travelInsured')} />}</Field>
        </div>
        <div className="flex items-center gap-3">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element -- family-media public URL, sized thumbnail
            <img src={url} alt="" className="h-12 w-12 rounded-xl object-cover" />
          ) : <span className="grid h-12 w-12 place-items-center rounded-xl bg-brand/10 text-muted"><Camera className="h-5 w-5" /></span>}
          <label className="cursor-pointer text-sm text-brand-text">
            {uploading ? 'Uploading…' : photoPath ? 'Replace photo' : 'Add a photo'}
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadPhoto(file); }} />
          </label>
          {photoPath && <button type="button" onClick={() => setPhotoPath(null)} className="text-xs text-muted hover:text-rose-400">{tr('inventory.remove')}</button>}
        </div>
        <Field label={tr('inventory.notes')}>{(id) => <Textarea id={id} name="notes" defaultValue={item?.notes ?? ''} placeholder={tr('inventory.receiptInTheWarrantyFolderCharger')} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('inventory.cancel')}</Button>
          <Button type="submit" loading={loading || uploading}>{item ? 'Save changes' : 'Add item'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function LocationForm({ familyId, userId, locations, parent, location, onClose, onSaved }: {
  familyId: string; userId: string; locations: Location[]; parent: Location | null; location: Location | null; onClose: () => void; onSaved: (message: string) => void;
}) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const rooms = locations.filter((l) => !l.parent_id && l.id !== location?.id);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name') ?? '').trim();
    if (!name) return toastError('Name is required');
    setLoading(true);
    const payload = { name, kind: String(f.get('kind') ?? 'room') as HomeLocationKind, parent_id: String(f.get('parent_id') ?? '') || null, notes: String(f.get('notes') ?? '').trim() || null };
    const supabase = createClient();
    const { error } = location
      ? await supabase.from('home_locations').update(payload).eq('id', location.id)
      : await supabase.from('home_locations').insert({ family_id: familyId, created_by: userId, ...payload });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved(location ? 'Location updated' : parent ? `Added to ${parent.name}` : 'Room added');
  }

  return (
    <Modal open title={location ? `Edit · ${location.name}` : parent ? `Add a container in ${parent.name}` : 'Add a room or area'} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('inventory.name')} required>{(id) => <Input id={id} name="name" autoFocus defaultValue={location?.name ?? ''} placeholder={parent ? 'Shelf B / Blue tote' : 'Garage'} />}</Field>
          <Field label={tr('inventory.kind')}>{(id) => <Select id={id} name="kind" defaultValue={location?.kind ?? (parent ? 'box' : 'room')}>{LOCATION_KINDS.map((k) => <option key={k.value} value={k.value}>{k.emoji} {k.label}</option>)}</Select>}</Field>
        </div>
        <Field label={tr('inventory.inside')} hint="Leave empty for a top-level room or area">{(id) => <Select id={id} name="parent_id" defaultValue={location?.parent_id ?? parent?.id ?? ''}><option value="">{tr('inventory.topLevel')}</option>{rooms.map((r) => <option key={r.id} value={r.id}>{locationKindMeta(r.kind).emoji} {r.name}</option>)}</Select>}</Field>
        <Field label={tr('inventory.notes')}>{(id) => <Textarea id={id} name="notes" defaultValue={location?.notes ?? ''} placeholder={tr('inventory.keyIsOnTheHookBy')} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('inventory.cancel')}</Button>
          <Button type="submit" loading={loading}>{location ? 'Save' : 'Add'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function MoveForm({ familyId, userId, memberId, item, locations, onClose, onSaved }: {
  familyId: string; userId: string; memberId: string | null; item: Item; locations: Location[]; onClose: () => void; onSaved: () => void;
}) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const to = String(f.get('to_location_id') ?? '') || null;
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.from('inventory_items').update({ location_id: to, status: item.status === 'lost' ? 'in_place' : item.status }).eq('id', item.id);
    if (error) { setLoading(false); return toastError(describeDbError(error)); }
    const { error: moveError } = await supabase.from('inventory_moves').insert({
      family_id: familyId, item_id: item.id, from_location_id: item.location_id, to_location_id: to, moved_by: memberId,
      reason: String(f.get('reason') ?? '').trim() || null, created_by: userId,
    });
    setLoading(false);
    if (moveError) return toastError(describeDbError(moveError));
    onSaved();
  }

  return (
    <Modal open title={`Moved · ${item.name}`} description={`Currently: ${locationLabel(locations, item.location_id)}`} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={tr('inventory.nowIn')}>{(id) => <Select id={id} name="to_location_id" defaultValue={item.location_id ?? ''}><LocationOptions locations={locations} /></Select>}</Field>
        <Field label="Why">{(id) => <Input id={id} name="reason" placeholder={tr('inventory.springCleanBackFromRepair')} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('inventory.cancel')}</Button>
          <Button type="submit" loading={loading}><ArrowRightLeft className="h-4 w-4" /> {tr('inventory.logMove')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function LendForm({ item, onClose, onSaved }: { item: Item; onClose: () => void; onSaved: () => void }) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const to = String(f.get('lent_to') ?? '').trim();
    if (!to) return toastError('Who has it?');
    setLoading(true);
    const { error } = await createClient().from('inventory_items').update({ status: 'lent', lent_to: to, lent_on: String(f.get('lent_on') ?? '') || todayIso() }).eq('id', item.id);
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title={`Lend out · ${item.name}`} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="To" required>{(id) => <Input id={id} name="lent_to" autoFocus placeholder={tr('inventory.theNguyensNextDoor')} />}</Field>
          <Field label={tr('inventory.since')}>{(id) => <Input id={id} name="lent_on" type="date" defaultValue={todayIso()} />}</Field>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('inventory.cancel')}</Button>
          <Button type="submit" loading={loading}><Handshake className="h-4 w-4" /> {tr('inventory.markAsLent')}</Button>
        </div>
      </form>
    </Modal>
  );
}
