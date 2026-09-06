'use client';

import { useEffect, useMemo, useState } from 'react';
import { CalendarHeart, MapPin, Search, ExternalLink, Star, Clock, Navigation, Sparkles, Rss, Plus, Trash2, ChevronDown } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Input, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { RADIUS_OPTIONS, DEFAULT_RADIUS, DEFAULT_DAYS, categoryMeta, priceRange, isValidZip, PLAN_STATUSES } from '@/lib/weekend/meta';
import type { Tables, WeekendPlanStatus, WeekendFeedKind } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Event = Tables<'weekend_events'>;
type Plan = Tables<'weekend_plans'>;
type SearchRow = Tables<'weekend_searches'>;
type Feed = Tables<'weekend_feeds'>;

function sourceLabel(source: string): string {
  if (source === 'ticketmaster') return 'Ticketmaster';
  if (source === 'seatgeek') return 'SeatGeek';
  if (source.startsWith('feed:')) return source.slice(5);
  return source;
}

const dayKey = (iso: string) => iso.slice(0, 10);
const fmtDay = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'Time TBA');

export function WeekendModule() {
  const t = useTranslations();
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const { data: events, loading: eventsLoading, error: eventsError, refresh: refreshEvents } = useRealtimeQuery<Event>({
    table: 'weekend_events', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('weekend_events').select('*').eq('family_id', familyId),
  });
  const { data: plans, loading: plansLoading, error: plansError, refresh: refreshPlans } = useRealtimeQuery<Plan>({
    table: 'weekend_plans', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('weekend_plans').select('*').eq('family_id', familyId),
  });
  const { data: searches, loading: searchesLoading, error: searchesError, refresh: refreshSearches } = useRealtimeQuery<SearchRow>({
    table: 'weekend_searches', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('weekend_searches').select('*').eq('family_id', familyId),
  });
  const { data: feeds, loading: feedsLoading, error: feedsError, refresh: refreshFeeds } = useRealtimeQuery<Feed>({
    table: 'weekend_feeds', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('weekend_feeds').select('*').eq('family_id', familyId),
  });

  const loading = eventsLoading || plansLoading || searchesLoading || feedsLoading;
  const error = eventsError || plansError || searchesError || feedsError;
  const refresh = () => { void refreshEvents(); void refreshPlans(); void refreshSearches(); void refreshFeeds(); };

  const [zip, setZip] = useState('');
  const [radius, setRadius] = useState<number>(DEFAULT_RADIUS);
  const [days, setDays] = useState<number>(DEFAULT_DAYS);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [feedForm, setFeedForm] = useState({ label: '', url: '', kind: 'ics' as WeekendFeedKind });

  // Seed inputs from the most recent search once it loads.
  useEffect(() => {
    if (touched || searches.length === 0) return;
    const latest = [...searches].sort((a, b) => (a.last_run_at < b.last_run_at ? 1 : -1))[0];
    if (latest) { setZip(latest.zip); setRadius(latest.radius_miles); setDays(latest.days); }
  }, [searches, touched]);

  const planByEvent = useMemo(() => new Map(plans.map((p) => [p.event_id, p])), [plans]);

  // Upcoming events within the chosen window, grouped by day.
  const grouped = useMemo(() => {
    const now = Date.now();
    const horizon = now + days * 86_400_000;
    const upcoming = events
      .filter((e) => e.starts_at && new Date(e.starts_at).getTime() >= now - 3_600_000 && new Date(e.starts_at).getTime() <= horizon)
      .sort((a, b) => (a.starts_at! < b.starts_at! ? -1 : 1));
    const m = new Map<string, Event[]>();
    for (const e of upcoming) { const k = dayKey(e.starts_at!); if (!m.has(k)) m.set(k, []); m.get(k)!.push(e); }
    return [...m.entries()];
  }, [events, days]);

  const savedEvents = useMemo(() => {
    const byId = new Map(events.map((e) => [e.id, e]));
    return plans.map((p) => ({ plan: p, event: byId.get(p.event_id) })).filter((x) => x.event) as { plan: Plan; event: Event }[];
  }, [plans, events]);

  async function discover() {
    if (!isValidZip(zip)) return toastError('Enter a valid 5-digit ZIP code');
    setBusy(true);
    try {
      const res = await fetch('/api/weekend/discover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ zip, radius, days }) });
      const data = await res.json();
      if (!res.ok) toastError(data.error || 'Search failed');
      else success(data.count > 0 ? `Found ${data.count} events near ${data.zip}` : `No events found near ${data.zip} in the next ${data.days} days`);
    } catch { toastError('Network error'); }
    setBusy(false);
  }

  async function setStatus(event: Event, status: WeekendPlanStatus) {
    const existing = planByEvent.get(event.id);
    const sb = createClient();
    const { error } = existing
      ? await sb.from('weekend_plans').update({ status }).eq('id', existing.id)
      : await sb.from('weekend_plans').insert({ family_id: familyId, event_id: event.id, status, created_by: userId });
    if (error) toastError(describeDbError(error)); else success(existing ? 'Updated' : 'Saved to plans');
  }
  async function removePlan(id: string) {
    const { error } = await createClient().from('weekend_plans').delete().eq('id', id);
    if (error) toastError(describeDbError(error)); else success('Removed');
  }

  async function addFeed(e: React.FormEvent) {
    e.preventDefault();
    if (!feedForm.label.trim() || !feedForm.url.trim()) return toastError('Name and URL required');
    try { new URL(feedForm.url.trim()); } catch { return toastError('Enter a valid URL'); }
    const { error } = await createClient().from('weekend_feeds').insert({ family_id: familyId, label: feedForm.label.trim(), url: feedForm.url.trim(), kind: feedForm.kind, created_by: userId });
    if (error) toastError(describeDbError(error)); else { success('Source added'); setFeedForm({ label: '', url: '', kind: 'ics' }); }
  }
  async function toggleFeed(f: Feed) {
    await createClient().from('weekend_feeds').update({ is_active: !f.is_active }).eq('id', f.id);
  }
  async function removeFeed(id: string) {
    if (!confirm('Remove this source?')) return;
    await createClient().from('weekend_feeds').delete().eq('id', id);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold"><CalendarHeart className="h-6 w-6 text-brand-text" /> {t('weekend.weekendPlanner')}</h1>
        <p className="text-sm text-muted">{t('weekend.typeAZipCodePickHow')}</p>
      </div>

      {/* search bar */}
      <div className="rounded-2xl border border-border bg-surface/40 p-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]">
          <div className="flex items-center gap-2 rounded-xl border border-border bg-surface/60 px-3">
            <MapPin className="h-4 w-4 shrink-0 text-muted" />
            <Input value={zip} inputMode="numeric" maxLength={5} placeholder={t('weekend.zipCodeEG90210')}
              onChange={(e) => { setTouched(true); setZip(e.target.value.replace(/\D/g, '').slice(0, 5)); }}
              onKeyDown={(e) => e.key === 'Enter' && discover()}
              className="h-11 border-0 bg-transparent px-1" />
          </div>
          <Select value={String(radius)} onChange={(e) => { setTouched(true); setRadius(Number(e.target.value)); }} className="h-11 sm:w-36">
            {RADIUS_OPTIONS.map((r) => <option key={r} value={r}>{t('weekend.within')} {r} mi</option>)}
          </Select>
          <Select value={String(days)} onChange={(e) => { setTouched(true); setDays(Number(e.target.value)); }} className="h-11 sm:w-36">
            {[3, 6, 10, 14].map((d) => <option key={d} value={d}>{t('weekend.next')} {d} days</option>)}
          </Select>
          <Button onClick={discover} loading={busy} className="h-11"><Search className="h-4 w-4" /> {t('weekend.findEvents')}</Button>
        </div>
        <button onClick={() => setShowSources((s) => !s)} className="mt-3 flex items-center gap-1 text-xs text-muted hover:text-fg">
          <Rss className="h-3.5 w-3.5" /> {t('weekend.localSources')}{feeds.length ? ` (${feeds.filter((f) => f.is_active).length} active)` : ''}
          <ChevronDown className={`h-3.5 w-3.5 transition ${showSources ? 'rotate-180' : ''}`} />
        </button>
        {showSources && (
          <div className="mt-3 space-y-3 border-t border-border pt-3">
            <p className="text-xs text-muted">{t('weekend.addAnyReliableLocalCalendarA')} <strong>.ics</strong> or <strong>RSS</strong> {t('weekend.linkWeCrawlThemAlongsideTicketmaster')}</p>
            {feeds.length > 0 && (
              <ul className="space-y-1.5">
                {feeds.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-surface/60 p-2 text-sm">
                    <input type="checkbox" checked={f.is_active} onChange={() => toggleFeed(f)} className="h-4 w-4 rounded border-border" title={t('weekend.active')} />
                    <span className="font-medium">{f.label}</span>
                    <span className="rounded bg-elevated px-1.5 py-0.5 text-[10px] uppercase text-muted">{f.kind}</span>
                    {f.last_status && <span className={`text-[11px] ${f.last_status === 'ok' ? 'text-emerald-400' : 'text-rose-400'}`}>{f.last_status === 'ok' ? `✓ ${f.last_count} found` : `⚠ ${f.last_status}`}</span>}
                    <a href={f.url} target="_blank" rel="noopener noreferrer" className="truncate text-xs text-muted hover:text-brand-text">{f.url}</a>
                    <button onClick={() => removeFeed(f.id)} className="ml-auto text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></button>
                  </li>
                ))}
              </ul>
            )}
            <form onSubmit={addFeed} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto_auto]">
              <Input value={feedForm.label} onChange={(e) => setFeedForm({ ...feedForm, label: e.target.value })} placeholder={t('weekend.nameEGCityCalendar')} className="h-9" />
              <Input value={feedForm.url} onChange={(e) => setFeedForm({ ...feedForm, url: e.target.value })} placeholder="https://…/events.ics" className="h-9" />
              <Select value={feedForm.kind} onChange={(e) => setFeedForm({ ...feedForm, kind: e.target.value as WeekendFeedKind })} className="h-9 sm:w-24"><option value="ics">ICS</option><option value="rss">RSS</option></Select>
              <Button type="submit" size="sm" className="h-9"><Plus className="h-4 w-4" /> Add</Button>
            </form>
          </div>
        )}
      </div>

      {/* saved plans */}
      {savedEvents.length > 0 && (
        <div className="rounded-2xl border border-brand/30 bg-brand/5 p-4">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-brand-text"><Star className="h-4 w-4" /> {t('weekend.yourShortlist')}{savedEvents.length})</h2>
          <ul className="space-y-2">
            {savedEvents.map(({ plan, event }) => {
              const st = PLAN_STATUSES.find((s) => s.value === plan.status)!;
              return (
                <li key={plan.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface/60 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{categoryMeta(event.category).emoji} {event.title}</p>
                    <p className="text-xs text-muted">{event.starts_at ? `${fmtDay(dayKey(event.starts_at))} · ${fmtTime(event.starts_at)}` : 'Date TBA'}{event.venue_name ? ` · ${event.venue_name}` : ''}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <select value={plan.status} onChange={(e) => setStatus(event, e.target.value as WeekendPlanStatus)} className="h-8 rounded-lg border border-border bg-surface px-2 text-xs">
                      {PLAN_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${st.tone}`}>{st.label}</span>
                    <button onClick={() => removePlan(plan.id)} className="text-xs text-muted hover:text-danger">{t('weekend.remove')}</button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* discovered events grouped by day */}
      {loading ? <SkeletonList /> : error ? <ErrorState message="Could not load weekend planner data. Refresh and try again." onRetry={refresh} /> : grouped.length === 0 ? (
        <EmptyState icon={Sparkles} title={t('weekend.noUpcomingEventsYet')} description="Enter your ZIP code and tap Find events to pull real local happenings from Ticketmaster." />
      ) : (
        <div className="space-y-6">
          {grouped.map(([day, dayEvents]) => (
            <div key={day}>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted"><Clock className="h-4 w-4" /> {fmtDay(day)} · {dayEvents.length} event{dayEvents.length > 1 ? 's' : ''}</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {dayEvents.map((e) => {
                  const cat = categoryMeta(e.category);
                  const saved = planByEvent.get(e.id);
                  const price = priceRange(e.price_min_cents, e.price_max_cents);
                  return (
                    <div key={e.id} className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface/40">
                      {e.image_url
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={e.image_url} alt="" className="h-32 w-full object-cover" loading="lazy" />
                        : <div className="grid h-32 w-full place-items-center bg-elevated text-3xl">{cat.emoji}</div>}
                      <div className="flex flex-1 flex-col p-3">
                        <div className="mb-1 flex flex-wrap items-center gap-1.5">
                          <span className="rounded-full bg-elevated px-2 py-0.5 text-[10px] font-medium text-muted">{cat.emoji} {cat.label}</span>
                          {e.is_family_friendly && <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-medium text-blue-300">{t('weekend.family')}</span>}
                          <span className="rounded-full bg-elevated px-2 py-0.5 text-[10px] text-muted">{sourceLabel(e.source)}</span>
                        </div>
                        <p className="line-clamp-2 font-semibold">{e.title}</p>
                        <p className="mt-1 text-xs text-muted">{fmtTime(e.starts_at)}{e.venue_name ? ` · ${e.venue_name}` : ''}</p>
                        <p className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                          {e.distance_miles != null && <span className="flex items-center gap-0.5"><Navigation className="h-3 w-3" /> {e.distance_miles} mi</span>}
                          {price && <span>· {price}</span>}
                          {e.city && <span>· {e.city}{e.region ? `, ${e.region}` : ''}</span>}
                        </p>
                        <div className="mt-auto flex items-center gap-2 pt-3">
                          {saved ? (
                            <span className="flex items-center gap-1 text-xs font-medium text-brand-text"><Star className="h-3.5 w-3.5 fill-current" /> {PLAN_STATUSES.find((s) => s.value === saved.status)!.label}</span>
                          ) : (
                            <Button size="sm" variant="secondary" onClick={() => setStatus(e, 'interested')}><Star className="h-3.5 w-3.5" /> {t('weekend.save')}</Button>
                          )}
                          {e.url && <a href={e.url} target="_blank" rel="noopener noreferrer" className="ml-auto flex items-center gap-1 text-xs text-brand-text hover:underline">{t('weekend.tickets')} <ExternalLink className="h-3 w-3" /></a>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
