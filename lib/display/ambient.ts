// Pure, side-effect-free engine for the Kitchen Display (/display).
// Deterministic helpers the always-on screen shares: time-of-day theming, the
// day-part greeting, "now & next" event resolution, countdown labels, clock +
// temperature formatting, and display-settings normalization. No React, no
// Supabase, no `Date.now()` inside the pure fns (callers pass `now`). Unit-tested
// in tests/display-ambient.test.ts.

// ── Day parts ────────────────────────────────────────────────────────────────
export type DayPart = 'dawn' | 'morning' | 'afternoon' | 'evening' | 'night';

/** Map an hour (0–23) to a day part. Boundaries chosen for a kitchen screen:
 *  dawn 5–7, morning 7–12, afternoon 12–17, evening 17–21, night 21–5. */
export function dayPartForHour(hour: number): DayPart {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 5 && h < 7) return 'dawn';
  if (h >= 7 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}
export function dayPart(now: Date): DayPart {
  return dayPartForHour(now.getHours());
}

const GREETINGS: Record<DayPart, string> = {
  dawn: 'Good morning',
  morning: 'Good morning',
  afternoon: 'Good afternoon',
  evening: 'Good evening',
  night: 'Good night',
};

/** "Good morning, The Hughen Family" — name optional. */
export function greeting(part: DayPart, name?: string | null): string {
  const base = GREETINGS[part];
  const n = (name ?? '').trim();
  return n ? `${base}, ${n}` : base;
}

// ── Ambient theme (page background by time of day, or a fixed theme) ──────────
export type AmbientTheme = { name: string; gradient: string; glow: string };

// Each gradient is a self-contained CSS value (safe to drop into `background`).
const THEMES: Record<string, AmbientTheme> = {
  dawn:      { name: 'Dawn',     gradient: 'radial-gradient(120% 120% at 20% 0%, #f9a8d4 0%, #c084fc 35%, #4c1d95 75%, #0b1020 100%)', glow: '#f9a8d4' },
  morning:   { name: 'Morning',  gradient: 'radial-gradient(120% 120% at 15% 0%, #7dd3fc 0%, #38bdf8 30%, #1e3a8a 78%, #0b1020 100%)', glow: '#7dd3fc' },
  afternoon: { name: 'Afternoon',gradient: 'radial-gradient(120% 120% at 80% 0%, #60a5fa 0%, #2563eb 35%, #1e293b 80%, #0b1020 100%)', glow: '#60a5fa' },
  evening:   { name: 'Evening',  gradient: 'radial-gradient(120% 120% at 85% 5%, #fb923c 0%, #db2777 40%, #4c1d95 80%, #0b1020 100%)', glow: '#fb923c' },
  night:     { name: 'Night',    gradient: 'radial-gradient(120% 120% at 50% -10%, #1e3a8a 0%, #172554 40%, #0b1020 100%)', glow: '#3b82f6' },
  // Explicit (non-auto) themes:
  midnight:  { name: 'Midnight', gradient: 'radial-gradient(120% 120% at 50% -10%, #0f172a 0%, #020617 100%)', glow: '#334155' },
  aurora:    { name: 'Aurora',   gradient: 'radial-gradient(120% 120% at 20% 0%, #22d3ee 0%, #0ea5e9 30%, #4338ca 70%, #0b1020 100%)', glow: '#22d3ee' },
  sunset:    { name: 'Sunset',   gradient: 'radial-gradient(120% 120% at 80% 0%, #fbbf24 0%, #f97316 35%, #be123c 72%, #1e1b4b 100%)', glow: '#fb923c' },
  forest:    { name: 'Forest',   gradient: 'radial-gradient(120% 120% at 25% 0%, #34d399 0%, #059669 35%, #065f46 72%, #0b1020 100%)', glow: '#34d399' },
};

export const THEME_OPTIONS = ['auto', 'midnight', 'aurora', 'sunset', 'forest'] as const;
export type ThemeChoice = (typeof THEME_OPTIONS)[number];

/** Resolve the background theme from the chosen theme + the current time. */
export function ambientTheme(theme: ThemeChoice, now: Date): AmbientTheme {
  if (theme !== 'auto' && THEMES[theme]) return THEMES[theme];
  return THEMES[dayPart(now)];
}

// ── Settings ─────────────────────────────────────────────────────────────────
export type TempUnit = 'F' | 'C';
export type BackgroundMode = 'gradient' | 'photos';
export const IDLE_OPTIONS = [0, 2, 5, 10] as const; // minutes; 0 = photo frame off

export type DisplaySettings = {
  clock24: boolean;
  seconds: boolean;
  tempUnit: TempUnit;
  theme: ThemeChoice;
  ambient: boolean;       // time-of-day background wash
  screensaver: boolean;   // gentle burn-in drift for always-on panels
  background: BackgroundMode; // gradient wash vs rotating family photos
  idleMinutes: number;    // minutes of no interaction → photo-frame; 0 = off
  setupDismissed: boolean; // the "Set up this tablet" first-run card was dismissed
};

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  clock24: false,
  seconds: false,
  tempUnit: 'F',
  theme: 'auto',
  ambient: true,
  screensaver: true,
  background: 'gradient',
  idleMinutes: 5,
  setupDismissed: false,
};

/** Coerce an untrusted JSON blob into a valid DisplaySettings (defaults win). */
export function normalizeSettings(raw: unknown): DisplaySettings {
  const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const bool = (v: unknown, d: boolean) => typeof v === 'boolean' ? v : d;
  const theme = THEME_OPTIONS.includes(r.theme as ThemeChoice) ? r.theme as ThemeChoice : DEFAULT_DISPLAY_SETTINGS.theme;
  const tempUnit: TempUnit = r.tempUnit === 'C' || r.tempUnit === 'F' ? r.tempUnit : DEFAULT_DISPLAY_SETTINGS.tempUnit;
  const background: BackgroundMode = r.background === 'photos' || r.background === 'gradient' ? r.background : DEFAULT_DISPLAY_SETTINGS.background;
  const idleMinutes = (IDLE_OPTIONS as readonly number[]).includes(r.idleMinutes as number)
    ? r.idleMinutes as number : DEFAULT_DISPLAY_SETTINGS.idleMinutes;
  return {
    clock24: bool(r.clock24, DEFAULT_DISPLAY_SETTINGS.clock24),
    seconds: bool(r.seconds, DEFAULT_DISPLAY_SETTINGS.seconds),
    tempUnit,
    theme,
    ambient: bool(r.ambient, DEFAULT_DISPLAY_SETTINGS.ambient),
    screensaver: bool(r.screensaver, DEFAULT_DISPLAY_SETTINGS.screensaver),
    background,
    idleMinutes,
    setupDismissed: bool(r.setupDismissed, DEFAULT_DISPLAY_SETTINGS.setupDismissed),
  };
}

// ── Clock + temperature formatting ───────────────────────────────────────────
export function formatClock(now: Date, opts: { clock24: boolean; seconds: boolean }): { time: string; suffix: string } {
  let h = now.getHours();
  const m = now.getMinutes().toString().padStart(2, '0');
  const s = now.getSeconds().toString().padStart(2, '0');
  if (opts.clock24) {
    const time = `${h.toString().padStart(2, '0')}:${m}${opts.seconds ? `:${s}` : ''}`;
    return { time, suffix: '' };
  }
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  const time = `${h}:${m}${opts.seconds ? `:${s}` : ''}`;
  return { time, suffix };
}

/** Celsius → the display unit, rounded, with degree sign. */
export function formatTemp(celsius: number, unit: TempUnit): string {
  const v = unit === 'F' ? celsius * 9 / 5 + 32 : celsius;
  return `${Math.round(v)}°`;
}

/** Open-Meteo hands us °F; convert to the chosen unit for rendering. */
export function tempFromFahrenheit(fahrenheit: number, unit: TempUnit): string {
  const v = unit === 'C' ? (fahrenheit - 32) * 5 / 9 : fahrenheit;
  return `${Math.round(v)}°`;
}

// ── Now & Next ───────────────────────────────────────────────────────────────
export type TimedEvent = { id: string; title: string; starts_at: string; all_day?: boolean; location?: string | null; assignee_id?: string | null };

/** Resolve what's happening now and what's up next from today's events.
 *  `current` = the most recent timed event that started within `windowMin`
 *  minutes; `next` = the soonest event still to come. */
export function nowAndNext<T extends TimedEvent>(
  events: readonly T[],
  now: Date,
  windowMin = 90,
): { current: T | null; next: T | null } {
  const nowMs = now.getTime();
  const timed = [...events]
    .filter((e) => Number.isFinite(new Date(e.starts_at).getTime()))
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());

  let current: T | null = null;
  let next: T | null = null;
  for (const e of timed) {
    const t = new Date(e.starts_at).getTime();
    if (t <= nowMs) {
      if (!e.all_day && nowMs - t <= windowMin * 60_000) current = e;
    } else if (!next) {
      next = e;
    }
  }
  return { current, next };
}

/** Human countdown/time label for an event relative to `now`. */
export function countdownLabel(startsAt: string, now: Date): string {
  const t = new Date(startsAt).getTime();
  if (!Number.isFinite(t)) return '';
  const diffMs = t - now.getTime();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin <= 0 && diffMin > -90) return 'Now';
  if (diffMin > 0 && diffMin < 60) return `in ${diffMin} min`;
  const d = new Date(startsAt);
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
}

// ── Kitchen timers ───────────────────────────────────────────────────────────
export type TimerPreset = { label: string; emoji: string; seconds: number };

/** One-tap presets for the Timers widget — the things a kitchen actually times. */
export const TIMER_PRESETS: TimerPreset[] = [
  { label: 'Soft eggs',  emoji: '🥚', seconds: 6 * 60 },
  { label: 'Hard eggs',  emoji: '🥚', seconds: 10 * 60 },
  { label: 'Pasta',      emoji: '🍝', seconds: 10 * 60 },
  { label: 'Rice',       emoji: '🍚', seconds: 18 * 60 },
  { label: 'Pizza',      emoji: '🍕', seconds: 12 * 60 },
  { label: 'Cookies',    emoji: '🍪', seconds: 11 * 60 },
  { label: 'Tea',        emoji: '🍵', seconds: 4 * 60 },
  { label: 'Homework',   emoji: '📚', seconds: 25 * 60 },
];

/** "6:00", "0:42", "1:02:03" — clock-style duration for a countdown. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ── Hints ticker (Echo-style rotating suggestions) ───────────────────────────
export type HintFacts = {
  nextEvent?: { title: string; startsAt: string } | null;
  dinner?: string | null;
  groceryCount?: number;
  choresDue?: number;
  birthdays?: { name: string; date: string }[];
  remindersDue?: number;
};

/** Build the rotating bottom-bar hints from today's data. Pure + deterministic:
 *  facts in, ordered strings out (most actionable first). Empty facts → helpful
 *  evergreen tips so the bar never goes blank. */
export function buildHints(facts: HintFacts, now: Date): string[] {
  const hints: string[] = [];
  if (facts.nextEvent) {
    hints.push(`📅 Next: ${facts.nextEvent.title} · ${countdownLabel(facts.nextEvent.startsAt, now)}`);
  }
  if (facts.dinner) hints.push(`🍽️ Dinner tonight: ${facts.dinner}`);
  if (facts.choresDue && facts.choresDue > 0) {
    hints.push(`✅ ${facts.choresDue} ${facts.choresDue === 1 ? 'chore' : 'chores'} due today — who's on it?`);
  }
  if (facts.groceryCount && facts.groceryCount > 0) {
    hints.push(`🛒 ${facts.groceryCount} ${facts.groceryCount === 1 ? 'item' : 'items'} on the grocery list`);
  }
  for (const b of facts.birthdays ?? []) hints.push(`🎂 ${b.name}'s birthday is ${b.date}`);
  if (facts.remindersDue && facts.remindersDue > 0) {
    hints.push(`🔔 ${facts.remindersDue} ${facts.remindersDue === 1 ? 'reminder' : 'reminders'} coming up`);
  }
  if (hints.length === 0) {
    hints.push('✨ All clear — enjoy the quiet', '⏱️ Tap Timers to start a kitchen timer', '✏️ Tap the pencil to customize this display');
  }
  return hints;
}
