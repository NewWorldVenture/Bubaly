'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  MapPin, LocateFixed, Plus, Pencil, Trash2, Home, GraduationCap, Briefcase,
  Dumbbell, Navigation, BatteryMedium, ShieldCheck, ShieldOff, Clock, Loader2,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { isManager } from '@/lib/constants/roles';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { SkeletonList, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import { haversineMeters, distanceLabel, timeAgo, isStale } from '@/lib/location/geo';
import { updateMyLocation, setLocationSharing, savePlace, deletePlace } from '@/app/(app)/dashboard/locator/actions';
import type { Tables } from '@/lib/database.types';

type MemberLocation = Tables<'member_locations'>;
type Place = Tables<'family_places'>;
type LocationEvent = Tables<'location_events'>;

const PLACE_ICONS: Record<string, typeof Home> = { home: Home, school: GraduationCap, work: Briefcase, gym: Dumbbell, other: MapPin };
const PLACE_KINDS = ['home', 'school', 'work', 'gym', 'other'];
const blankPlace = { id: '', name: '', icon: 'home', address: '', latitude: '', longitude: '', radius_m: 150 };

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { reject(new Error('Geolocation unavailable')); return; }
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  });
}

export function LocatorModule() {
  const { familyId, members, selfMember, role } = useApp();
  const { success, error: toastError } = useToast();
  const canManage = isManager(role);

  const [sharing, setSharing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [placeModal, setPlaceModal] = useState(false);
  const [placeForm, setPlaceForm] = useState(blankPlace);
  const [savingPlace, setSavingPlace] = useState(false);

  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);

  const { data: locations, loading } = useRealtimeQuery<MemberLocation>({
    table: 'member_locations', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('member_locations').select('*').eq('family_id', familyId),
  });
  const { data: places } = useRealtimeQuery<Place>({
    table: 'family_places', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_places').select('*').eq('family_id', familyId).order('name'),
  });
  const { data: events } = useRealtimeQuery<LocationEvent>({
    table: 'location_events', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('location_events').select('*').eq('family_id', familyId).order('occurred_at', { ascending: false }).limit(20),
  });

  const locByMember = useMemo(() => new Map((locations ?? []).map((l) => [l.member_id, l])), [locations]);
  const placeById = useMemo(() => new Map((places ?? []).map((p) => [p.id, p])), [places]);
  const memberName = (id: string) => members.find((m) => m.id === id)?.display_name ?? 'Someone';
  const homePlace = useMemo(() => (places ?? []).find((p) => p.icon === 'home') ?? (places ?? [])[0] ?? null, [places]);

  useEffect(() => {
    if (selfMember) setSharing(locByMember.get(selfMember.id)?.is_sharing ?? false);
  }, [selfMember, locByMember]);

  async function shareNow() {
    setUpdating(true);
    try {
      const pos = await getPosition();
      const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number }> };
      const battery = nav.getBattery ? await nav.getBattery().then((b) => Math.round(b.level * 100)).catch(() => null) : null;
      const res = await updateMyLocation({
        latitude: pos.coords.latitude, longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy ?? null, battery,
      });
      if (!res.ok) { toastError(res.error ?? 'Failed to update location'); return; }
      setSharing(true);
      success(res.place ? `Shared — you're at ${res.place}` : 'Location shared');
    } catch (e) {
      toastError(e instanceof Error && e.message.includes('denied') ? 'Location permission denied' : 'Couldn’t get your location');
    } finally { setUpdating(false); }
  }

  async function toggleSharing(next: boolean) {
    if (next) { await shareNow(); return; }
    const res = await setLocationSharing(false);
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    setSharing(false); success('Location sharing off');
  }

  // ── Places ────────────────────────────────────────────────
  function openNewPlace() { setPlaceForm(blankPlace); setPlaceModal(true); }
  function openEditPlace(p: Place) {
    setPlaceForm({ id: p.id, name: p.name, icon: p.icon ?? 'other', address: p.address ?? '', latitude: String(p.latitude), longitude: String(p.longitude), radius_m: p.radius_m });
    setPlaceModal(true);
  }
  async function useCurrentForPlace() {
    try {
      const pos = await getPosition();
      setPlaceForm((f) => ({ ...f, latitude: pos.coords.latitude.toFixed(6), longitude: pos.coords.longitude.toFixed(6) }));
      success('Filled in your current coordinates');
    } catch { toastError('Couldn’t get your location'); }
  }
  async function submitPlace(e: React.FormEvent) {
    e.preventDefault();
    const lat = Number(placeForm.latitude); const lng = Number(placeForm.longitude);
    if (!placeForm.name.trim()) { toastError('Name is required'); return; }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { toastError('Valid coordinates are required'); return; }
    setSavingPlace(true);
    const res = await savePlace({ id: placeForm.id || undefined, name: placeForm.name, icon: placeForm.icon, address: placeForm.address || null, latitude: lat, longitude: lng, radius_m: Number(placeForm.radius_m) || 150 });
    setSavingPlace(false);
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    success(placeForm.id ? 'Place updated' : 'Place added'); setPlaceModal(false);
  }
  async function removePlace(p: Place) {
    if (!confirm(`Delete "${p.name}"?`)) return;
    const res = await deletePlace(p.id);
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    success('Place deleted');
  }

  function statusFor(memberId: string): { label: string; tone: string; sub: string | null } {
    const loc = locByMember.get(memberId);
    if (!loc || !loc.is_sharing) return { label: 'Not sharing', tone: 'text-muted', sub: null };
    if (loc.latitude == null || loc.longitude == null) return { label: 'No location yet', tone: 'text-muted', sub: null };
    const place = loc.place_id ? placeById.get(loc.place_id) : null;
    const updated = loc.updated_at;
    const stale = isStale(updated, now, 60);
    let dist: string | null = null;
    if (homePlace && (!place || place.id !== homePlace.id)) {
      dist = `${distanceLabel(haversineMeters({ latitude: homePlace.latitude, longitude: homePlace.longitude }, { latitude: loc.latitude, longitude: loc.longitude }))} from ${homePlace.name}`;
    }
    return {
      label: place ? place.name : 'On the move',
      tone: place ? 'text-emerald-400' : 'text-amber-400',
      sub: `${stale ? 'Last seen ' : ''}${timeAgo(updated, now)}${dist ? ` · ${dist}` : ''}`,
    };
  }

  if (loading) return <SkeletonList count={5} />;

  return (
    <div>
      <PageHeader
        title="Family Map"
        description="See where everyone is, set places, and get arrival & departure alerts — opt-in and private to your family."
        action={
          <div className="flex items-center gap-2">
            <Button onClick={shareNow} disabled={updating} className="gap-1.5">
              {updating ? <Loader2 className="h-4 w-4 animate-spin" /> : <LocateFixed className="h-4 w-4" />}
              {updating ? 'Locating…' : 'Share my location'}
            </Button>
          </div>
        }
      />

      {/* Self sharing control */}
      {selfMember && (
        <div className={cn('flex items-center justify-between rounded-2xl border p-4 mb-6', sharing ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border bg-surface/50')}>
          <div className="flex items-center gap-3">
            {sharing ? <ShieldCheck className="h-5 w-5 text-emerald-400" /> : <ShieldOff className="h-5 w-5 text-muted" />}
            <div>
              <div className="text-sm font-medium text-fg">Your location sharing is {sharing ? 'on' : 'off'}</div>
              <div className="text-xs text-muted">{sharing ? 'Your family can see where you are.' : 'Turn on to share your location with your family.'}</div>
            </div>
          </div>
          <button onClick={() => toggleSharing(!sharing)}
            className={cn('relative h-7 w-12 rounded-full transition-colors', sharing ? 'bg-emerald-500' : 'bg-elevated')}>
            <span className={cn('absolute top-1 h-5 w-5 rounded-full bg-white transition-transform', sharing ? 'translate-x-6' : 'translate-x-1')} />
          </button>
        </div>
      )}

      {/* Member board */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-8">
        {members.map((m) => {
          const st = statusFor(m.id);
          const loc = locByMember.get(m.id);
          return (
            <div key={m.id} className="rounded-2xl border border-border bg-surface/50 p-4">
              <div className="flex items-start gap-3">
                <Avatar name={m.display_name} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-fg truncate">{m.display_name}{selfMember?.id === m.id ? ' (you)' : ''}</div>
                  <div className={cn('mt-0.5 flex items-center gap-1 text-sm font-medium', st.tone)}>
                    {st.label === 'On the move' ? <Navigation className="h-3.5 w-3.5" /> : st.label !== 'Not sharing' && st.label !== 'No location yet' ? <MapPin className="h-3.5 w-3.5" /> : null}
                    {st.label}
                  </div>
                  {st.sub && <div className="mt-0.5 flex items-center gap-1 text-xs text-muted"><Clock className="h-3 w-3" />{st.sub}</div>}
                  {loc?.battery != null && loc.is_sharing && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-muted"><BatteryMedium className="h-3.5 w-3.5" />{loc.battery}%</div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Saved places */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-fg uppercase tracking-wider flex items-center gap-2"><MapPin className="h-4 w-4 text-brand" /> Saved Places</h2>
        {canManage && <Button variant="outline" size="sm" onClick={openNewPlace} className="gap-1.5"><Plus className="h-4 w-4" /> Add place</Button>}
      </div>
      {(places ?? []).length === 0 ? (
        <EmptyState icon={MapPin} title="No places yet"
          description={canManage ? 'Add places like Home, School, and Work to get arrival & departure alerts when family members come and go.' : 'No places have been set up yet.'}
          action={canManage && <Button onClick={openNewPlace} className="gap-1.5"><Plus className="h-4 w-4" /> Add place</Button>} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-8">
          {(places ?? []).map((p) => {
            const Icon = PLACE_ICONS[p.icon ?? 'other'] ?? MapPin;
            const here = (locations ?? []).filter((l) => l.place_id === p.id && l.is_sharing).map((l) => memberName(l.member_id));
            return (
              <div key={p.id} className="rounded-2xl border border-border bg-surface/50 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand/10 text-brand flex-shrink-0"><Icon className="h-5 w-5" /></div>
                    <div className="min-w-0">
                      <div className="font-semibold text-fg truncate">{p.name}</div>
                      {p.address && <div className="text-xs text-muted truncate">{p.address}</div>}
                      <div className="text-xs text-muted">{p.radius_m} m radius</div>
                    </div>
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button onClick={() => openEditPlace(p)} aria-label="Edit" className="p-1.5 rounded-lg text-muted hover:text-fg hover:bg-elevated"><Pencil className="h-4 w-4" /></button>
                      <button onClick={() => removePlace(p)} aria-label="Delete" className="p-1.5 rounded-lg text-muted hover:text-rose-400 hover:bg-elevated"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  )}
                </div>
                {here.length > 0 && <div className="mt-2 text-xs text-emerald-400">{here.join(', ')} here now</div>}
              </div>
            );
          })}
        </div>
      )}

      {/* Recent activity */}
      {(events ?? []).length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-fg uppercase tracking-wider mb-3 flex items-center gap-2"><Navigation className="h-4 w-4 text-muted" /> Recent Activity</h2>
          <div className="space-y-1.5">
            {(events ?? []).map((ev) => (
              <div key={ev.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm">
                <Avatar name={memberName(ev.member_id)} size={22} />
                <span className="text-fg/90">
                  {memberName(ev.member_id)} {ev.event_type === 'left' ? 'left' : 'arrived at'} {ev.place_name ?? 'a place'}
                </span>
                <span className="text-muted ml-auto text-xs">{timeAgo(ev.occurred_at, now)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Place modal */}
      <Modal open={placeModal} onClose={() => setPlaceModal(false)} title={placeForm.id ? 'Edit place' : 'Add place'}>
        <form onSubmit={submitPlace} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" required>
              {(id) => <Input id={id} value={placeForm.name} onChange={(e) => setPlaceForm((f) => ({ ...f, name: e.target.value }))} placeholder="Home" autoFocus />}
            </Field>
            <Field label="Type">
              {(id) => (
                <Select id={id} value={placeForm.icon} onChange={(e) => setPlaceForm((f) => ({ ...f, icon: e.target.value }))}>
                  {PLACE_KINDS.map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}
                </Select>
              )}
            </Field>
          </div>
          <Field label="Address">
            {(id) => <Input id={id} value={placeForm.address} onChange={(e) => setPlaceForm((f) => ({ ...f, address: e.target.value }))} placeholder="123 Main St" />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Latitude" required>
              {(id) => <Input id={id} value={placeForm.latitude} onChange={(e) => setPlaceForm((f) => ({ ...f, latitude: e.target.value }))} placeholder="40.7128" />}
            </Field>
            <Field label="Longitude" required>
              {(id) => <Input id={id} value={placeForm.longitude} onChange={(e) => setPlaceForm((f) => ({ ...f, longitude: e.target.value }))} placeholder="-74.0060" />}
            </Field>
          </div>
          <div className="flex items-center justify-between">
            <button type="button" onClick={useCurrentForPlace} className="text-xs font-medium text-brand hover:underline inline-flex items-center gap-1">
              <LocateFixed className="h-3.5 w-3.5" /> Use my current location
            </button>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">Radius</span>
              <Input type="number" min={50} step={50} value={placeForm.radius_m} onChange={(e) => setPlaceForm((f) => ({ ...f, radius_m: Number(e.target.value) }))} className="h-9 w-24" />
              <span className="text-xs text-muted">m</span>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setPlaceModal(false)}>Cancel</Button>
            <Button type="submit" disabled={savingPlace}>{savingPlace ? 'Saving…' : placeForm.id ? 'Save changes' : 'Add place'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
