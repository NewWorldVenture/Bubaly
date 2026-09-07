'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { firstName } from '@/lib/utils/format';
import {
  MapPin, LocateFixed, Plus, Pencil, Trash2, Home, GraduationCap, Briefcase,
  Dumbbell, ShoppingBag, Navigation, Battery, Clock, Loader2, Share2, MoreHorizontal,
  ChevronDown, Minus, Users, Bell, RefreshCw,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { isManager } from '@/lib/constants/roles';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ErrorState, SkeletonList } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import {
  projectPoints, groupHistoryByDay, arrivalAlerts, batteryTone, sinceLabel,
} from '@/lib/location/overview';
import { updateMyLocation, setLocationSharing, savePlace, deletePlace, setGeofenceEnabled } from '@/app/(app)/dashboard/locator/actions';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type MemberLocation = Tables<'member_locations'>;
type Place = Tables<'family_places'>;
type LocationEvent = Tables<'location_events'>;

const PLACE_ICONS: Record<string, typeof Home> = {
  home: Home, house: Home, school: GraduationCap, work: Briefcase,
  gym: Dumbbell, soccer: Dumbbell, sport: Dumbbell, mall: ShoppingBag, shopping: ShoppingBag, other: MapPin,
};
const PLACE_ICON_BG: Record<string, string> = {
  home: 'bg-emerald-500', house: 'bg-violet-500', school: 'bg-blue-500', work: 'bg-slate-500',
  gym: 'bg-orange-500', soccer: 'bg-orange-500', sport: 'bg-orange-500', mall: 'bg-pink-500', shopping: 'bg-pink-500', other: 'bg-brand',
};
const PLACE_KINDS = ['home', 'house', 'school', 'work', 'gym', 'mall', 'other'];
const MAP_STYLES = [
  { key: 'traffic', label: 'Traffic', bg: 'from-[#12241c] via-[#14202e] to-[#1a1830]' },
  { key: 'standard', label: 'Standard', bg: 'from-[#141a26] via-[#151b28] to-[#1a1622]' },
  { key: 'satellite', label: 'Satellite', bg: 'from-[#0f130f] via-[#131712] to-[#171410]' },
] as const;
const blankPlace = { id: '', name: '', icon: 'home', address: '', latitude: '', longitude: '', radius_m: 150 };
const placeIconFor = (icon: string | null) => PLACE_ICONS[icon ?? 'other'] ?? MapPin;
const placeBgFor = (icon: string | null) => PLACE_ICON_BG[icon ?? 'other'] ?? 'bg-brand';

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { reject(new Error('Geolocation unavailable')); return; }
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  });
}

/** Turn a geolocation failure into a specific, actionable message. */
function geoErrorMessage(err: unknown): string {
  // GeolocationPositionError exposes numeric codes: 1 denied, 2 unavailable, 3 timeout.
  const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code: number }).code : null;
  if (code === 1) return 'Location permission denied — allow it for this site in your browser settings.';
  if (code === 2) return 'Your device couldn’t determine its location. Check that location services are on.';
  if (code === 3) return 'Location request timed out. Please try again.';
  if (err instanceof Error && err.message === 'Geolocation unavailable') return 'This device doesn’t support location sharing.';
  return 'Couldn’t get your location.';
}

export function LocatorModule() {
  const tr = useTranslations();
  const { familyId, members, selfMember, role } = useApp();
  const { success, error: toastError } = useToast();
  const canManage = isManager(role);

  const [sharing, setSharing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [placeModal, setPlaceModal] = useState(false);
  const [placeForm, setPlaceForm] = useState(blankPlace);
  const [savingPlace, setSavingPlace] = useState(false);
  const [focusMember, setFocusMember] = useState<string | null>(null);
  const [mapStyle, setMapStyle] = useState<(typeof MAP_STYLES)[number]['key']>('traffic');
  const [styleOpen, setStyleOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [moreOpen, setMoreOpen] = useState(false);
  const [togglingGeo, setTogglingGeo] = useState<string | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);

  const { data: locations, loading: locationsLoading, error: locationsError, refresh: refreshLocations } = useRealtimeQuery<MemberLocation>({
    table: 'member_locations', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('member_locations').select('*').eq('family_id', familyId),
  });
  const { data: places, loading: placesLoading, error: placesError, refresh: refreshPlaces } = useRealtimeQuery<Place>({
    table: 'family_places', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_places').select('*').eq('family_id', familyId).order('name'),
  });
  const { data: events, loading: eventsLoading, error: eventsError, refresh: refreshEvents } = useRealtimeQuery<LocationEvent>({
    table: 'location_events', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('location_events').select('*').eq('family_id', familyId).order('occurred_at', { ascending: false }).limit(120),
  });

  const locByMember = useMemo(() => new Map((locations ?? []).map((l) => [l.member_id, l])), [locations]);
  const placeById = useMemo(() => new Map((places ?? []).map((p) => [p.id, p])), [places]);
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const memberName = (id: string) => memberById.get(id)?.display_name ?? 'Someone';

  // Members that are actively sharing a coordinate → shown live on the map/list.
  const liveMembers = useMemo(
    () => members.filter((m) => {
      const l = locByMember.get(m.id);
      return l?.is_sharing && l.latitude != null && l.longitude != null;
    }),
    [members, locByMember],
  );

  // Shared projection so places + members sit in the same map viewport.
  const projected = useMemo(() => {
    const pts = [
      ...(places ?? []).map((p) => ({ id: `place:${p.id}`, latitude: p.latitude, longitude: p.longitude })),
      ...liveMembers.map((m) => {
        const l = locByMember.get(m.id)!;
        return { id: `member:${m.id}`, latitude: l.latitude, longitude: l.longitude };
      }),
    ];
    return new Map(projectPoints(pts).map((p) => [p.id, p]));
  }, [places, liveMembers, locByMember]);

  const alerts = useMemo(() => arrivalAlerts(events ?? [], 6), [events]);
  const history = useMemo(() => groupHistoryByDay(
    (events ?? []).map((e) => ({ id: e.id, member_id: e.member_id, place_name: e.place_name, event_type: e.event_type, occurred_at: e.occurred_at })),
    now,
  ), [events, now]);

  useEffect(() => {
    if (selfMember) setSharing(locByMember.get(selfMember.id)?.is_sharing ?? false);
  }, [selfMember, locByMember]);

  const loading = locationsLoading || placesLoading || eventsLoading;
  const readError = locationsError || placesError || eventsError;

  function placeLabel(l: MemberLocation | undefined): string {
    if (!l || !l.is_sharing) return 'Not sharing';
    if (l.place_id && placeById.get(l.place_id)) return placeById.get(l.place_id)!.name;
    if (l.latitude == null) return 'No location';
    return 'On the move';
  }

  async function shareNow() {
    setUpdating(true);
    try {
      const pos = await getPosition();
      const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number }> };
      const battery = nav.getBattery ? await nav.getBattery().then((b) => Math.round(b.level * 100)).catch(() => null) : null;
      const res = await updateMyLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null, battery });
      if (!res.ok) { toastError(res.error ?? 'Failed to update location'); return; }
      setSharing(true);
      void refreshLocations(); void refreshEvents();
      success(res.place ? `Shared — you're at ${res.place}` : 'Location shared');
    } catch (e) {
      toastError(geoErrorMessage(e));
    } finally { setUpdating(false); }
  }

  async function toggleShareOff() {
    const res = await setLocationSharing(false);
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    setSharing(false); void refreshLocations(); success('Location sharing off');
  }

  function refreshAll() {
    void refreshLocations(); void refreshPlaces(); void refreshEvents();
    setNow(new Date()); success('Locations refreshed');
  }

  // ── Places / geofences ────────────────────────────────────
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
    } catch (e) { toastError(geoErrorMessage(e)); }
  }
  async function submitPlace(e: React.FormEvent) {
    e.preventDefault();
    const lat = Number(placeForm.latitude); const lng = Number(placeForm.longitude);
    if (!placeForm.name.trim()) { toastError('Name is required'); return; }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) { toastError('Valid coordinates are required'); return; }
    setSavingPlace(true);
    const res = await savePlace({ id: placeForm.id || undefined, name: placeForm.name.trim(), icon: placeForm.icon, address: placeForm.address.trim() || null, latitude: lat, longitude: lng, radius_m: Number(placeForm.radius_m) || 150 });
    setSavingPlace(false);
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    success(placeForm.id ? 'Place updated' : 'Place added'); setPlaceModal(false); void refreshPlaces();
  }
  async function removePlace(p: Place) {
    if (typeof window !== 'undefined' && !window.confirm(`Delete "${p.name}"?`)) return;
    const res = await deletePlace(p.id);
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    success('Place deleted'); void refreshPlaces();
  }
  async function toggleGeofence(p: Place) {
    if (togglingGeo) return;
    setTogglingGeo(p.id);
    const res = await setGeofenceEnabled(p.id, !p.geofence_enabled);
    setTogglingGeo(null);
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    void refreshPlaces();
  }

  if (loading) return <SkeletonList count={6} />;
  if (readError) return <ErrorState message={tr('locatorModule.couldNotLoadFamilyLocation')} onRetry={() => { void refreshLocations(); void refreshPlaces(); void refreshEvents(); }} />;

  const style = MAP_STYLES.find((s) => s.key === mapStyle) ?? MAP_STYLES[0];

  return (
    <div className="module-with-sidebar" onClick={() => { setStyleOpen(false); setMoreOpen(false); }}>
      <div className="module-main module-page">
        <PageHeader
          title={tr('locator.location')}
          description={tr('locatorModule.seeWhereYourFamilyIs')}
          action={
            <div className="flex items-center gap-2">
              {canManage && <Button onClick={openNewPlace}><Plus className="h-4 w-4" /> {tr('locator.addPlace')}</Button>}
              <Button variant="outline" onClick={() => sharing ? toggleShareOff() : shareNow()} disabled={updating}>
                {updating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
                {sharing ? 'Stop Sharing' : 'Share Location'}
              </Button>
              <div className="relative">
                <Button variant="outline" size="icon" aria-label={tr('locator.moreOptions')} onClick={(e) => { e.stopPropagation(); setMoreOpen((o) => !o); }}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
                {moreOpen && (
                  <div className="absolute right-0 z-30 mt-1 w-48 overflow-hidden rounded-xl border border-border bg-elevated shadow-lg" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => { setMoreOpen(false); refreshAll(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-surface"><RefreshCw className="h-3.5 w-3.5" /> {tr('locator.refreshLocations')}</button>
                    <button onClick={() => { setMoreOpen(false); historyRef.current?.scrollIntoView({ behavior: 'smooth' }); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-surface"><Clock className="h-3.5 w-3.5" /> {tr('locator.locationHistory')}</button>
                    {canManage && <button onClick={() => { setMoreOpen(false); openNewPlace(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-surface"><Plus className="h-3.5 w-3.5" /> {tr('locator.addGeofence')}</button>}
                  </div>
                )}
              </div>
            </div>
          }
        />

        {/* Member chips — only members actively sharing a location get a chip
            (matches the family-map design); everyone else is reachable via
            "All Family". Without this the chip row would render one tile per
            family member, which does not scale for large families. */}
        <div className="flex flex-wrap items-center gap-2">
          {liveMembers.map((m) => {
            const l = locByMember.get(m.id);
            const active = focusMember === m.id;
            return (
              <button key={m.id} onClick={() => setFocusMember(active ? null : m.id)}
                className={cn('flex items-center gap-2 rounded-2xl border px-3 py-1.5 transition',
                  active ? 'border-brand bg-brand/10' : 'border-border bg-surface/40 hover:bg-elevated/40')}>
                <Avatar name={m.display_name} color={m.color} size={28} />
                <span className="text-left leading-tight">
                  <span className="block text-sm font-medium">{firstName(m.display_name)}</span>
                  <span className="block text-[11px] text-muted">{placeLabel(l)}</span>
                </span>
              </button>
            );
          })}
          <button onClick={() => setFocusMember(null)}
            className={cn('flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm transition',
              focusMember === null ? 'border-brand/50 text-fg' : 'border-border text-muted hover:text-fg')}>
            <Users className="h-4 w-4" /> {tr('locator.allFamily')}
          </button>
        </div>

        {/* Map */}
        <div className={cn('relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br', style.bg)} style={{ height: 380 }}>
          {/* faux streets */}
          <svg className="absolute inset-0 h-full w-full opacity-[0.18]" preserveAspectRatio="none">
            <defs><pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="#8aa" strokeWidth="0.5" /></pattern></defs>
            <rect width="100%" height="100%" fill="url(#grid)" />
            <path d="M0 260 Q 300 200 640 300 T 1200 260" fill="none" stroke="#6b8" strokeWidth="2" opacity="0.5" />
            <path d="M420 0 Q 460 200 380 400" fill="none" stroke="#4a90d9" strokeWidth="3" opacity="0.35" />
          </svg>

          {/* Style dropdown */}
          <div className="absolute right-3 top-3 z-10">
            <button onClick={(e) => { e.stopPropagation(); setStyleOpen((o) => !o); }}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-bg/70 px-2.5 py-1.5 text-xs backdrop-blur">
              {style.label} <ChevronDown className="h-3 w-3" />
            </button>
            {styleOpen && (
              <div className="absolute right-0 mt-1 w-32 overflow-hidden rounded-lg border border-border bg-elevated shadow-lg" onClick={(e) => e.stopPropagation()}>
                {MAP_STYLES.map((s) => (
                  <button key={s.key} onClick={() => { setMapStyle(s.key); setStyleOpen(false); }}
                    className={cn('block w-full px-3 py-1.5 text-left text-xs hover:bg-surface', s.key === mapStyle && 'text-brand-text font-semibold')}>{s.label}</button>
                ))}
              </div>
            )}
          </div>

          {/* Zoom + locate */}
          <div className="absolute right-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1.5">
            <button onClick={() => setZoom((z) => Math.min(2, +(z + 0.2).toFixed(2)))} aria-label={tr('locator.zoomIn')} className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-bg/70 backdrop-blur hover:bg-elevated"><Plus className="h-4 w-4" /></button>
            <button onClick={() => setZoom((z) => Math.max(1, +(z - 0.2).toFixed(2)))} aria-label={tr('locator.zoomOut')} className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-bg/70 backdrop-blur hover:bg-elevated"><Minus className="h-4 w-4" /></button>
            <button onClick={shareNow} disabled={updating} aria-label={tr('locator.locateMe')} className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-bg/70 backdrop-blur hover:bg-elevated">{updating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Navigation className="h-4 w-4" />}</button>
          </div>

          {/* Pins */}
          <div className="absolute inset-0 transition-transform duration-300" style={{ transform: `scale(${zoom})` }}>
            {(places ?? []).map((p) => {
              const pt = projected.get(`place:${p.id}`);
              if (!pt) return null;
              const Icon = placeIconFor(p.icon);
              return (
                <div key={p.id} className="absolute flex -translate-x-1/2 -translate-y-full flex-col items-center" style={{ left: `${pt.xPct}%`, top: `${pt.yPct}%` }}>
                  <div className={cn('grid h-9 w-9 place-items-center rounded-full text-white shadow-lg ring-2 ring-bg', placeBgFor(p.icon))}><Icon className="h-4 w-4" /></div>
                  <span className="mt-1 whitespace-nowrap rounded bg-bg/70 px-1.5 py-0.5 text-[11px] font-medium backdrop-blur">{p.name}</span>
                </div>
              );
            })}
            {liveMembers.map((m) => {
              const pt = projected.get(`member:${m.id}`);
              if (!pt) return null;
              const dim = focusMember && focusMember !== m.id;
              return (
                <div key={m.id} className={cn('absolute -translate-x-1/2 -translate-y-1/2 transition-opacity', dim && 'opacity-30')} style={{ left: `${pt.xPct}%`, top: `${pt.yPct}%` }}>
                  <div className={cn('rounded-full ring-2', focusMember === m.id ? 'ring-brand' : 'ring-white/70')}>
                    <Avatar name={m.display_name} color={m.color} size={30} />
                  </div>
                </div>
              );
            })}
          </div>

          <span className="absolute bottom-2 left-3 text-[10px] text-white/50"> {tr('locator.maps')}</span>
          <span className="absolute bottom-2 right-3 text-[10px] text-white/40">{tr('locator.legal')}</span>
        </div>

        {/* Live Locations */}
        <section>
          <h2 className="mb-3 text-base font-semibold">{tr('locator.liveLocations')}</h2>
          <div className="overflow-hidden rounded-2xl border border-border bg-surface/30 divide-y divide-border/50">
            {liveMembers.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted">{tr('locator.noOneIsSharingTheirLocation')} <span className="font-medium text-fg">{tr('locator.shareLocation')}</span> {tr('locator.toStart')}</div>
            ) : liveMembers.map((m) => {
              const l = locByMember.get(m.id)!;
              const tone = batteryTone(l.battery);
              const place = l.place_id ? placeById.get(l.place_id) : null;
              return (
                <div key={m.id} className={cn('flex items-center gap-3 px-4 py-3 transition', focusMember === m.id && 'bg-brand/5')}>
                  <Avatar name={m.display_name} color={m.color} size={40} />
                  <div className="min-w-0 flex-[1.3]">
                    <div className="flex items-center gap-1.5 text-sm font-semibold">{m.display_name}{selfMember?.id === m.id && <span className="text-xs font-normal text-muted">(You)</span>}</div>
                    <div className="flex items-center gap-1 text-xs font-medium text-brand-text"><MapPin className="h-3 w-3" />{place?.name ?? placeLabel(l)}</div>
                  </div>
                  <div className="hidden min-w-0 flex-1 truncate text-sm text-muted sm:block">{l.address ?? place?.address ?? '—'}</div>
                  <div className="w-24 shrink-0 text-right text-xs text-muted">{sinceLabel(l.updated_at, now)}</div>
                  <div className="flex w-16 shrink-0 items-center justify-end gap-1.5">
                    <div className="relative h-3.5 w-7 rounded-[3px] border border-current text-muted">
                      <span className="absolute -right-[3px] top-1/2 h-1.5 w-[2px] -translate-y-1/2 rounded-r bg-current" />
                      <span className={cn('absolute inset-y-[2px] left-[2px] rounded-[1px]',
                        tone === 'ok' ? 'bg-emerald-400' : tone === 'low' ? 'bg-amber-400' : tone === 'critical' ? 'bg-rose-400' : 'bg-muted')}
                        style={{ width: `${Math.max(6, ((l.battery ?? 0) / 100) * 20)}px` }} />
                    </div>
                    <span className="text-xs text-muted">{l.battery != null ? `${l.battery}%` : '—'}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Location History (mobile-visible summary card) */}
        <a href="#geofence-history" onClick={(e) => { e.preventDefault(); historyRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
          className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 px-4 py-3 transition hover:bg-elevated/40 xl:hidden">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-brand/15 text-brand-text"><Clock className="h-4 w-4" /></span>
          <div className="flex-1"><p className="text-sm font-semibold">{tr('locator.locationHistory')}</p><p className="text-xs text-muted">{tr('locator.seeWhereYourFamilyHasBeen')}</p></div>
          <ChevronDown className="h-4 w-4 -rotate-90 text-muted" />
        </a>
      </div>

      {/* Right rail */}
      <aside className="module-sidebar hidden xl:flex xl:flex-col gap-4" ref={historyRef} id="geofence-history">
        {/* Place Alerts */}
        <div className="sidebar-card">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold">{tr('locator.placeAlerts')}</p>
            <button onClick={() => historyRef.current?.scrollIntoView({ behavior: 'smooth' })} className="text-xs font-medium text-brand-text hover:underline">{tr('locator.viewAll')}</button>
          </div>
          <div className="space-y-2.5">
            {alerts.length === 0 ? <p className="text-xs text-muted">{tr('locator.noArrivalsYetToday')}</p> : alerts.map((ev) => {
              const p = ev.place_id ? placeById.get(ev.place_id) : null;
              const Icon = placeIconFor(p?.icon ?? 'other');
              return (
                <div key={ev.id} className="flex items-center gap-2.5">
                  <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-full text-white', placeBgFor(p?.icon ?? 'other'))}><Icon className="h-4 w-4" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{ev.place_name ?? 'A place'}</p>
                    <p className="truncate text-xs text-muted">{memberName(ev.member_id)} arrived</p>
                  </div>
                  <span className="shrink-0 text-[11px] text-muted">{new Date(ev.occurred_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Geofences */}
        <div className="sidebar-card">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold">{tr('locator.geofences')}</p>
            {canManage && <button onClick={openNewPlace} className="text-xs font-medium text-brand-text hover:underline">{tr('locator.manage')}</button>}
          </div>
          <div className="space-y-2.5">
            {(places ?? []).length === 0 ? (
              <p className="text-xs text-muted">{tr('locator.noGeofencesYet')}</p>
            ) : (places ?? []).map((p) => {
              const Icon = placeIconFor(p.icon);
              return (
                <div key={p.id} className="group flex items-center gap-2.5">
                  <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white', placeBgFor(p.icon))}><Icon className="h-4 w-4" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="truncate text-[11px] text-muted">{p.address ?? `${p.radius_m} m radius`}</p>
                  </div>
                  {canManage && (
                    <button onClick={() => openEditPlace(p)} aria-label={`Edit ${p.name}`} className="rounded p-1 text-muted opacity-0 transition group-hover:opacity-100 hover:text-fg"><Pencil className="h-3.5 w-3.5" /></button>
                  )}
                  <button onClick={() => canManage && toggleGeofence(p)} disabled={!canManage || togglingGeo === p.id} aria-label={`Toggle ${p.name} geofence`}
                    className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors', p.geofence_enabled ? 'bg-emerald-500' : 'bg-elevated', !canManage && 'opacity-60')}>
                    <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform', p.geofence_enabled ? 'translate-x-[22px]' : 'translate-x-0.5')} />
                  </button>
                </div>
              );
            })}
          </div>
          {canManage && (
            <button onClick={openNewPlace} className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2 text-xs font-medium text-muted hover:text-fg">
              <Plus className="h-3.5 w-3.5" /> {tr('locator.addGeofence')}
            </button>
          )}
        </div>

        {/* Location History */}
        <div className="sidebar-card">
          <div className="mb-3 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-sm font-semibold"><Bell className="h-4 w-4 text-brand-text" /> {tr('locator.locationHistory')}</p>
          </div>
          {history.length === 0 ? (
            <p className="text-xs text-muted">{tr('locator.noHistoryYet')}</p>
          ) : (
            <div className="space-y-4">
              {history.slice(0, 3).map((day) => (
                <div key={day.key}>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold">{day.label}</span>
                    <span className="text-[11px] text-muted">{day.count} {day.count === 1 ? 'place' : 'places'}</span>
                  </div>
                  {day.label === 'Today' && (
                    <div className="space-y-2.5 border-l border-border/60 pl-3">
                      {day.events.filter((e) => e.event_type === 'arrived').slice(0, 4).map((e, i) => (
                        <div key={e.id} className="relative">
                          <span className={cn('absolute -left-[15px] top-1 h-2 w-2 rounded-full', i === 0 ? 'bg-brand' : 'bg-muted/50')} />
                          <div className="flex items-center justify-between">
                            <span className="text-sm">{e.place_name ?? 'A place'}</span>
                            <span className="text-[11px] text-muted">{new Date(e.occurred_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}{i === 0 ? ' — Now' : ''}</span>
                          </div>
                          <span className="text-[10px] text-muted">{memberName(e.member_id)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* Place modal */}
      <Modal open={placeModal} onClose={() => setPlaceModal(false)} title={placeForm.id ? 'Edit place' : 'Add place'}>
        <form onSubmit={submitPlace} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('locator.name')} required>
              {(id) => <Input id={id} value={placeForm.name} onChange={(e) => setPlaceForm((f) => ({ ...f, name: e.target.value }))} placeholder={tr('locator.home')} autoFocus />}
            </Field>
            <Field label={tr('locator.type')}>
              {(id) => (
                <Select id={id} value={placeForm.icon} onChange={(e) => setPlaceForm((f) => ({ ...f, icon: e.target.value }))}>
                  {PLACE_KINDS.map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}
                </Select>
              )}
            </Field>
          </div>
          <Field label={tr('locator.address')}>
            {(id) => <Input id={id} value={placeForm.address} onChange={(e) => setPlaceForm((f) => ({ ...f, address: e.target.value }))} placeholder={tr('locator.123FamilyWayAustinTx')} />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('locator.latitude')} required>
              {(id) => <Input id={id} value={placeForm.latitude} onChange={(e) => setPlaceForm((f) => ({ ...f, latitude: e.target.value }))} placeholder="30.2672" />}
            </Field>
            <Field label={tr('locator.longitude')} required>
              {(id) => <Input id={id} value={placeForm.longitude} onChange={(e) => setPlaceForm((f) => ({ ...f, longitude: e.target.value }))} placeholder="-97.7431" />}
            </Field>
          </div>
          <div className="flex items-center justify-between">
            <button type="button" onClick={useCurrentForPlace} className="inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">
              <LocateFixed className="h-3.5 w-3.5" /> {tr('locator.useMyCurrentLocation')}
            </button>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">{tr('locator.radius')}</span>
              <Input type="number" min={50} step={50} value={placeForm.radius_m} onChange={(e) => setPlaceForm((f) => ({ ...f, radius_m: Number(e.target.value) }))} className="h-9 w-24" />
              <span className="text-xs text-muted">m</span>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            {placeForm.id && canManage && (
              <Button type="button" variant="ghost" className="mr-auto text-rose-400" onClick={() => { const p = placeById.get(placeForm.id); if (p) { setPlaceModal(false); void removePlace(p); } }}>
                <Trash2 className="h-4 w-4" /> {tr('locator.delete')}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => setPlaceModal(false)}>{tr('locator.cancel')}</Button>
            <Button type="submit" loading={savingPlace}>{savingPlace ? 'Saving…' : placeForm.id ? 'Save changes' : 'Add place'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

