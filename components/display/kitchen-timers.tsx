'use client';

// Kitchen Timers — the widget Echo Show owns and wall-calendar competitors lack.
// Multiple concurrent named countdowns from one-tap presets (or a custom number
// of minutes), a gentle Web-Audio chime + flashing card when one finishes, and
// localStorage persistence keyed on absolute end-times so timers survive the
// display's periodic refresh and even a full reload. Everything is device-local
// by design (a timer belongs to THIS kitchen screen).
import { useEffect, useRef, useState } from 'react';
import { Plus, Timer as TimerIcon, X } from 'lucide-react';
import { TIMER_PRESETS, formatDuration } from '@/lib/display/ambient';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

type RunningTimer = {
  id: string;
  label: string;
  emoji: string;
  endsAt: number;      // epoch ms
  totalSeconds: number;
  done: boolean;
};

const LS_KEY = 'display.timers';
const uid = () => Math.random().toString(36).slice(2, 9);

function loadTimers(): RunningTimer[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as RunningTimer[];
    // Drop anything finished more than 10 minutes ago (stale chimes help no one).
    return list.filter((t) => t.endsAt > Date.now() - 10 * 60_000);
  } catch { return []; }
}
function saveTimers(list: RunningTimer[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* storage blocked */ }
}

/** Three short beeps via Web Audio — no asset download, works on a kiosk. */
function chime() {
  try {
    type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };
    const Ctor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.45);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.45 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.45 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.45);
      osc.stop(ctx.currentTime + i * 0.45 + 0.4);
    }
    setTimeout(() => { void ctx.close(); }, 2500);
  } catch { /* audio blocked */ }
}

export function KitchenTimers() {
  const tr = useTranslations();
  const [timers, setTimers] = useState<RunningTimer[]>([]);
  const [picking, setPicking] = useState(false);
  const [customMin, setCustomMin] = useState('');
  const [tick, setTick] = useState(0);
  const chimed = useRef<Set<string>>(new Set());

  useEffect(() => { setTimers(loadTimers()); }, []);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Detect newly-finished timers exactly once each: chime + mark done.
  useEffect(() => {
    const nowMs = Date.now();
    let changed = false;
    const next = timers.map((t) => {
      if (!t.done && t.endsAt <= nowMs) {
        changed = true;
        if (!chimed.current.has(t.id)) { chimed.current.add(t.id); chime(); }
        return { ...t, done: true };
      }
      return t;
    });
    if (changed) { setTimers(next); saveTimers(next); }
  }, [tick, timers]);

  function start(label: string, emoji: string, seconds: number) {
    const t: RunningTimer = { id: uid(), label, emoji, endsAt: Date.now() + seconds * 1000, totalSeconds: seconds, done: false };
    const next = [...timers, t];
    setTimers(next); saveTimers(next); setPicking(false); setCustomMin('');
  }
  function dismiss(id: string) {
    const next = timers.filter((t) => t.id !== id);
    setTimers(next); saveTimers(next);
    chimed.current.delete(id);
  }

  const active = timers.filter((t) => !t.done || t.endsAt > Date.now() - 10 * 60_000);

  if (picking) {
    return (
      <div className="flex h-full flex-col">
        <div className="grid flex-1 grid-cols-4 gap-1.5 overflow-y-auto">
          {TIMER_PRESETS.map((p) => (
            <button key={p.label} onClick={() => start(p.label, p.emoji, p.seconds)}
              className="flex flex-col items-center justify-center gap-0.5 rounded-xl bg-white/10 py-2 transition hover:bg-white/20">
              <span className="text-xl leading-none">{p.emoji}</span>
              <span className="text-[10px] font-semibold text-white">{p.label}</span>
              <span className="text-[10px] text-white/50">{formatDuration(p.seconds)}</span>
            </button>
          ))}
        </div>
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const m = parseInt(customMin, 10);
            if (Number.isFinite(m) && m > 0 && m <= 24 * 60) start(`${m} min`, '⏱️', m * 60);
          }}
        >
          <input value={customMin} onChange={(e) => setCustomMin(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric" placeholder="Minutes…" aria-label={tr('kitchenTimers.customTimerMinutes')}
            className="h-9 w-full min-w-0 flex-1 rounded-lg border border-white/15 bg-black/25 px-2.5 text-sm text-white outline-none placeholder:text-white/40 focus:border-brand" />
          <button type="submit" className="h-9 shrink-0 rounded-lg bg-brand px-3 text-sm font-semibold text-white disabled:opacity-50" disabled={!customMin}>{tr('kitchenTimers.start')}</button>
          <button type="button" onClick={() => setPicking(false)} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/10 text-white/70 hover:bg-white/20"><X className="h-4 w-4" /></button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {active.length === 0 ? (
        <button onClick={() => setPicking(true)}
          className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-white/15 text-white/50 transition hover:border-white/30 hover:text-white">
          <TimerIcon className="h-8 w-8" />
          <span className="text-sm font-semibold">{tr('kitchenTimers.startATimer')}</span>
        </button>
      ) : (
        <>
          <ul className="flex-1 space-y-2 overflow-y-auto">
            {active.map((t) => {
              const remaining = Math.ceil((t.endsAt - Date.now()) / 1000);
              const pct = Math.max(0, Math.min(100, (remaining / t.totalSeconds) * 100));
              return (
                <li key={t.id} className={cn(
                  'relative overflow-hidden rounded-xl bg-white/10 px-3 py-2',
                  t.done && 'animate-pulse bg-emerald-400/25 ring-1 ring-emerald-300/60',
                )}>
                  {!t.done && <span className="absolute inset-y-0 left-0 bg-brand/25 transition-all" style={{ width: `${100 - pct}%` }} />}
                  <div className="relative flex items-center gap-2.5">
                    <span className="text-xl leading-none">{t.emoji}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-white">{t.label}</p>
                      <p className={cn('text-xl font-black tabular-nums leading-tight', t.done ? 'text-emerald-200' : 'text-white')}>
                        {t.done ? 'Done!' : formatDuration(remaining)}
                      </p>
                    </div>
                    <button onClick={() => dismiss(t.id)} aria-label={`Dismiss ${t.label} timer`}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-black/25 text-white/70 hover:bg-black/45 hover:text-white">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <button onClick={() => setPicking(true)}
            className="mt-2 inline-flex items-center justify-center gap-1.5 rounded-xl bg-white/10 py-1.5 text-xs font-semibold text-white/80 transition hover:bg-white/20">
            <Plus className="h-3.5 w-3.5" /> {tr('kitchenTimers.addTimer')}
          </button>
        </>
      )}
    </div>
  );
}
