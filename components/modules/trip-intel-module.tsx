'use client';

// Trip Intelligence — the AI travel + smart-departure surface.
// • Auto-detects upcoming calendar events that have a location.
// • "Research" → geocodes the place, pulls the forecast, asks the AI Travel
//   Concierge for restaurant/activity/tip recommendations tuned to family
//   interests, and saves the plan.
// • "Plan departure" → geocodes home + destination, gets a real OSRM driving
//   time, applies live traffic + weather penalties, computes a single leave-by
//   moment, and writes a "🚗 Head out" event onto the calendar.
// • Saved departures show a live countdown + status and a one-tap Refresh that
//   re-checks traffic/weather and keeps the calendar in sync.
// 100% Supabase-wired via server actions; routing/weather/geocoding are keyless.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  MapPin, Plane, Car, Sparkles, Clock, RefreshCw, Trash2, Calendar, Loader2,
  UtensilsCrossed, Compass, Lightbulb, X, CloudSun, Navigation, Users,
} from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { EmptyState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { geocodeCity, fetchForecast, weatherInfo, type Forecast } from '@/lib/weather/open-meteo';
import { driveEstimate, haversineMiles, fallbackDriveSeconds, metersToMiles, type LatLng } from '@/lib/trips/routing';
import {
  computeDeparture, trafficFactorForTime, weatherDelayMinutes, leaveByLabel, departureStatusCopy,
} from '@/lib/trips/departure';
import type { TripRecommendations } from '@/lib/trips/research';
import {
  saveTripPlanAction, deleteTripPlanAction,
  saveDeparturePlanAction, refreshDeparturePlanAction, deleteDeparturePlanAction,
} from '@/app/(app)/dashboard/trip-intel/actions';

export type UpcomingEvent = {
  id: string; title: string; location: string; startsAt: string;
  category: string; memberName: string | null;
};
export type MemberOption = { id: string; name: string; color: string | null };
export type SavedTripPlan = {
  id: string; title: string; destination: string; startDate: string | null; endDate: string | null;
  members: string[]; interests: string | null; weatherSummary: string | null;
  recommendations: TripRecommendations; status: string;
};
export type SavedDeparturePlan = {
  id: string; title: string; origin: string | null; destination: string | null; eventStart: string;
  prepMinutes: number; parkMinutes: number; bufferMinutes: number; driveSeconds: number;
  trafficFactor: number; weatherDelayMinutes: number; weatherSummary: string | null;
  leaveBy: string | null; lastCheckedAt: string | null;
  destLat: number | null; destLng: number | null; originLat: number | null; originLng: number | null;
};

const HOME_KEY = 'bubaly.trip.home';
const INTERESTS_KEY = 'bubaly.trip.interests';

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Derive a weather delay + human summary from a forecast for a target date. */
function weatherForDate(forecast: Forecast | null, targetISO: string): { delay: number; summary: string | null } {
  if (!forecast) return { delay: 0, summary: null };
  const day = targetISO.slice(0, 10);
  const match = forecast.daily.find((d) => d.date === day) ?? forecast.daily[0];
  if (!match) return { delay: 0, summary: null };
  const info = weatherInfo(match.code, true);
  const delay = weatherDelayMinutes(match.code, match.precipProb);
  const summary = `${info.icon} ${info.label}, ${Math.round(match.tempMax)}°/${Math.round(match.tempMin)}°${match.precipProb != null ? `, ${match.precipProb}% precip` : ''}`;
  return { delay, summary };
}

export function TripIntelModule({ upcoming, memberOptions, tripPlans, departurePlans, tablesMissing }: {
  upcoming: UpcomingEvent[];
  memberOptions: MemberOption[];
  tripPlans: SavedTripPlan[];
  departurePlans: SavedDeparturePlan[];
  tablesMissing: boolean;
}) {
  const [researchEvent, setResearchEvent] = useState<UpcomingEvent | null>(null);
  const [departureEvent, setDepartureEvent] = useState<UpcomingEvent | null>(null);

  return (
    <div className="module-page">
      <PageHeader
        title="Trip Intelligence"
        description="AI plans your visits and tells you exactly when to head out — with live traffic & weather."
      />

      {tablesMissing && (
        <div className="mb-5 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <p className="font-semibold">Setup pending</p>
          <p className="text-xs text-muted">Trip Intelligence storage isn&apos;t provisioned on this environment yet. You can still research trips below; saving turns on once the migration is applied.</p>
        </div>
      )}

      {/* Live departures first — they're time-sensitive */}
      {departurePlans.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-muted">
            <Car className="h-4 w-4" /> Smart Departures
          </h2>
          <div className="space-y-3">
            {departurePlans.map((p) => <DepartureCard key={p.id} plan={p} />)}
          </div>
        </section>
      )}

      {/* Upcoming located events */}
      <section className="mb-8">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-muted">
          <Calendar className="h-4 w-4" /> Upcoming with a location
        </h2>
        {upcoming.length === 0 ? (
          <EmptyState icon={MapPin} title="No upcoming events with a location"
            description="Add a location to a calendar event (a trip, a dinner) and it'll show up here for AI research and smart-departure planning." />
        ) : (
          <div className="space-y-2">
            {upcoming.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4">
                <div className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-brand/10 text-brand-text">
                  <MapPin className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{e.title}</p>
                  <p className="truncate text-xs text-muted">
                    {e.location} · {fmtDateTime(e.startsAt)}{e.memberName ? ` · ${e.memberName}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => setResearchEvent(e)}
                    className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:border-brand/40 hover:text-brand-text transition">
                    <Sparkles className="h-3.5 w-3.5" /> Research
                  </button>
                  <button onClick={() => setDepartureEvent(e)}
                    className="flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand/90 transition">
                    <Car className="h-3.5 w-3.5" /> Plan departure
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Saved trip research */}
      {tripPlans.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-muted">
            <Plane className="h-4 w-4" /> Researched trips
          </h2>
          <div className="space-y-3">
            {tripPlans.map((t) => <TripPlanCard key={t.id} plan={t} />)}
          </div>
        </section>
      )}

      {researchEvent && (
        <ResearchModal event={researchEvent} memberOptions={memberOptions} onClose={() => setResearchEvent(null)} canSave={!tablesMissing} />
      )}
      {departureEvent && (
        <DepartureModal event={departureEvent} onClose={() => setDepartureEvent(null)} canSave={!tablesMissing} />
      )}
    </div>
  );
}

// ─── Research Modal ───────────────────────────────────────────────────────────

function ResearchModal({ event, memberOptions, onClose, canSave }: {
  event: UpcomingEvent; memberOptions: MemberOption[]; onClose: () => void; canSave: boolean;
}) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [interests, setInterests] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>(
    event.memberName ? [event.memberName] : memberOptions.map((m) => m.name),
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recs, setRecs] = useState<TripRecommendations | null>(null);
  const [source, setSource] = useState<'ai' | 'fallback' | null>(null);
  const [geo, setGeo] = useState<{ lat: number; lng: number; weather: string | null } | null>(null);

  useEffect(() => {
    try { const v = localStorage.getItem(INTERESTS_KEY); if (v) setInterests(v); } catch { /* ignore */ }
  }, []);

  function toggleMember(name: string) {
    setSelectedMembers((prev) => prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]);
  }

  const research = useCallback(async () => {
    setLoading(true);
    try { localStorage.setItem(INTERESTS_KEY, interests); } catch { /* ignore */ }

    // Geocode the event location + pull a forecast for context.
    let lat: number | null = null, lng: number | null = null, weatherSummary: string | null = null;
    try {
      const hits = await geocodeCity(event.location);
      if (hits[0]) {
        lat = hits[0].latitude; lng = hits[0].longitude;
        const fc = await fetchForecast(lat, lng, 7);
        weatherSummary = weatherForDate(fc, event.startsAt).summary;
      }
    } catch { /* best-effort */ }
    setGeo({ lat: lat ?? 0, lng: lng ?? 0, weather: weatherSummary });

    try {
      const res = await fetch('/api/ai/trip', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destination: event.location, interests, members: selectedMembers,
          startDate: event.startsAt.slice(0, 10), weatherSummary,
        }),
      });
      const json = await res.json();
      if (!res.ok) { toastError(json.error ?? 'Could not research this trip.'); return; }
      setRecs(json.recommendations);
      setSource(json.source);
    } catch {
      toastError('Network problem — please try again.');
    } finally {
      setLoading(false);
    }
  }, [event, interests, selectedMembers, toastError]);

  async function save() {
    if (!recs) return;
    setSaving(true);
    const res = await saveTripPlanAction({
      title: event.title, destination: event.location,
      destLat: geo?.lat || null, destLng: geo?.lng || null,
      startDate: event.startsAt.slice(0, 10), members: selectedMembers,
      interests: interests || null, recommendations: recs,
      weatherSummary: geo?.weather ?? null, eventId: event.id,
    });
    setSaving(false);
    if (!res.ok) return toastError(res.error);
    success('Trip research saved');
    onClose();
    router.refresh();
  }

  return (
    <Modal open onClose={onClose} title={`Research · ${event.location}`} className="max-w-2xl">
      <div className="space-y-4">
        {!recs && (
          <>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">Who&apos;s going?</label>
              <div className="flex flex-wrap gap-1.5">
                {memberOptions.map((m) => {
                  const on = selectedMembers.includes(m.name);
                  return (
                    <button key={m.id} type="button" onClick={() => toggleMember(m.name)}
                      className={cn('flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition',
                        on ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:border-brand/40')}>
                      <Users className="h-3 w-3" /> {m.name}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">What do you like? (food, history, outdoors…)</label>
              <textarea value={interests} onChange={(e) => setInterests(e.target.value)} rows={2}
                placeholder="e.g. great seafood, walkable history, a relaxed pace"
                className="w-full rounded-xl border border-border bg-bg px-3 py-2 text-sm focus-ring" />
            </div>
            <Button onClick={research} loading={loading} className="w-full">
              <Sparkles className="h-4 w-4" /> {loading ? 'Researching…' : 'Research this destination'}
            </Button>
          </>
        )}

        {recs && (
          <div className="space-y-4">
            {source === 'fallback' && (
              <p className="rounded-lg border border-border bg-surface/40 px-3 py-2 text-[11px] text-muted">
                AI isn&apos;t configured — showing general guidance. Connect an AI provider for tailored picks.
              </p>
            )}
            {geo?.weather && (
              <p className="flex items-center gap-1.5 text-xs text-muted"><CloudSun className="h-3.5 w-3.5" /> {geo.weather}</p>
            )}
            {recs.overview && <p className="text-sm">{recs.overview}</p>}

            <RecsView recs={recs} />

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button variant="ghost" onClick={() => { setRecs(null); setSource(null); }}>Back</Button>
              {canSave && <Button onClick={save} loading={saving}>Save trip</Button>}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function RecsView({ recs }: { recs: TripRecommendations }) {
  return (
    <div className="space-y-4">
      {recs.restaurants.length > 0 && (
        <div>
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted">
            <UtensilsCrossed className="h-3.5 w-3.5" /> Eat
          </h4>
          <div className="space-y-1.5">
            {recs.restaurants.map((r, i) => (
              <div key={i} className="rounded-xl border border-border bg-surface/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{r.name}</p>
                  <span className="flex-shrink-0 text-[11px] text-muted">{r.cuisine}{r.priceLevel ? ` · ${r.priceLevel}` : ''}</span>
                </div>
                {r.why && <p className="mt-0.5 text-xs text-muted">{r.why}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
      {recs.activities.length > 0 && (
        <div>
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted">
            <Compass className="h-3.5 w-3.5" /> Do
          </h4>
          <div className="space-y-1.5">
            {recs.activities.map((a, i) => (
              <div key={i} className="rounded-xl border border-border bg-surface/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{a.name}</p>
                  <span className="flex-shrink-0 text-[11px] capitalize text-muted">{a.category}</span>
                </div>
                {a.why && <p className="mt-0.5 text-xs text-muted">{a.why}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
      {recs.tips.length > 0 && (
        <div>
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted">
            <Lightbulb className="h-3.5 w-3.5" /> Tips
          </h4>
          <ul className="space-y-1">
            {recs.tips.map((t, i) => (
              <li key={i} className="flex gap-2 text-xs text-muted"><span className="text-brand-text">•</span> {t}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TripPlanCard({ plan }: { plan: SavedTripPlan }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function remove() {
    setDeleting(true);
    const res = await deleteTripPlanAction({ id: plan.id });
    setDeleting(false);
    if (!res.ok) return toastError(res.error);
    success('Removed');
    router.refresh();
  }

  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-brand/10 text-brand-text"><Plane className="h-5 w-5" /></div>
        <button onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-semibold">{plan.title}</p>
          <p className="truncate text-xs text-muted">
            {plan.destination}{plan.members.length ? ` · ${plan.members.join(', ')}` : ''}
            {plan.startDate ? ` · ${new Date(plan.startDate).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}
          </p>
        </button>
        <button onClick={remove} disabled={deleting} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-danger transition" aria-label="Remove">
          {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
      </div>
      {open && (
        <div className="mt-3 border-t border-border pt-3">
          {plan.weatherSummary && <p className="mb-3 flex items-center gap-1.5 text-xs text-muted"><CloudSun className="h-3.5 w-3.5" /> {plan.weatherSummary}</p>}
          <RecsView recs={plan.recommendations} />
        </div>
      )}
    </div>
  );
}

// ─── Departure Modal ──────────────────────────────────────────────────────────

function DepartureModal({ event, onClose, canSave }: { event: UpcomingEvent; onClose: () => void; canSave: boolean }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [home, setHome] = useState('');
  const [prep, setPrep] = useState(30);
  const [park, setPark] = useState(10);
  const [buffer, setBuffer] = useState(5);
  const [computing, setComputing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<null | {
    driveSeconds: number; trafficFactor: number; weatherDelay: number; weatherSummary: string | null;
    originLL: LatLng | null; destLL: LatLng | null; miles: number | null; usedFallback: boolean;
  }>(null);

  useEffect(() => {
    try { const v = localStorage.getItem(HOME_KEY); if (v) setHome(v); } catch { /* ignore */ }
  }, []);

  const compute = useCallback(async () => {
    if (!home.trim()) return toastError('Enter your starting address or city.');
    setComputing(true);
    try { localStorage.setItem(HOME_KEY, home); } catch { /* ignore */ }

    let originLL: LatLng | null = null, destLL: LatLng | null = null;
    try {
      const [oHits, dHits] = await Promise.all([geocodeCity(home), geocodeCity(event.location)]);
      if (oHits[0]) originLL = { lat: oHits[0].latitude, lng: oHits[0].longitude };
      if (dHits[0]) destLL = { lat: dHits[0].latitude, lng: dHits[0].longitude };
    } catch { /* best-effort */ }

    if (!originLL || !destLL) {
      setComputing(false);
      return toastError('Could not locate one of the addresses. Try a more specific place.');
    }

    // Real driving time (OSRM), with a haversine/avg-speed fallback.
    let driveSeconds = 0, miles: number | null = null, usedFallback = false;
    const est = await driveEstimate(originLL, destLL);
    if (est) { driveSeconds = est.seconds; miles = metersToMiles(est.meters); }
    else {
      miles = haversineMiles(originLL, destLL);
      driveSeconds = fallbackDriveSeconds(miles);
      usedFallback = true;
    }

    // Live traffic factor for the departure window + weather penalty at the dest.
    const trafficFactor = trafficFactorForTime(event.startsAt);
    const fc = await fetchForecast(destLL.lat, destLL.lng, 7);
    const { delay: weatherDelay, summary: weatherSummary } = weatherForDate(fc, event.startsAt);

    setResult({ driveSeconds, trafficFactor, weatherDelay, weatherSummary, originLL, destLL, miles, usedFallback });
    setComputing(false);
  }, [home, event, toastError]);

  const plan = useMemo(() => result ? computeDeparture({
    eventStartISO: event.startsAt, driveSeconds: result.driveSeconds, prepMinutes: prep, parkMinutes: park,
    trafficFactor: result.trafficFactor, weatherDelayMinutes: result.weatherDelay, bufferMinutes: buffer, now: new Date(),
  }) : null, [result, event.startsAt, prep, park, buffer]);

  async function save() {
    if (!result || !plan) return;
    setSaving(true);
    const res = await saveDeparturePlanAction({
      title: event.title, eventId: event.id, eventStart: event.startsAt,
      origin: home, originLat: result.originLL?.lat ?? null, originLng: result.originLL?.lng ?? null,
      destination: event.location, destLat: result.destLL?.lat ?? null, destLng: result.destLL?.lng ?? null,
      prepMinutes: prep, parkMinutes: park, bufferMinutes: buffer,
      driveSeconds: result.driveSeconds, trafficFactor: result.trafficFactor,
      weatherDelayMinutes: result.weatherDelay, weatherSummary: result.weatherSummary,
    });
    setSaving(false);
    if (!res.ok) return toastError(res.error);
    success('Added to your calendar — we’ll tell you when to head out');
    onClose();
    router.refresh();
  }

  const numCls = 'h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm focus-ring';

  return (
    <Modal open onClose={onClose} title={`Plan departure · ${event.title}`}>
      <div className="space-y-4">
        <div className="rounded-xl border border-brand/20 bg-brand/5 px-4 py-2.5 text-sm">
          <p className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5 text-brand-text" /> {event.location}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted"><Clock className="h-3.5 w-3.5" /> Arrive by {fmtDateTime(event.startsAt)}</p>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted">Starting from (home address or city)</label>
          <input value={home} onChange={(e) => setHome(e.target.value)} placeholder="e.g. 123 Main St, Atlanta GA"
            className="h-10 w-full rounded-xl border border-border bg-bg px-3 text-sm focus-ring" />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Get ready (min)</span>
            <input type="number" min="0" max="240" value={prep} onChange={(e) => setPrep(Math.max(0, Number(e.target.value)))} className={numCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Park & walk (min)</span>
            <input type="number" min="0" max="120" value={park} onChange={(e) => setPark(Math.max(0, Number(e.target.value)))} className={numCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Arrive early (min)</span>
            <input type="number" min="0" max="120" value={buffer} onChange={(e) => setBuffer(Math.max(0, Number(e.target.value)))} className={numCls} />
          </label>
        </div>

        <Button onClick={compute} loading={computing} variant={result ? 'secondary' : 'primary'} className="w-full">
          <Navigation className="h-4 w-4" /> {computing ? 'Checking traffic & weather…' : result ? 'Recheck' : 'Calculate when to leave'}
        </Button>

        {result && plan && (
          <div className="space-y-3 rounded-2xl border border-border bg-surface/40 p-4">
            <div className="text-center">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Leave by</p>
              <p className="text-3xl font-black">{fmtTime(plan.leaveByISO)}</p>
              <p className="text-xs text-muted">{leaveByLabel(plan.minutesUntilLeave)} · start getting ready at {fmtTime(plan.getReadyByISO)}</p>
            </div>
            <div className="space-y-1 border-t border-border pt-3">
              {plan.breakdown.map((b) => (
                <div key={b.label} className="flex items-center justify-between text-xs">
                  <span className="text-muted">{b.label}</span>
                  <span className="font-medium">{b.minutes} min</span>
                </div>
              ))}
              <div className="flex items-center justify-between border-t border-border/50 pt-1 text-xs font-semibold">
                <span>Total travel</span><span>{plan.totalTravelMinutes} min</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
              {result.miles != null && <span>📍 {result.miles} mi</span>}
              <span>🚦 traffic ×{result.trafficFactor.toFixed(2)}</span>
              {result.weatherSummary && <span>{result.weatherSummary}</span>}
              {result.usedFallback && <span className="text-amber-500">estimated route</span>}
            </div>
            {canSave && (
              <Button onClick={save} loading={saving} className="w-full">
                <Calendar className="h-4 w-4" /> Add &ldquo;head out&rdquo; to calendar
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─── Live Departure Card (saved) ──────────────────────────────────────────────

function DepartureCard({ plan }: { plan: SavedDeparturePlan }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // Live countdown — re-render each minute.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const live = useMemo(() => computeDeparture({
    eventStartISO: plan.eventStart, driveSeconds: plan.driveSeconds, prepMinutes: plan.prepMinutes,
    parkMinutes: plan.parkMinutes, trafficFactor: plan.trafficFactor, weatherDelayMinutes: plan.weatherDelayMinutes,
    bufferMinutes: plan.bufferMinutes, now,
  }), [plan, now]);

  const copy = departureStatusCopy(live.status);
  const toneCls = copy.tone === 'urgent' ? 'border-danger/40 bg-danger/5' :
    copy.tone === 'warn' ? 'border-amber-500/40 bg-amber-500/5' :
    copy.tone === 'muted' ? 'border-border bg-surface/30 opacity-70' : 'border-emerald-500/30 bg-emerald-500/5';
  const chipCls = copy.tone === 'urgent' ? 'bg-danger/15 text-danger' :
    copy.tone === 'warn' ? 'bg-amber-500/15 text-amber-600' :
    copy.tone === 'muted' ? 'bg-border/60 text-muted' : 'bg-emerald-500/15 text-emerald-500';

  // Re-check live traffic + weather, then persist + sync the calendar.
  async function refresh() {
    setRefreshing(true);
    try {
      let driveSeconds = plan.driveSeconds;
      if (plan.originLat != null && plan.originLng != null && plan.destLat != null && plan.destLng != null) {
        const est = await driveEstimate(
          { lat: plan.originLat, lng: plan.originLng },
          { lat: plan.destLat, lng: plan.destLng },
        );
        if (est) driveSeconds = est.seconds;
      }
      const trafficFactor = trafficFactorForTime(plan.eventStart);
      let weatherDelay = plan.weatherDelayMinutes, weatherSummary = plan.weatherSummary;
      if (plan.destLat != null && plan.destLng != null) {
        const fc = await fetchForecast(plan.destLat, plan.destLng, 7);
        const day = plan.eventStart.slice(0, 10);
        const match = fc?.daily.find((d) => d.date === day) ?? fc?.daily[0];
        if (match) {
          const info = weatherInfo(match.code, true);
          weatherDelay = weatherDelayMinutes(match.code, match.precipProb);
          weatherSummary = `${info.icon} ${info.label}, ${Math.round(match.tempMax)}°/${Math.round(match.tempMin)}°`;
        }
      }
      const res = await refreshDeparturePlanAction({ id: plan.id, driveSeconds, trafficFactor, weatherDelayMinutes: weatherDelay, weatherSummary });
      if (!res.ok) { toastError(res.error); return; }
      success('Updated with live traffic & weather');
      router.refresh();
    } finally {
      setRefreshing(false);
    }
  }

  async function remove() {
    setDeleting(true);
    const res = await deleteDeparturePlanAction({ id: plan.id });
    setDeleting(false);
    if (!res.ok) return toastError(res.error);
    success('Removed');
    router.refresh();
  }

  return (
    <div className={cn('rounded-2xl border p-4 transition', toneCls)}>
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-bg/60 text-brand-text"><Car className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">{plan.title}</p>
            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide', chipCls)}>{copy.label}</span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted">
            {plan.destination} · arrive by {fmtTime(plan.eventStart)}
          </p>
          {plan.leaveBy && (
            <p className="mt-1.5 text-sm font-bold">
              {live.status === 'arrived' ? 'Event has passed' : <>Leave by {fmtTime(plan.leaveBy)} · <span className="text-brand-text">{leaveByLabel(live.minutesUntilLeave)}</span></>}
            </p>
          )}
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
            <span>🚗 {live.driveMinutesAdjusted} min drive</span>
            <span>🚦 ×{plan.trafficFactor.toFixed(2)}</span>
            {plan.weatherSummary && <span>{plan.weatherSummary}</span>}
            {plan.lastCheckedAt && <span>· checked {fmtTime(plan.lastCheckedAt)}</span>}
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-col gap-1">
          <button onClick={refresh} disabled={refreshing} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-brand-text transition" aria-label="Refresh live intel">
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
          <button onClick={remove} disabled={deleting} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-danger transition" aria-label="Remove">
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
