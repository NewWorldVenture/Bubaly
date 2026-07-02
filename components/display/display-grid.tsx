'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Calendar, CheckCircle2, ShoppingCart, UtensilsCrossed, Cake, Bell, StickyNote,
  Users, CloudSun, Clock, Sparkles, Pencil, Plus, Trash2, ArrowUp, ArrowDown, Check, X,
  LocateFixed, MapPin, Droplets,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/avatar';
import { fmtTime } from '@/lib/utils/format';
import { fetchForecast, reverseGeocode, weatherInfo, type Forecast } from '@/lib/weather/open-meteo';
import { cn } from '@/lib/utils/cn';

// ── Types ────────────────────────────────────────────────────────────────────
type Ev = { id: string; title: string; starts_at: string; all_day: boolean; location: string | null; assignee_id: string | null };

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
  featured: { name: string; category: string | null; imageUrl: string | null } | null;
  calendar: { year: number; month: number; today: number; eventDays: number[] };
};

export type WidgetKey =
  | 'clock' | 'weather' | 'schedule' | 'upcoming' | 'calendar' | 'chores'
  | 'meals' | 'grocery' | 'members' | 'reminders' | 'birthdays' | 'featured' | 'notes';

type TileSize = 'sm' | 'md' | 'lg' | 'wide' | 'hero';
export type Tile = { id: string; widget: WidgetKey; size: TileSize };

export const WIDGETS: { key: WidgetKey; label: string; icon: typeof Calendar }[] = [
  { key: 'featured', label: 'Featured', icon: Sparkles },
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

export const DEFAULT_TILES: Tile[] = [
  { id: 't1', widget: 'featured', size: 'hero' },
  { id: 't2', widget: 'schedule', size: 'md' },
  { id: 't3', widget: 'calendar', size: 'md' },
  { id: 't4', widget: 'weather', size: 'sm' },
  { id: 't5', widget: 'meals', size: 'sm' },
  { id: 't6', widget: 'chores', size: 'sm' },
  { id: 't7', widget: 'grocery', size: 'sm' },
  { id: 't8', widget: 'members', size: 'wide' },
];

const MEAL_EMOJIS: Record<string, string> = { breakfast: '🍳', lunch: '🥗', dinner: '🍽️', snack: '🍎' };
const uid = () => Math.random().toString(36).slice(2, 9);

// ── Live widgets (client-only) ───────────────────────────────────────────────
function ClockWidget() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => { setNow(new Date()); const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  if (!now) return null;
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <p className="text-5xl font-black tabular-nums leading-none lg:text-6xl">{now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</p>
      <p className="mt-2 text-sm text-muted">{now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
    </div>
  );
}

function WeatherWidget() {
  const [f, setF] = useState<Forecast | null>(null);
  const [place, setPlace] = useState<string>('');
  const [state, setState] = useState<'loading' | 'denied' | 'ready'>('loading');
  useEffect(() => {
    let cancelled = false;
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setState('denied'); return; }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const [fc, g] = await Promise.all([fetchForecast(pos.coords.latitude, pos.coords.longitude, 4), reverseGeocode(pos.coords.latitude, pos.coords.longitude)]);
        if (cancelled) return;
        if (!fc) { setState('denied'); return; }
        setF(fc); setPlace(g?.name ?? 'My location'); setState('ready');
      },
      () => { if (!cancelled) setState('denied'); },
      { timeout: 8000, maximumAge: 600_000 },
    );
    return () => { cancelled = true; };
  }, []);
  if (state === 'loading') return <div className="h-full animate-pulse rounded-xl bg-elevated/40" />;
  if (state === 'denied' || !f) return <div className="flex h-full flex-col items-center justify-center text-muted"><CloudSun className="h-8 w-8" /><p className="mt-2 text-sm">Enable location for weather</p></div>;
  const info = weatherInfo(f.current.code, f.current.isDay);
  return (
    <div className="flex h-full flex-col">
      <p className="flex items-center gap-1 text-xs text-muted"><MapPin className="h-3 w-3" />{place}</p>
      <div className="mt-1 flex items-center gap-3">
        <span className="text-5xl">{info.icon}</span>
        <div>
          <p className="text-4xl font-black leading-none">{Math.round(f.current.temp)}°</p>
          <p className="text-xs text-muted">{info.label}</p>
        </div>
      </div>
      <div className="mt-auto flex justify-between gap-1 pt-3">
        {f.daily.slice(1, 4).map((d) => (
          <div key={d.date} className="text-center text-xs">
            <p className="text-muted">{new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' })}</p>
            <p className="text-lg">{weatherInfo(d.code).icon}</p>
            <p className="font-semibold">{Math.round(d.tempMax)}°</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Static widget bodies (data-driven) ───────────────────────────────────────
function WidgetBody({ widget, data, memberById }: {
  widget: WidgetKey; data: DisplayData; memberById: Map<string, DisplayData['members'][number]>;
}) {
  switch (widget) {
    case 'clock': return <ClockWidget />;
    case 'weather': return <WeatherWidget />;

    case 'featured': {
      const fr = data.featured;
      return (
        <div className="relative -m-5 flex h-[calc(100%+2.5rem)] flex-col justify-end overflow-hidden rounded-3xl p-6"
          style={fr?.imageUrl ? { backgroundImage: `url(${fr.imageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' } : { background: 'linear-gradient(135deg,#7c3aed33,#2563eb22)' }}>
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
          <div className="relative">
            <p className="text-xs font-semibold uppercase tracking-widest text-white/70">{fr ? 'Featured Recipe' : 'Bubaly'}</p>
            <p className="mt-1 text-4xl font-black text-white">{fr?.name ?? data.familyName}</p>
            {fr?.category && <p className="mt-1 text-sm text-white/70">{fr.category}</p>}
          </div>
        </div>
      );
    }

    case 'schedule':
      return data.events.length ? (
        <ul className="space-y-2">
          {data.events.slice(0, 7).map((e) => {
            const who = e.assignee_id ? memberById.get(e.assignee_id) : undefined;
            return (
              <li key={e.id} className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-sm font-bold tabular-nums text-violet-300">{e.all_day ? 'All day' : fmtTime(e.starts_at)}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{e.title}</span>
                {who && <Avatar name={who.display_name} color={who.color} size={24} />}
              </li>
            );
          })}
        </ul>
      ) : <Empty icon={Calendar} text="Nothing scheduled today" />;

    case 'upcoming':
      return data.upcoming.length ? (
        <ul className="space-y-2">
          {data.upcoming.slice(0, 8).map((e) => (
            <li key={e.id} className="flex items-center gap-3 text-sm">
              <span className="w-24 shrink-0 text-muted">{new Date(e.starts_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{e.title}</span>
            </li>
          ))}
        </ul>
      ) : <Empty icon={Calendar} text="No upcoming events" />;

    case 'calendar': return <MonthCalendar cal={data.calendar} />;

    case 'chores':
      return data.chores.length ? (
        <ul className="space-y-2">
          {data.chores.slice(0, 7).map((c) => {
            const who = memberById.get(c.member_id);
            return (
              <li key={c.id} className="flex items-center gap-2.5">
                <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', c.status === 'submitted' ? 'bg-amber-400' : 'bg-elevated')} />
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {who && <span className="shrink-0 text-xs text-muted">{who.display_name.split(' ')[0]}</span>}
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
              <span className="text-2xl">{MEAL_EMOJIS[m.type] ?? '🍽️'}</span>
              <span className="capitalize text-muted">{m.type}:</span>
              <span className="truncate font-semibold">{m.name}</span>
            </li>
          ))}
        </ul>
      ) : <Empty icon={UtensilsCrossed} text="No meals planned" />;

    case 'grocery':
      return (
        <div className="flex h-full flex-col">
          <p className="text-3xl font-black">{data.grocery.count}<span className="ml-1 text-base font-normal text-muted">items</span></p>
          <ul className="mt-2 space-y-1 text-sm text-muted">
            {data.grocery.items.slice(0, 5).map((g) => <li key={g.id} className="truncate">• {g.name}</li>)}
            {data.grocery.count === 0 && <li>List is empty</li>}
          </ul>
        </div>
      );

    case 'members':
      return (
        <div className="flex max-h-full flex-wrap gap-4 overflow-y-auto">
          {data.members.map((m) => (
            <div key={m.id} className="flex flex-col items-center gap-1">
              <Avatar name={m.display_name} color={m.color} size={44} />
              <span className="text-xs">{m.display_name.split(' ')[0]}</span>
            </div>
          ))}
        </div>
      );

    case 'reminders':
      return data.reminders.length ? (
        <ul className="space-y-2 text-sm">
          {data.reminders.slice(0, 7).map((r) => (
            <li key={r.id} className="flex items-center gap-2"><Bell className="h-3.5 w-3.5 shrink-0 text-amber-300" /><span className="min-w-0 flex-1 truncate">{r.title}</span></li>
          ))}
        </ul>
      ) : <Empty icon={Bell} text="No reminders due" />;

    case 'birthdays':
      return data.birthdays.length ? (
        <ul className="space-y-2">
          {data.birthdays.map((b) => (
            <li key={b.name} className="flex items-center gap-2"><Cake className="h-4 w-4 shrink-0 text-rose-300" /><span>{b.name}</span><span className="ml-auto text-xs text-muted">{b.date}</span></li>
          ))}
        </ul>
      ) : <Empty icon={Cake} text="No birthdays this week" />;

    case 'notes':
      return data.notes.length ? (
        <ul className="space-y-2 text-sm">
          {data.notes.slice(0, 5).map((n) => (
            <li key={n.id}><p className="truncate font-medium">{n.title || 'Note'}</p><p className="truncate text-muted">{n.body}</p></li>
          ))}
        </ul>
      ) : <Empty icon={StickyNote} text="No pinned notes" />;

    default: return null;
  }
}

function Empty({ icon: Icon, text }: { icon: typeof Calendar; text: string }) {
  return <div className="flex h-full flex-col items-center justify-center py-4 text-center text-muted"><Icon className="h-8 w-8 opacity-40" /><p className="mt-2 text-sm">{text}</p></div>;
}

function MonthCalendar({ cal }: { cal: DisplayData['calendar'] }) {
  const first = new Date(cal.year, cal.month, 1).getDay();
  const days = new Date(cal.year, cal.month + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const eventSet = new Set(cal.eventDays);
  return (
    <div>
      <p className="mb-2 text-center text-sm font-semibold">{new Date(cal.year, cal.month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</p>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px]">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i} className="text-muted">{d}</span>)}
        {cells.map((d, i) => (
          <span key={i} className={cn('relative grid h-7 place-items-center rounded-md', d === cal.today && 'bg-brand font-bold text-white', d && d !== cal.today && eventSet.has(d) && 'font-semibold')}>
            {d ?? ''}
            {d && d !== cal.today && eventSet.has(d) && <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-brand" />}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Grid + editor ─────────────────────────────────────────────────────────────
export function DisplayGrid({ initialTiles, data, familyId, userId }: {
  initialTiles: Tile[]; data: DisplayData; familyId: string; userId: string;
}) {
  const { success, error: toastError } = useToast();
  const [tiles, setTiles] = useState<Tile[]>(initialTiles.length ? initialTiles : DEFAULT_TILES);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const memberById = useMemo(() => new Map(data.members.map((m) => [m.id, m])), [data.members]);

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

  async function save() {
    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase.from('display_layouts')
      .upsert({ family_id: familyId, tiles: tiles as never, updated_by: userId }, { onConflict: 'family_id' });
    setSaving(false);
    if (error) { toastError(error.message); return; }
    success('Display layout saved'); setEditing(false);
  }

  function resetDefault() { setTiles(DEFAULT_TILES.map((t) => ({ ...t, id: uid() }))); }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        {editing ? (
          <>
            <button onClick={add} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-elevated"><Plus className="h-4 w-4" /> Add tile</button>
            <button onClick={resetDefault} className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:bg-elevated">Reset</button>
            <button onClick={() => { setTiles(initialTiles.length ? initialTiles : DEFAULT_TILES); setEditing(false); }} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-elevated"><X className="h-4 w-4" /> Cancel</button>
            <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60"><Check className="h-4 w-4" /> {saving ? 'Saving…' : 'Save layout'}</button>
          </>
        ) : (
          <button onClick={() => setEditing(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-elevated"><Pencil className="h-4 w-4" /> Edit layout</button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:auto-rows-[150px] lg:grid-cols-6">
        {tiles.map((tile) => (
          <section key={tile.id} className={cn('relative min-h-[170px] overflow-hidden rounded-3xl border border-border bg-surface/40 p-5 lg:min-h-0', sizeClass(tile.size), editing && 'ring-1 ring-brand/40')}>
            {tile.widget !== 'featured' && tile.widget !== 'clock' && (
              <div className="mb-3 flex items-center gap-2 text-sm font-bold text-muted">
                {(() => { const Icon = WIDGETS.find((w) => w.key === tile.widget)?.icon ?? Calendar; return <Icon className="h-4 w-4" />; })()}
                {widgetLabel(tile.widget)}
              </div>
            )}
            <div className={cn(tile.widget === 'featured' ? 'h-full' : 'min-h-0')}>
              <WidgetBody widget={tile.widget} data={data} memberById={memberById} />
            </div>

            {editing && (
              <div className="absolute inset-0 flex flex-col justify-between bg-bg/85 p-3 backdrop-blur-sm">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-muted">Tile</span>
                  <div className="flex gap-1">
                    <button onClick={() => move(tile.id, -1)} className="rounded p-1 hover:bg-elevated"><ArrowUp className="h-4 w-4" /></button>
                    <button onClick={() => move(tile.id, 1)} className="rounded p-1 hover:bg-elevated"><ArrowDown className="h-4 w-4" /></button>
                    <button onClick={() => remove(tile.id)} className="rounded p-1 text-danger hover:bg-elevated"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="block text-xs text-muted">Section
                    <select value={tile.widget} onChange={(e) => update(tile.id, { widget: e.target.value as WidgetKey })} className="mt-1 h-9 w-full rounded-lg border border-border bg-surface px-2 text-sm">
                      {WIDGETS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
                    </select>
                  </label>
                  <label className="block text-xs text-muted">Size
                    <select value={tile.size} onChange={(e) => update(tile.id, { size: e.target.value as TileSize })} className="mt-1 h-9 w-full rounded-lg border border-border bg-surface px-2 text-sm">
                      {SIZES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                  </label>
                </div>
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
