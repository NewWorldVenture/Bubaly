'use client';

import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  Calendar, CheckCircle2, ShoppingCart, UtensilsCrossed, Cake, Bell, StickyNote,
  Users, CloudSun, Clock, Sparkles, Pencil, Plus, Trash2, ArrowUp, ArrowDown, Check, X,
  Maximize2, Minimize2, Settings2, Sun, Moon, ArrowRight, Timer as TimerIcon,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/avatar';
import { fmtTime } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import {
  ambientTheme, greeting, dayPart, nowAndNext, countdownLabel, normalizeSettings, buildHints,
  DEFAULT_DISPLAY_SETTINGS, THEME_OPTIONS, IDLE_OPTIONS,
  type DisplaySettings, type ThemeChoice,
} from '@/lib/display/ambient';
import { DEFAULT_TILES, resolveTiles, tileListLimit, SERVICE_WIDGET, type Tile, type TileSize, type WidgetKey } from '@/lib/display/tiles';
import { ALL_SERVICES_CATALOG, ALL_SERVICES_BY_HREF } from '@/lib/constants/navigation';
import { recipeImage, mealImage, AMBIENT_FALLBACK_PHOTOS } from '@/lib/display/imagery';
import { AmbientClock } from './ambient-clock';
import { DisplayWeatherProvider, WeatherChip, WeatherTile } from './display-weather';
import { KitchenTimers } from './kitchen-timers';
import { PhotoFrame } from './photo-frame';
import { HintsTicker } from './hints-ticker';

// ── Types ────────────────────────────────────────────────────────────────────
type Ev = { id: string; title: string; starts_at: string; all_day: boolean; location: string | null; assignee_id: string | null };
type FeaturedItem = { name: string; category: string | null; imageUrl: string | null };

export type DisplayData = {
  familyName: string;
  members: { id: string; display_name: string; color: string | null; role: string }[];
  events: Ev[];
  upcoming: Ev[];
  chores: { id: string; status: string; member_id: string; title: string }[];
  meals: { type: string; name: string }[];
  grocery: { items: { id: string; name: string }[]; count: number };
  reminders: { id: string; title: string; remind_at: string }[];
  birthdays: { name: string; date: string }[];
  notes: { id: string; title: string | null; body: string }[];
  featured: FeaturedItem[];
  photos: string[];
  calendar: { year: number; month: number; today: number; eventDays: number[] };
};

// The tile model + layout normalization live in lib/display/tiles (pure,
// tested) — the stored layout is untrusted jsonb and MUST be resolved through
// resolveTiles before render (a malformed element crashes SSR, where widget
// boundaries can't catch). Re-exported here for existing importers.
export { DEFAULT_TILES, resolveTiles } from '@/lib/display/tiles';
export type { Tile, WidgetKey } from '@/lib/display/tiles';

export const WIDGETS: { key: WidgetKey; label: string; icon: typeof Calendar }[] = [
  { key: 'featured', label: 'Featured', icon: Sparkles },
  { key: 'timers', label: 'Kitchen Timers', icon: TimerIcon },
  { key: 'schedule', label: "Today's Schedule", icon: Calendar },
  { key: 'upcoming', label: 'Upcoming Events', icon: Calendar },
  { key: 'calendar', label: 'Month Calendar', icon: Calendar },
  { key: 'weather', label: 'Weather', icon: CloudSun },
  { key: 'clock', label: 'Clock', icon: Clock },
  { key: 'chores', label: 'Chores', icon: CheckCircle2 },
  { key: 'meals', label: 'Meals', icon: UtensilsCrossed },
  { key: 'grocery', label: 'Grocery List', icon: ShoppingCart },
  { key: 'members', label: 'Family Members', icon: Users },
  { key: 'reminders', label: 'Reminders', icon: Bell },
  { key: 'birthdays', label: 'Birthdays', icon: Cake },
  { key: 'notes', label: 'Notes', icon: StickyNote },
];
const widgetLabel = (k: WidgetKey) => WIDGETS.find((w) => w.key === k)?.label ?? k;

const SIZES: { key: TileSize; label: string; cls: string }[] = [
  { key: 'sm', label: 'Small', cls: 'lg:col-span-2 lg:row-span-1' },
  { key: 'md', label: 'Medium', cls: 'lg:col-span-2 lg:row-span-2' },
  { key: 'lg', label: 'Large', cls: 'lg:col-span-3 lg:row-span-2' },
  { key: 'wide', label: 'Wide', cls: 'lg:col-span-4 lg:row-span-1' },
  { key: 'hero', label: 'Hero', cls: 'lg:col-span-4 lg:row-span-3' },
];
const sizeClass = (s: TileSize) => SIZES.find((x) => x.key === s)?.cls ?? SIZES[0].cls;

const MEAL_EMOJIS: Record<string, string> = { breakfast: '🍳', lunch: '🥗', dinner: '🍽️', snack: '🍎' };
const uid = () => Math.random().toString(36).slice(2, 9);

/** First name from a possibly-null display_name — a null column value once
 *  crashed the whole kiosk via `.split` on null. Never throws. */
const firstName = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] || 'Member';

// ── Rotating featured hero ───────────────────────────────────────────────────
function FeaturedWidget({ list, familyName }: { list: FeaturedItem[]; familyName: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (list.length < 2) return;
    const t = setInterval(() => setI((v) => (v + 1) % list.length), 12_000);
    return () => clearInterval(t);
  }, [list.length]);
  const fr = list[i] ?? null;
  // Always photographic: each recipe gets its own photo or a curated dish photo
  // matched by name/category; the empty welcome state gets a warm home scene.
  const photos = list.length
    ? list.map((item) => recipeImage(item.name, item.category, item.imageUrl))
    : [AMBIENT_FALLBACK_PHOTOS[0]];
  const active = fr ? i % photos.length : 0;
  return (
    <div className="relative -m-5 flex h-[calc(100%+2.5rem)] flex-col justify-end overflow-hidden rounded-[2rem] p-6">
      {/* Stacked crossfade so rotating recipes blend instead of snapping */}
      {photos.map((url, idx) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={idx} src={url} alt="" aria-hidden
          className="absolute inset-0 h-full w-full object-cover transition-opacity duration-1000"
          style={{ opacity: idx === active ? 1 : 0 }} />
      ))}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />
      <div className="relative">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">{fr ? 'Featured Recipe' : 'Welcome home'}</p>
        <p className="mt-1 text-4xl font-black leading-tight text-white lg:text-5xl">{fr?.name ?? familyName}</p>
        {fr?.category && <p className="mt-1 text-sm capitalize text-white/70">{fr.category}</p>}
      </div>
      {list.length > 1 && (
        <div className="absolute right-5 top-5 flex gap-1.5">
          {list.map((_, idx) => (
            <span key={idx} className={cn('h-1.5 rounded-full transition-all', idx === i ? 'w-5 bg-white' : 'w-1.5 bg-white/40')} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Widget bodies ─────────────────────────────────────────────────────────────
// `size` makes every widget DYNAMIC to the tile it's in: a compact tile shows a
// condensed layout / fewer rows (so it never clips), a taller tile shows more.
// ── Service launcher tile — ANY app feature can live on the display ──────────
function ServiceTile({ href }: { href: string }) {
  const item = ALL_SERVICES_BY_HREF.get(href);
  const Icon = item?.icon ?? Sparkles;
  const label = item?.label
    ?? (href.split('/').filter(Boolean).pop() ?? 'Open')
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <Link
      href={href}
      className="group flex h-full min-h-0 flex-col items-center justify-center gap-2 text-center transition hover:bg-white/5"
    >
      <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-white/20 to-white/5 ring-1 ring-white/15 transition group-hover:scale-105">
        <Icon className="h-7 w-7 text-white" />
      </span>
      <span className="max-w-full truncate px-2 text-sm font-bold text-white">{label}</span>
      <span className="inline-flex items-center gap-1 text-[11px] text-white/45 transition group-hover:text-white/70">
        Open <ArrowRight className="h-3 w-3" />
      </span>
    </Link>
  );
}

function WidgetBody({ widget, size, data, memberById, now }: {
  widget: WidgetKey; size: TileSize; data: DisplayData; memberById: Map<string, DisplayData['members'][number]>; now: Date;
}) {
  switch (widget) {
    case 'clock': return <AmbientClock clock24={false} seconds={false} />;
    case 'weather': return <WeatherTile size={size} />;
    case 'timers': return <KitchenTimers />;
    case 'featured': return <FeaturedWidget list={data.featured} familyName={data.familyName} />;

    case 'schedule': {
      const { current, next } = nowAndNext(data.events, now);
      return data.events.length ? (
        <ul className="space-y-2.5">
          {data.events.slice(0, tileListLimit(size, 4)).map((e) => {
            const who = e.assignee_id ? memberById.get(e.assignee_id) : undefined;
            const isNow = current?.id === e.id;
            const isNext = next?.id === e.id;
            return (
              <li key={e.id} className={cn('flex items-center gap-3 rounded-xl px-2 py-1.5', isNow && 'bg-white/10')}>
                <span className={cn('w-16 shrink-0 text-sm font-bold tabular-nums', isNow ? 'text-emerald-300' : 'text-violet-300')}>
                  {e.all_day ? 'All day' : fmtTime(e.starts_at)}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-white">{e.title}</span>
                {isNow && <span className="shrink-0 rounded-full bg-emerald-400/20 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300">Now</span>}
                {isNext && !isNow && <span className="shrink-0 text-[11px] text-white/50">{countdownLabel(e.starts_at, now)}</span>}
                {who && <Avatar name={who.display_name} color={who.color} size={24} />}
              </li>
            );
          })}
        </ul>
      ) : <Empty icon={Calendar} text="Nothing scheduled today" />;
    }

    case 'upcoming':
      return data.upcoming.length ? (
        <ul className="space-y-2">
          {data.upcoming.slice(0, tileListLimit(size, 4)).map((e) => (
            <li key={e.id} className="flex items-center gap-3 text-sm">
              <span className="w-24 shrink-0 text-white/50">{new Date(e.starts_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
              <span className="min-w-0 flex-1 truncate font-medium text-white">{e.title}</span>
            </li>
          ))}
        </ul>
      ) : <Empty icon={Calendar} text="No upcoming events" />;

    case 'calendar': return <MonthCalendar cal={data.calendar} />;

    case 'chores':
      return data.chores.length ? (
        <ul className="space-y-2.5">
          {data.chores.slice(0, tileListLimit(size, 4)).map((c) => {
            const who = memberById.get(c.member_id);
            return (
              <li key={c.id} className="flex items-center gap-2.5">
                <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', c.status === 'submitted' ? 'bg-amber-400' : 'bg-white/25')} />
                <span className="min-w-0 flex-1 truncate text-white">{c.title}</span>
                {who && <span className="shrink-0 text-xs text-white/50">{firstName(who.display_name)}</span>}
              </li>
            );
          })}
        </ul>
      ) : <Empty icon={CheckCircle2} text="All done! 🎉" />;

    case 'meals':
      return data.meals.length ? (
        <ul className="space-y-2">
          {data.meals.map((m) => (
            <li key={m.type} className="flex items-center gap-2.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={mealImage(m.name, m.type)} alt="" aria-hidden
                className="h-9 w-9 shrink-0 rounded-lg object-cover ring-1 ring-white/15" />
              <div className="min-w-0">
                <p className="text-[11px] capitalize leading-tight text-white/50">{MEAL_EMOJIS[m.type] ?? '🍽️'} {m.type}</p>
                <p className="truncate font-semibold leading-tight text-white">{m.name}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : <Empty icon={UtensilsCrossed} text="No meals planned" />;

    case 'grocery':
      return (
        <div className="flex h-full flex-col">
          <p className="text-4xl font-black text-white">{data.grocery.count}<span className="ml-1.5 text-base font-normal text-white/50">items</span></p>
          <ul className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto text-sm text-white/60 scrollbar-none">
            {data.grocery.items.slice(0, tileListLimit(size, 4)).map((g) => <li key={g.id} className="truncate">• {g.name}</li>)}
            {data.grocery.count === 0 && <li>List is empty</li>}
          </ul>
        </div>
      );

    case 'members':
      return (
        <div className="flex max-h-full flex-wrap gap-4 overflow-y-auto">
          {data.members.map((m) => (
            <div key={m.id} className="flex flex-col items-center gap-1.5">
              <Avatar name={m.display_name} color={m.color} size={52} />
              <span className="text-xs text-white/80">{firstName(m.display_name)}</span>
            </div>
          ))}
        </div>
      );

    case 'reminders':
      return data.reminders.length ? (
        <ul className="space-y-2 text-sm">
          {data.reminders.slice(0, tileListLimit(size, 4)).map((r) => (
            <li key={r.id} className="flex items-center gap-2"><Bell className="h-3.5 w-3.5 shrink-0 text-amber-300" /><span className="min-w-0 flex-1 truncate text-white">{r.title}</span></li>
          ))}
        </ul>
      ) : <Empty icon={Bell} text="No reminders due" />;

    case 'birthdays':
      return data.birthdays.length ? (
        <ul className="space-y-2">
          {data.birthdays.map((b) => (
            <li key={b.name} className="flex items-center gap-2"><Cake className="h-4 w-4 shrink-0 text-rose-300" /><span className="text-white">{b.name}</span><span className="ml-auto text-xs text-white/50">{b.date}</span></li>
          ))}
        </ul>
      ) : <Empty icon={Cake} text="No birthdays this week" />;

    case 'notes':
      return data.notes.length ? (
        <ul className="space-y-2 text-sm">
          {data.notes.slice(0, tileListLimit(size, 3)).map((n) => (
            <li key={n.id}><p className="truncate font-medium text-white">{n.title || 'Note'}</p><p className="truncate text-white/50">{n.body}</p></li>
          ))}
        </ul>
      ) : <Empty icon={StickyNote} text="No pinned notes" />;

    default: return null;
  }
}

function Empty({ icon: Icon, text }: { icon: typeof Calendar; text: string }) {
  return <div className="flex h-full flex-col items-center justify-center py-4 text-center text-white/40"><Icon className="h-8 w-8 opacity-60" /><p className="mt-2 text-sm">{text}</p></div>;
}

/**
 * Per-section error boundary — the kiosk's structural guarantee. A widget that
 * throws on an unexpected data shape (a malformed date once crashed the whole
 * display into an endless recover loop) degrades to a quiet placeholder while
 * every other tile keeps working. Retries itself on the next data refresh
 * (AutoRefresh remounts the tree with fresh props every two minutes).
 */
class WidgetBoundary extends Component<{ label?: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error(`[display] widget "${this.props.label ?? 'section'}" crashed:`, error); }
  componentDidUpdate(prev: { children: ReactNode }) {
    // Fresh props (a new server render) → give the widget another chance.
    if (this.state.failed && prev.children !== this.props.children) this.setState({ failed: false });
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full min-h-[60px] items-center justify-center text-center text-white/30">
          <p className="text-sm">—</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function MonthCalendar({ cal }: { cal: DisplayData['calendar'] }) {
  const first = new Date(cal.year, cal.month, 1).getDay();
  const days = new Date(cal.year, cal.month + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const eventSet = new Set(cal.eventDays);
  return (
    <div>
      <p className="mb-2 text-center text-sm font-semibold text-white">{new Date(cal.year, cal.month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</p>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px]">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i} className="text-white/40">{d}</span>)}
        {cells.map((d, i) => (
          <span key={i} className={cn('relative grid h-7 place-items-center rounded-md text-white/80', d === cal.today && 'bg-brand font-bold text-white', d && d !== cal.today && eventSet.has(d) && 'font-semibold text-white')}>
            {d ?? ''}
            {d && d !== cal.today && eventSet.has(d) && <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-brand" />}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Now & Next strip ──────────────────────────────────────────────────────────
function NowNextStrip({ events, memberById, now }: {
  events: Ev[]; memberById: Map<string, DisplayData['members'][number]>; now: Date;
}) {
  const { current, next } = nowAndNext(events, now);
  if (!current && !next) return null;
  const Cell = ({ label, ev, tone }: { label: string; ev: Ev; tone: string }) => {
    const who = ev.assignee_id ? memberById.get(ev.assignee_id) : undefined;
    return (
      <div className="flex min-w-0 flex-1 items-center gap-4 rounded-3xl bg-white/5 p-4 backdrop-blur-md">
        <span className={cn('shrink-0 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide', tone)}>{label}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-2xl font-black text-white">{ev.title}</p>
          <p className="text-sm text-white/60">
            {ev.all_day ? 'All day' : `${fmtTime(ev.starts_at)} · ${countdownLabel(ev.starts_at, now)}`}
            {ev.location ? ` · ${ev.location}` : ''}
          </p>
        </div>
        {who && <Avatar name={who.display_name} color={who.color} size={40} />}
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      {current && <Cell label="Now" ev={current} tone="bg-emerald-400/20 text-emerald-300" />}
      {next && <Cell label="Next" ev={next} tone="bg-violet-400/20 text-violet-200" />}
    </div>
  );
}

// ── Settings panel ────────────────────────────────────────────────────────────
function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" onClick={() => onChange(!on)} aria-pressed={on}
      className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white">
      <span>{label}</span>
      <span className={cn('relative h-5 w-9 rounded-full transition', on ? 'bg-brand' : 'bg-white/20')}>
        <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all', on ? 'left-4' : 'left-0.5')} />
      </span>
    </button>
  );
}

function SettingsPanel({ settings, onChange }: { settings: DisplaySettings; onChange: (patch: Partial<DisplaySettings>) => void }) {
  const seg = 'rounded-lg px-3 py-1.5 text-sm font-semibold transition';
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <p className="mb-3 flex items-center gap-2 text-sm font-bold text-white"><Settings2 className="h-4 w-4" /> Display settings</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {/* Clock format */}
        <div className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white">
          <span className="text-sm">Clock</span>
          <div className="flex gap-1 rounded-lg bg-black/20 p-0.5">
            <button className={cn(seg, !settings.clock24 ? 'bg-brand text-white' : 'text-white/60')} onClick={() => onChange({ clock24: false })}>12h</button>
            <button className={cn(seg, settings.clock24 ? 'bg-brand text-white' : 'text-white/60')} onClick={() => onChange({ clock24: true })}>24h</button>
          </div>
        </div>
        {/* Temp unit */}
        <div className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white">
          <span className="text-sm">Temperature</span>
          <div className="flex gap-1 rounded-lg bg-black/20 p-0.5">
            <button className={cn(seg, settings.tempUnit === 'F' ? 'bg-brand text-white' : 'text-white/60')} onClick={() => onChange({ tempUnit: 'F' })}>°F</button>
            <button className={cn(seg, settings.tempUnit === 'C' ? 'bg-brand text-white' : 'text-white/60')} onClick={() => onChange({ tempUnit: 'C' })}>°C</button>
          </div>
        </div>
        {/* Background: ambient gradient vs family photos */}
        <div className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white">
          <span className="text-sm">Background</span>
          <div className="flex gap-1 rounded-lg bg-black/20 p-0.5">
            <button className={cn(seg, settings.background === 'gradient' ? 'bg-brand text-white' : 'text-white/60')} onClick={() => onChange({ background: 'gradient' })}>Ambient</button>
            <button className={cn(seg, settings.background === 'photos' ? 'bg-brand text-white' : 'text-white/60')} onClick={() => onChange({ background: 'photos' })}>Photos</button>
          </div>
        </div>
        {/* Gradient theme */}
        <label className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white">
          Color mood
          <select value={settings.theme} onChange={(e) => onChange({ theme: e.target.value as ThemeChoice })}
            className="rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-sm capitalize text-white">
            {THEME_OPTIONS.map((t) => <option key={t} value={t} className="bg-slate-900">{t === 'auto' ? 'Auto (time of day)' : t}</option>)}
          </select>
        </label>
        {/* Photo frame idle */}
        <label className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white">
          Photo frame
          <select value={settings.idleMinutes} onChange={(e) => onChange({ idleMinutes: Number(e.target.value) })}
            className="rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-sm text-white">
            {IDLE_OPTIONS.map((m) => <option key={m} value={m} className="bg-slate-900">{m === 0 ? 'Off' : `After ${m} min idle`}</option>)}
          </select>
        </label>
        <Toggle on={settings.seconds} onChange={(v) => onChange({ seconds: v })} label="Show seconds" />
        <Toggle on={settings.ambient} onChange={(v) => onChange({ ambient: v })} label="Ambient wash" />
        <Toggle on={settings.screensaver} onChange={(v) => onChange({ screensaver: v })} label="Burn-in protection" />
      </div>
    </div>
  );
}

// ── Photo-ambient backdrop (Amazon Echo Show look) ───────────────────────────
function PhotoBackdrop({ photos }: { photos: string[] }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (photos.length < 2) return;
    const id = setInterval(() => setI((v) => (v + 1) % photos.length), 45_000);
    return () => clearInterval(id);
  }, [photos.length]);
  return (
    <div aria-hidden className="fixed inset-0 -z-10 bg-black">
      {photos.map((p, idx) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={p} src={p} alt=""
          className="absolute inset-0 h-full w-full object-cover transition-opacity duration-[4000ms]"
          style={{ opacity: idx === i ? 1 : 0 }} />
      ))}
      {/* Heavy scrim keeps tiles readable over any photo. */}
      <div className="absolute inset-0 bg-black/60" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/50" />
    </div>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────────
const DRIFT_CSS = `@keyframes displayDrift{0%,100%{transform:translate(0,0)}25%{transform:translate(7px,5px)}50%{transform:translate(-5px,9px)}75%{transform:translate(-7px,-5px)}}`;

export function DisplayShell({ initialTiles, initialSettings, data, familyId, userId }: {
  initialTiles: Tile[]; initialSettings: DisplaySettings; data: DisplayData; familyId: string; userId: string;
}) {
  const { success, error: toastError } = useToast();
  // Defense in depth: even the props are re-normalized (SSR throws here are
  // uncatchable by widget boundaries, so the shell must be garbage-proof).
  const [tiles, setTiles] = useState<Tile[]>(() => resolveTiles(initialTiles));
  const [settings, setSettings] = useState<DisplaySettings>(initialSettings);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState<Date>(() => new Date());
  const [isFull, setIsFull] = useState(false);
  const memberById = useMemo(() => new Map(data.members.map((m) => [m.id, m])), [data.members]);

  // Minute-granularity tick drives greeting, ambient theme, and now/next.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const onFs = () => setIsFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { /* not supported / denied */ }
  }

  const theme = ambientTheme(settings.theme, now);
  const part = dayPart(now);
  // Photo surfaces never come up empty: real family photos win, the curated
  // ambient set stands in until the family uploads some.
  const ambientPhotos = data.photos.length ? data.photos : [...AMBIENT_FALLBACK_PHOTOS];
  const photoBg = settings.background === 'photos';

  // Echo-style bottom hints, recomputed as the clock ticks.
  const { next: nextEv } = nowAndNext(data.events, now);
  const hints = useMemo(() => buildHints({
    nextEvent: nextEv ? { title: nextEv.title, startsAt: nextEv.starts_at } : null,
    dinner: data.meals.find((m) => m.type === 'dinner')?.name ?? null,
    groceryCount: data.grocery.count,
    choresDue: data.chores.length,
    birthdays: data.birthdays,
    remindersDue: data.reminders.length,
  }, now), [nextEv, data.meals, data.grocery.count, data.chores.length, data.birthdays, data.reminders.length, now]);

  const frameNextLine = nextEv ? `Next: ${nextEv.title} · ${countdownLabel(nextEv.starts_at, now)}` : null;

  function update(id: string, patch: Partial<Tile>) { setTiles((t) => t.map((x) => x.id === id ? { ...x, ...patch } : x)); }
  function remove(id: string) { setTiles((t) => t.filter((x) => x.id !== id)); }
  function move(id: string, dir: -1 | 1) {
    setTiles((t) => {
      const i = t.findIndex((x) => x.id === id); const j = i + dir;
      if (i < 0 || j < 0 || j >= t.length) return t;
      const next = [...t]; [next[i], next[j]] = [next[j], next[i]]; return next;
    });
  }
  function add() { setTiles((t) => [...t, { id: uid(), widget: 'schedule', size: 'sm' }]); }
  function resetDefault() { setTiles(DEFAULT_TILES.map((t) => ({ ...t, id: uid() }))); }
  function cancel() { setTiles(resolveTiles(initialTiles)); setSettings(initialSettings); setEditing(false); }

  async function save() {
    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase.from('display_layouts')
      .upsert({ family_id: familyId, tiles: tiles as never, settings: settings as never, updated_by: userId }, { onConflict: 'family_id' });
    setSaving(false);
    if (error) { toastError(error.message); return; }
    success('Display saved'); setEditing(false);
  }

  const dayIcon = part === 'night' || part === 'evening' ? Moon : Sun;
  const DayIcon = dayIcon;

  return (
    <DisplayWeatherProvider unit={settings.tempUnit}>
      <style>{DRIFT_CSS}</style>
      {/* Background — Echo-Show photo ambience, or the time-of-day gradient wash */}
      {photoBg ? (
        <PhotoBackdrop photos={ambientPhotos} />
      ) : (
        <>
          <div className="fixed inset-0 -z-10 bg-[#0b1020]" style={settings.ambient ? { backgroundImage: theme.gradient } : undefined} />
          {settings.ambient && (
            <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 opacity-40">
              <div className="absolute -left-24 top-10 h-72 w-72 rounded-full blur-3xl" style={{ background: theme.glow }} />
              <div className="absolute -right-16 bottom-0 h-80 w-80 rounded-full blur-3xl" style={{ background: theme.glow }} />
            </div>
          )}
        </>
      )}

      <div
        className={cn(
          'flex min-h-dvh flex-col p-4 text-white sm:p-6 lg:p-6',
          // Kiosk fit: on large screens the display is exactly one viewport tall
          // and the tile grid divides whatever height is left — no page scroll.
          // (Edit mode restores normal flow so the settings panel can scroll.)
          !editing && 'lg:h-dvh lg:overflow-hidden',
        )}
        style={settings.screensaver && !editing ? { animation: 'displayDrift 100s ease-in-out infinite' } : undefined}
      >
        {/* Header chrome */}
        <header className="flex shrink-0 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.25em] text-white/50">
              <DayIcon className="h-3.5 w-3.5" /> Bubaly Kitchen
            </p>
            <h1 className="mt-1 truncate text-3xl font-black sm:text-4xl lg:text-5xl">{greeting(part, data.familyName)}</h1>
          </div>
          <div className="flex items-center gap-3">
            <WeatherChip />
            <AmbientClock clock24={settings.clock24} seconds={settings.seconds} />
            <div className="flex items-center gap-1.5">
              <button onClick={toggleFullscreen} title={isFull ? 'Exit fullscreen' : 'Fullscreen'}
                className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white/80 transition hover:bg-white/20">
                {isFull ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
              <button onClick={() => setEditing((v) => !v)} title="Edit display"
                className={cn('grid h-10 w-10 place-items-center rounded-full transition', editing ? 'bg-brand text-white' : 'bg-white/10 text-white/80 hover:bg-white/20')}>
                <Pencil className="h-4 w-4" />
              </button>
              <Link href="/dashboard" title="Exit display"
                className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white/80 transition hover:bg-white/20">
                <X className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </header>

        {/* Now & Next */}
        <div className="mt-4 shrink-0">
          <WidgetBoundary label="now-next">
            <NowNextStrip events={data.events} memberById={memberById} now={now} />
          </WidgetBoundary>
        </div>

        {/* Editor toolbar */}
        {editing && (
          <div className="mt-5 space-y-4">
            <SettingsPanel settings={settings} onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))} />
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button onClick={add} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white hover:bg-white/10"><Plus className="h-4 w-4" /> Add tile</button>
              <button onClick={resetDefault} className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/70 hover:bg-white/10">Reset layout</button>
              <button onClick={cancel} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white hover:bg-white/10"><X className="h-4 w-4" /> Cancel</button>
              <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-1.5 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60"><Check className="h-4 w-4" /> {saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        )}

        {/* Tile grid — on large screens rows are viewport fractions
            (minmax(0,1fr) inside the flex-1 slot), so the default layout fills
            the screen edge-to-edge and adding tiles makes rows proportionally
            shorter instead of pushing content below the fold. */}
        <div className={cn(
          'mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:gap-4',
          editing
            ? 'lg:auto-rows-[152px]'
            : 'min-h-0 flex-1 overflow-y-auto lg:auto-rows-[minmax(88px,1fr)]',
        )}>
          {tiles.map((tile) => (
            <section key={tile.id} className={cn(
              'relative flex min-h-[172px] flex-col overflow-hidden rounded-[1.75rem] border border-white/10 bg-white/[0.06] p-5 shadow-[0_8px_30px_rgba(0,0,0,0.25)] backdrop-blur-xl lg:min-h-0',
              sizeClass(tile.size), editing && 'ring-1 ring-brand/50',
            )}>
              {tile.widget !== 'featured' && tile.widget !== 'clock' && tile.widget !== 'service' && (
                <div className="mb-3 flex shrink-0 items-center gap-2 text-sm font-bold text-white/60">
                  {(() => { const Icon = WIDGETS.find((w) => w.key === tile.widget)?.icon ?? Calendar; return <Icon className="h-4 w-4 shrink-0" />; })()}
                  <span className="truncate">{widgetLabel(tile.widget as WidgetKey)}</span>
                </div>
              )}
              {/* Body flexes to fill the tile; list widgets scroll (scrollbar
                  hidden) as a safety net so nothing is ever hard-clipped, while
                  the size-aware widgets above keep content fitting by design. */}
              <div className={cn(tile.widget === 'featured' || tile.widget === 'service' ? 'h-full' : 'min-h-0 flex-1 overflow-y-auto scrollbar-none')}>
                <WidgetBoundary label={tile.widget}>
                  {tile.widget === 'service'
                    ? <ServiceTile href={tile.href ?? '/dashboard'} />
                    : <WidgetBody widget={tile.widget} size={tile.size} data={data} memberById={memberById} now={now} />}
                </WidgetBoundary>
              </div>

              {editing && (
                <div className="absolute inset-0 flex flex-col justify-between bg-black/75 p-3 backdrop-blur-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white/60">Tile</span>
                    <div className="flex gap-1">
                      <button onClick={() => move(tile.id, -1)} className="rounded p-1 text-white hover:bg-white/10"><ArrowUp className="h-4 w-4" /></button>
                      <button onClick={() => move(tile.id, 1)} className="rounded p-1 text-white hover:bg-white/10"><ArrowDown className="h-4 w-4" /></button>
                      <button onClick={() => remove(tile.id)} className="rounded p-1 text-rose-300 hover:bg-white/10"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="block text-xs text-white/60">Section
                      <select
                        value={tile.widget === 'service' ? `service:${tile.href ?? ''}` : tile.widget}
                        onChange={(e) => {
                          const v = e.target.value;
                          // "service:<href>" pins ANY app feature as a launcher
                          // tile; a plain key selects a built-in display widget.
                          if (v.startsWith('service:')) update(tile.id, { widget: SERVICE_WIDGET, href: v.slice('service:'.length) });
                          else update(tile.id, { widget: v as WidgetKey, href: undefined });
                        }}
                        className="mt-1 h-9 w-full rounded-lg border border-white/15 bg-slate-900 px-2 text-sm text-white"
                      >
                        <optgroup label="Display widgets">
                          {WIDGETS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
                        </optgroup>
                        <optgroup label="All services & features">
                          {ALL_SERVICES_CATALOG.map((s) => (
                            <option key={s.href} value={`service:${s.href}`}>{s.label}</option>
                          ))}
                        </optgroup>
                      </select>
                    </label>
                    <label className="block text-xs text-white/60">Size
                      <select value={tile.size} onChange={(e) => update(tile.id, { size: e.target.value as TileSize })} className="mt-1 h-9 w-full rounded-lg border border-white/15 bg-slate-900 px-2 text-sm text-white">
                        {SIZES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                      </select>
                    </label>
                  </div>
                </div>
              )}
            </section>
          ))}
        </div>

        {/* Footer band (padded clear of the hints ticker; hidden on the kiosk
            fit so the grid gets the full viewport — the pencil still edits) */}
        <p className={cn('mb-12 mt-6 flex items-center justify-center gap-2 text-center text-xs text-white/40', !editing && 'lg:hidden')}>
          <Sparkles className="h-3.5 w-3.5" /> {data.familyName} · Bubaly Kitchen Display
          {!editing && <button onClick={() => setEditing(true)} className="ml-1 inline-flex items-center gap-1 text-white/60 hover:text-white">Customize <ArrowRight className="h-3 w-3" /></button>}
        </p>
      </div>

      {/* Echo-style rotating hints, pinned to the bottom */}
      {!editing && <WidgetBoundary label="hints"><HintsTicker hints={hints} /></WidgetBoundary>}

      {/* Idle photo frame (family photos + clock) — wakes on any interaction */}
      {!editing && (
        <WidgetBoundary label="photo-frame">
          <PhotoFrame
            photos={ambientPhotos}
            idleMinutes={settings.idleMinutes}
            clock24={settings.clock24}
            nextLine={frameNextLine}
          />
        </WidgetBoundary>
      )}
    </DisplayWeatherProvider>
  );
}

/** Back-compat helper for the settings blob coming off `display_layouts`. */
export function resolveDisplaySettings(raw: unknown): DisplaySettings {
  return normalizeSettings(raw ?? DEFAULT_DISPLAY_SETTINGS);
}
