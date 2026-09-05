'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Shirt, Plus, Sparkles, Thermometer, Trash2, Star, X, Camera, History, WashingMachine, Check, Pencil, Wand2, AlertTriangle,
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
import type { Tables, OutfitOccasion, WardrobeCategory, WardrobeStatus } from '@/lib/database.types';
import { fetchForecast } from '@/lib/weather/open-meteo';
import {
  WARDROBE_CATEGORIES, WARDROBE_STATUSES, SEASONS, OCCASIONS, categoryMeta, statusMeta, occasionMeta,
  suggestOutfit, closetSummary, neglectedItems, costPerWear, tempBand, weatherLabelFromTemp, dayDiff,
} from '@/lib/closet/outfits';

type Item = Tables<'wardrobe_items'>;
type Outfit = Tables<'outfits'>;
type Log = Tables<'outfit_logs'>;
type WeatherLocation = Tables<'weather_locations'>;

const fToC = (f: number) => Math.round(((f - 32) * 5) / 9);
const cToF = (c: number) => Math.round((c * 9) / 5 + 32);
const todayIso = () => new Date().toISOString().slice(0, 10);
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function fmtDate(d: string): string {
  return new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function photoUrl(path: string | null): string | null {
  if (!path) return null;
  return createClient().storage.from('family-media').getPublicUrl(path).data.publicUrl;
}

export function ClosetModule() {
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();

  const items = useRealtimeQuery<Item>({
    table: 'wardrobe_items', familyId,
    fetcher: (s) => s.from('wardrobe_items').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
    deps: [familyId],
  });
  const outfits = useRealtimeQuery<Outfit>({
    table: 'outfits', familyId,
    fetcher: (s) => s.from('outfits').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
    deps: [familyId],
  });
  const logs = useRealtimeQuery<Log>({
    table: 'outfit_logs', familyId,
    fetcher: (s) => s.from('outfit_logs').select('*').eq('family_id', familyId).order('worn_on', { ascending: false }).limit(90),
    deps: [familyId],
  });
  const locations = useRealtimeQuery<WeatherLocation>({
    table: 'weather_locations', familyId,
    fetcher: (s) => s.from('weather_locations').select('*').eq('family_id', familyId).order('is_default', { ascending: false }).order('sort_order').limit(1),
    deps: [familyId],
  });

  const [memberId, setMemberId] = useState('');
  useEffect(() => {
    if (!memberId && members.length) setMemberId(selfMember?.id ?? members[0].id);
  }, [members, selfMember, memberId]);

  const [tempF, setTempF] = useState(68);
  const [tempSource, setTempSource] = useState<'manual' | 'forecast'>('manual');
  const location = locations.data[0];
  useEffect(() => {
    if (!location) return;
    let alive = true;
    fetchForecast(location.latitude, location.longitude, 1)
      .then((fc) => { if (alive && fc) { setTempF(Math.round(fc.current.temp)); setTempSource('forecast'); } })
      .catch(() => { /* manual temperature stays */ });
    return () => { alive = false; };
  }, [location]);

  const [occasion, setOccasion] = useState<OutfitOccasion>('everyday');
  const [categoryFilter, setCategoryFilter] = useState<'all' | WardrobeCategory>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | WardrobeStatus>('active');
  const [itemForm, setItemForm] = useState<{ open: boolean; item: Item | null }>({ open: false, item: null });
  const [builderOpen, setBuilderOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const today = useMemo(() => new Date(), []);
  const tempC = fToC(tempF);
  const memberItems = useMemo(() => items.data.filter((i) => i.member_id === memberId), [items.data, memberId]);
  const memberLogs = useMemo(() => logs.data.filter((l) => l.member_id === memberId), [logs.data, memberId]);
  const memberOutfits = useMemo(() => outfits.data.filter((o) => o.member_id === memberId), [outfits.data, memberId]);
  const suggestion = useMemo(() => suggestOutfit(items.data, { memberId, tempC, occasion, date: today }), [items.data, memberId, tempC, occasion, today]);
  const summary = useMemo(() => closetSummary(memberItems, memberLogs, today), [memberItems, memberLogs, today]);
  const neglected = useMemo(() => neglectedItems(memberItems, today).slice(0, 5), [memberItems, today]);
  const filtered = useMemo(
    () => memberItems.filter((i) => (categoryFilter === 'all' || i.category === categoryFilter) && (statusFilter === 'all' || i.status === statusFilter)),
    [memberItems, categoryFilter, statusFilter],
  );
  const itemById = useMemo(() => new Map(items.data.map((i) => [i.id, i])), [items.data]);
  const memberName = (id: string) => members.find((m) => m.id === id)?.display_name ?? 'Member';

  async function logWear(itemIds: string[], outfitId: string | null) {
    if (!itemIds.length) return toastError('Pick at least one item first');
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.from('outfit_logs').insert({
      family_id: familyId, member_id: memberId, outfit_id: outfitId, worn_on: todayIso(), item_ids: itemIds,
      occasion, temp_c: tempC, weather: weatherLabelFromTemp(tempC), created_by: userId,
    });
    if (error) { setBusy(false); return toastError(describeDbError(error)); }
    const results = await Promise.all(itemIds.map((id) => {
      const current = itemById.get(id);
      return supabase.from('wardrobe_items').update({ wear_count: (current?.wear_count ?? 0) + 1, last_worn_on: todayIso() }).eq('id', id);
    }));
    setBusy(false);
    const failed = results.find((r) => r.error);
    if (failed?.error) return toastError(describeDbError(failed.error));
    success('Logged today’s outfit');
  }

  async function saveSuggestionAsOutfit() {
    if (!suggestion.picks.length) return toastError('Nothing to save yet');
    const band = tempBand(tempC);
    const { error } = await createClient().from('outfits').insert({
      family_id: familyId, member_id: memberId,
      name: `${occasionMeta(occasion).label} · ${weatherLabelFromTemp(tempC)} day`,
      occasion, item_ids: suggestion.picks.map((p) => p.item.id), temp_min_c: band.min, temp_max_c: band.max, created_by: userId,
    });
    if (error) return toastError(describeDbError(error));
    success('Outfit saved');
  }

  async function setItemStatus(item: Item, status: WardrobeStatus) {
    const { error } = await createClient().from('wardrobe_items').update({ status }).eq('id', item.id);
    if (error) return toastError(describeDbError(error));
    success(`${item.name}: ${statusMeta(status).label}`);
  }

  async function deleteItem(item: Item) {
    if (!confirm(`Remove ${item.name} from the closet?`)) return;
    const { error } = await createClient().from('wardrobe_items').delete().eq('id', item.id);
    if (error) return toastError(describeDbError(error));
    success('Item removed');
  }

  async function toggleFavorite(outfit: Outfit) {
    const { error } = await createClient().from('outfits').update({ is_favorite: !outfit.is_favorite }).eq('id', outfit.id);
    if (error) return toastError(describeDbError(error));
  }

  async function deleteOutfit(outfit: Outfit) {
    if (!confirm(`Delete the outfit “${outfit.name}”?`)) return;
    const { error } = await createClient().from('outfits').delete().eq('id', outfit.id);
    if (error) return toastError(describeDbError(error));
    success('Outfit deleted');
  }

  const loading = items.loading || outfits.loading || logs.loading;
  const error = items.error || outfits.error || logs.error;
  const refresh = () => { void items.refresh(); void outfits.refresh(); void logs.refresh(); };

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message="Could not load the closet. Refresh and try again." onRetry={refresh} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Closet & Outfits"
        description="Every family member’s closet, today’s outfit picked from what they own, and the laundry, outgrown and cost-per-wear signals that keep it honest."
        action={
          <div className="flex items-center gap-2">
            <AiInsight kind="closet" iconOnly />
            <Button variant="secondary" onClick={() => setBuilderOpen(true)}><Wand2 className="h-4 w-4" /> Build outfit</Button>
            <Button onClick={() => setItemForm({ open: true, item: null })}><Plus className="h-4 w-4" /> Add item</Button>
          </div>
        }
      />

      {/* Member switcher */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Family member">
        {members.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={m.id === memberId}
            onClick={() => setMemberId(m.id)}
            className={cn('rounded-full border px-3 py-1.5 text-sm transition coarse:min-h-11', m.id === memberId ? 'border-brand bg-brand/15 text-brand-text' : 'border-border bg-surface/40 text-muted hover:text-fg')}
          >
            {m.display_name}
          </button>
        ))}
      </div>

      {/* Today's outfit */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-brand/20 bg-brand/5 p-5 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-brand-text"><Sparkles className="h-4 w-4" /> Today’s outfit for {memberName(memberId)}</div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex items-center gap-1.5 rounded-xl border border-border bg-surface/60 px-2 py-1">
                <Thermometer className="h-4 w-4 text-muted" />
                <input
                  type="number" value={tempF} min={-30} max={120} aria-label="Temperature in Fahrenheit"
                  onChange={(e) => { setTempF(Number(e.target.value)); setTempSource('manual'); }}
                  className="w-14 bg-transparent text-right outline-none"
                />
                <span className="text-muted">°F</span>
                <span className="text-[10px] text-muted">{tempSource === 'forecast' ? `· ${location?.name ?? 'forecast'}` : '· manual'}</span>
              </label>
              <Select value={occasion} onChange={(e) => setOccasion(e.target.value as OutfitOccasion)} aria-label="Occasion" className="w-auto">
                {OCCASIONS.map((o) => <option key={o.value} value={o.value}>{o.emoji} {o.label}</option>)}
              </Select>
            </div>
          </div>

          {suggestion.picks.length === 0 ? (
            <p className="mt-3 text-sm text-muted">{suggestion.summary}</p>
          ) : (
            <>
              <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                {suggestion.picks.map((p) => {
                  const url = photoUrl(p.item.photo_path);
                  return (
                    <li key={p.item.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/60 px-3 py-2">
                      {/* eslint-disable-next-line @next/next/no-img-element -- family-media public URL, sized thumbnails */}
                      {url ? <img src={url} alt="" className="h-10 w-10 rounded-lg object-cover" /> : <span className="grid h-10 w-10 place-items-center rounded-lg bg-brand/10 text-xl">{categoryMeta(p.item.category).emoji}</span>}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{p.item.name}</p>
                        <p className="truncate text-xs text-muted">{p.reasons.slice(0, 2).join(' · ') || categoryMeta(p.item.category).label}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {suggestion.missing.length > 0 && (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-amber-300"><AlertTriangle className="h-3.5 w-3.5" /> Nothing suitable for: {suggestion.missing.join(', ')} — a gap worth filling.</p>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" loading={busy} onClick={() => logWear(suggestion.picks.map((p) => p.item.id), null)}><Check className="h-3.5 w-3.5" /> Wearing this</Button>
                <Button size="sm" variant="secondary" onClick={saveSuggestionAsOutfit}><Star className="h-3.5 w-3.5" /> Save as outfit</Button>
              </div>
            </>
          )}
        </div>

        <div className="space-y-3">
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="flex items-center gap-2 text-sm font-semibold"><Shirt className="h-4 w-4 text-brand-text" /> Closet status</div>
            <p className={cn('mt-2 text-xl font-bold', summary.retire > 0 ? 'text-amber-300' : 'text-fg')}>{summary.text}</p>
            <p className="mt-1 text-xs text-muted">
              {summary.wornThisWeek} outfit{summary.wornThisWeek === 1 ? '' : 's'} logged this week
              {summary.avgCostPerWearCents !== null ? ` · avg ${money(summary.avgCostPerWearCents)} per wear` : ''}
            </p>
            {summary.mostWorn.length > 0 && (
              <p className="mt-2 text-xs text-muted">Most worn: {summary.mostWorn.map((m) => `${m.name} (${m.count}×)`).join(', ')}</p>
            )}
          </div>
          {neglected.length > 0 && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
              <p className="font-semibold text-amber-200">Not worn in months</p>
              <ul className="mt-1 space-y-1 text-xs text-amber-100/90">
                {neglected.map((i) => <li key={i.id}>{i.name}{i.last_worn_on ? ` · last worn ${fmtDate(i.last_worn_on)}` : ' · never worn'}</li>)}
              </ul>
              <p className="mt-2 text-[11px] text-amber-200/80">Outgrown? Mark it, donate it, or move it to storage from the item menu.</p>
            </div>
          )}
        </div>
      </div>

      {/* Filters + items */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value as 'all' | WardrobeCategory)} aria-label="Category filter" className="w-auto">
          <option value="all">All categories</option>
          {WARDROBE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.emoji} {c.label}</option>)}
        </Select>
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | WardrobeStatus)} aria-label="Status filter" className="w-auto">
          <option value="all">Any status</option>
          {WARDROBE_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.emoji} {s.label}</option>)}
        </Select>
        <span className="text-xs text-muted">{filtered.length} of {memberItems.length} items</span>
      </div>

      {memberItems.length === 0 ? (
        <EmptyState icon={Shirt} title={`${memberName(memberId)}’s closet is empty`} description="Add tops, bottoms, shoes and outerwear with a warmth and formality rating — the outfit engine does the rest." action={<Button onClick={() => setItemForm({ open: true, item: null })}><Plus className="h-4 w-4" /> Add the first item</Button>} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((item) => {
            const url = photoUrl(item.photo_path);
            const cpw = costPerWear(item);
            return (
              <div key={item.id} className="group rounded-2xl border border-border bg-surface/40 p-3">
                <div className="flex items-start gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element -- family-media public URL, sized thumbnails */}
                  {url ? <img src={url} alt={item.name} className="h-14 w-14 rounded-xl object-cover" /> : <span className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-brand/10 text-2xl">{categoryMeta(item.category).emoji}</span>}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{item.name}</p>
                    <p className="truncate text-xs text-muted">{categoryMeta(item.category).label}{item.color ? ` · ${item.color}` : ''}{item.size ? ` · ${item.size}` : ''}</p>
                    <p className="mt-1 text-[11px] text-muted">
                      warmth {item.warmth}/5 · formality {item.formality}/5
                      {item.last_worn_on ? ` · worn ${fmtDate(item.last_worn_on)}` : ''}
                      {cpw !== null ? ` · ${money(cpw)}/wear` : ''}
                    </p>
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span className={cn('rounded-full border px-2 py-0.5 text-[10px]', item.status === 'active' ? 'border-emerald-500/30 text-emerald-300' : item.status === 'laundry' ? 'border-sky-500/30 text-sky-300' : 'border-amber-500/30 text-amber-300')}>
                    {statusMeta(item.status).emoji} {statusMeta(item.status).label}
                  </span>
                  <div className="flex items-center gap-1 opacity-80 transition group-hover:opacity-100">
                    {item.status === 'active' ? (
                      <button onClick={() => setItemStatus(item, 'laundry')} aria-label={`Send ${item.name} to the laundry`} title="To laundry" className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg"><WashingMachine className="h-4 w-4" /></button>
                    ) : (
                      <button onClick={() => setItemStatus(item, 'active')} aria-label={`Return ${item.name} to the closet`} title="Back in closet" className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg"><Check className="h-4 w-4" /></button>
                    )}
                    <button onClick={() => setItemForm({ open: true, item })} aria-label={`Edit ${item.name}`} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg"><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => deleteItem(item)} aria-label={`Remove ${item.name}`} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Saved outfits + history */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Star className="h-4 w-4 text-brand-text" /> Saved outfits</div>
          {memberOutfits.length === 0 ? (
            <p className="text-sm text-muted">Save today’s suggestion or build one from the closet.</p>
          ) : (
            <ul className="space-y-2">
              {memberOutfits.slice(0, 8).map((o) => (
                <li key={o.id} className="flex items-center gap-3 rounded-xl border border-border px-3 py-2">
                  <button onClick={() => toggleFavorite(o)} aria-label={o.is_favorite ? 'Unfavourite' : 'Favourite'} className={cn('shrink-0', o.is_favorite ? 'text-amber-300' : 'text-muted')}><Star className="h-4 w-4" fill={o.is_favorite ? 'currentColor' : 'none'} /></button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{o.name}</p>
                    <p className="truncate text-xs text-muted">
                      {occasionMeta(o.occasion).label}
                      {o.temp_min_c !== null && o.temp_max_c !== null ? ` · ${cToF(o.temp_min_c)}–${cToF(o.temp_max_c)}°F` : ''}
                      {' · '}{o.item_ids.map((id) => itemById.get(id)?.name).filter(Boolean).join(' + ') || 'no items'}
                    </p>
                  </div>
                  <Button size="sm" variant="secondary" loading={busy} onClick={() => logWear(o.item_ids, o.id)}>Wear</Button>
                  <button onClick={() => deleteOutfit(o)} aria-label="Delete outfit" className="shrink-0 p-1 text-muted/60 hover:text-rose-400"><Trash2 className="h-3.5 w-3.5" /></button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4 text-brand-text" /> Recently worn</div>
          {memberLogs.length === 0 ? (
            <p className="text-sm text-muted">Outfits you log show up here with the weather they were worn in.</p>
          ) : (
            <ul className="space-y-1.5">
              {memberLogs.slice(0, 8).map((l) => (
                <li key={l.id} className="flex items-center gap-3 rounded-xl border border-border px-3 py-2 text-sm">
                  <span className="w-14 shrink-0 text-xs text-muted">{dayDiff(l.worn_on, today) === 0 ? 'Today' : fmtDate(l.worn_on)}</span>
                  <span className="min-w-0 flex-1 truncate">{l.item_ids.map((id) => itemById.get(id)?.name).filter(Boolean).join(' + ') || 'Outfit'}</span>
                  <span className="shrink-0 text-xs text-muted">{l.occasion ?? ''}{typeof l.temp_c === 'number' ? ` · ${cToF(l.temp_c)}°F` : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {itemForm.open && memberId && (
        <ItemForm
          familyId={familyId} userId={userId} memberId={memberId} members={members} item={itemForm.item}
          onClose={() => setItemForm({ open: false, item: null })}
          onSaved={(msg) => { setItemForm({ open: false, item: null }); success(msg); }}
        />
      )}
      {builderOpen && memberId && (
        <OutfitBuilder
          familyId={familyId} userId={userId} memberId={memberId} items={memberItems.filter((i) => i.status === 'active')}
          onClose={() => setBuilderOpen(false)} onSaved={() => { setBuilderOpen(false); success('Outfit saved'); }}
        />
      )}
    </div>
  );
}

function ItemForm({ familyId, userId, memberId, members, item, onClose, onSaved }: {
  familyId: string; userId: string; memberId: string; members: Tables<'family_members'>[]; item: Item | null;
  onClose: () => void; onSaved: (message: string) => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [photoPath, setPhotoPath] = useState<string | null>(item?.photo_path ?? null);
  const [seasons, setSeasons] = useState<string[]>(item?.seasons ?? []);

  async function uploadPhoto(file: File) {
    if (file.size > 25 * 1024 * 1024) { toastError('Photo is too large (max 25 MB)'); return; }
    setUploading(true);
    try {
      const ext = file.name.split('.').pop() || 'jpg';
      const path = `${familyId}/closet/${Date.now()}.${ext}`;
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
      member_id: String(f.get('member_id') ?? memberId),
      name,
      category: String(f.get('category') ?? 'top') as WardrobeCategory,
      color: String(f.get('color') ?? '').trim() || null,
      size: String(f.get('size') ?? '').trim() || null,
      brand: String(f.get('brand') ?? '').trim() || null,
      warmth: Number(f.get('warmth') ?? 3),
      formality: Number(f.get('formality') ?? 2),
      seasons,
      status: String(f.get('status') ?? 'active') as WardrobeStatus,
      photo_path: photoPath,
      purchased_on: String(f.get('purchased_on') ?? '') || null,
      price_cents: f.get('price') ? Math.round(Number(f.get('price')) * 100) : null,
      notes: String(f.get('notes') ?? '').trim() || null,
    };
    const supabase = createClient();
    const { error } = item
      ? await supabase.from('wardrobe_items').update(payload).eq('id', item.id)
      : await supabase.from('wardrobe_items').insert({ family_id: familyId, created_by: userId, ...payload });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved(item ? 'Item updated' : 'Item added');
  }

  const url = photoUrl(photoPath);
  return (
    <Modal open title={item ? `Edit · ${item.name}` : 'Add a closet item'} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required>{(id) => <Input id={id} name="name" autoFocus defaultValue={item?.name ?? ''} placeholder="Grey hoodie" />}</Field>
          <Field label="Whose">{(id) => <Select id={id} name="member_id" defaultValue={item?.member_id ?? memberId}>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">{(id) => <Select id={id} name="category" defaultValue={item?.category ?? 'top'}>{WARDROBE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.emoji} {c.label}</option>)}</Select>}</Field>
          <Field label="Status">{(id) => <Select id={id} name="status" defaultValue={item?.status ?? 'active'}>{WARDROBE_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.emoji} {s.label}</option>)}</Select>}</Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Color">{(id) => <Input id={id} name="color" defaultValue={item?.color ?? ''} placeholder="navy" />}</Field>
          <Field label="Size">{(id) => <Input id={id} name="size" defaultValue={item?.size ?? ''} placeholder="M / 8" />}</Field>
          <Field label="Brand">{(id) => <Input id={id} name="brand" defaultValue={item?.brand ?? ''} placeholder="Optional" />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Warmth (1 light – 5 heavy)" hint="Drives the weather match">{(id) => <Input id={id} name="warmth" type="number" min={1} max={5} defaultValue={item?.warmth ?? 3} />}</Field>
          <Field label="Formality (1 lounge – 5 dressy)" hint="Drives the occasion match">{(id) => <Input id={id} name="formality" type="number" min={1} max={5} defaultValue={item?.formality ?? 2} />}</Field>
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">Seasons (leave empty for year-round)</p>
          <div className="flex flex-wrap gap-2">
            {SEASONS.map((s) => {
              const on = seasons.includes(s.value);
              return (
                <button type="button" key={s.value} aria-pressed={on} onClick={() => setSeasons(on ? seasons.filter((x) => x !== s.value) : [...seasons, s.value])}
                  className={cn('rounded-full border px-3 py-1 text-xs coarse:min-h-11', on ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted')}>
                  {s.emoji} {s.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Purchased on">{(id) => <Input id={id} name="purchased_on" type="date" defaultValue={item?.purchased_on ?? ''} />}</Field>
          <Field label="Price ($)" hint="Enables cost per wear">{(id) => <Input id={id} name="price" type="number" inputMode="decimal" step="0.01" min="0" defaultValue={item?.price_cents != null ? (item.price_cents / 100).toFixed(2) : ''} />}</Field>
        </div>
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- family-media public URL, sized thumbnails */}
          {url ? <img src={url} alt="" className="h-12 w-12 rounded-xl object-cover" /> : <span className="grid h-12 w-12 place-items-center rounded-xl bg-brand/10 text-muted"><Camera className="h-5 w-5" /></span>}
          <label className="cursor-pointer text-sm text-brand-text">
            {uploading ? 'Uploading…' : photoPath ? 'Replace photo' : 'Add a photo'}
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadPhoto(file); }} />
          </label>
          {photoPath && <button type="button" onClick={() => setPhotoPath(null)} className="text-xs text-muted hover:text-rose-400">Remove</button>}
        </div>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" defaultValue={item?.notes ?? ''} placeholder="Hand-me-down from Sam, school uniform, dry-clean only…" />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading || uploading}>{item ? 'Save changes' : 'Add item'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function OutfitBuilder({ familyId, userId, memberId, items, onClose, onSaved }: {
  familyId: string; userId: string; memberId: string; items: Item[]; onClose: () => void; onSaved: () => void;
}) {
  const { error: toastError } = useToast();
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name') ?? '').trim();
    if (!name) return toastError('Give the outfit a name');
    if (selected.length === 0) return toastError('Pick at least one item');
    setLoading(true);
    const { error } = await createClient().from('outfits').insert({
      family_id: familyId, member_id: memberId, name, occasion: String(f.get('occasion') ?? 'everyday') as OutfitOccasion,
      item_ids: selected, notes: String(f.get('notes') ?? '').trim() || null, created_by: userId,
    });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  const grouped = WARDROBE_CATEGORIES.map((c) => ({ ...c, items: items.filter((i) => i.category === c.value) })).filter((g) => g.items.length);
  return (
    <Modal open title="Build an outfit" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required>{(id) => <Input id={id} name="name" autoFocus placeholder="Rainy school day" />}</Field>
          <Field label="Occasion">{(id) => <Select id={id} name="occasion" defaultValue="everyday">{OCCASIONS.map((o) => <option key={o.value} value={o.value}>{o.emoji} {o.label}</option>)}</Select>}</Field>
        </div>
        {grouped.length === 0 ? (
          <p className="text-sm text-muted">No active items for this member yet.</p>
        ) : (
          <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
            {grouped.map((g) => (
              <div key={g.value}>
                <p className="mb-1 text-xs font-semibold text-muted">{g.emoji} {g.label}</p>
                <div className="flex flex-wrap gap-2">
                  {g.items.map((i) => {
                    const on = selected.includes(i.id);
                    return (
                      <button type="button" key={i.id} aria-pressed={on} onClick={() => setSelected(on ? selected.filter((x) => x !== i.id) : [...selected, i.id])}
                        className={cn('rounded-full border px-3 py-1 text-xs coarse:min-h-11', on ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted')}>
                        {i.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" placeholder="Optional" />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}><X className="h-4 w-4" /> Cancel</Button>
          <Button type="submit" loading={loading}>Save outfit ({selected.length})</Button>
        </div>
      </form>
    </Modal>
  );
}
