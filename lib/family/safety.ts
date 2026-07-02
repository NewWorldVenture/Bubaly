// lib/family/safety.ts — pure, tested helpers for the Family safety pages
// (Check In, Driving Safety, Play Dates). No Supabase/React here.

export interface DrivingInputs {
  distance_miles: number;
  max_mph: number;
  hard_brakes: number;
  rapid_accels: number;
  phone_use_seconds: number;
}

/**
 * A 0–100 driving-safety score. Starts at 100 and deducts for risky events:
 * hard braking, rapid acceleration, phone use, and speeding above 75 mph.
 * Deterministic + clamped so the UI and any server default agree.
 */
export function drivingScore(t: DrivingInputs): number {
  let score = 100;
  score -= Math.max(0, t.hard_brakes) * 4;
  score -= Math.max(0, t.rapid_accels) * 3;
  score -= (Math.max(0, t.phone_use_seconds) / 30) * 2;
  if (t.max_mph > 75) score -= (t.max_mph - 75) * 1.5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function scoreBand(score: number): 'excellent' | 'good' | 'fair' | 'poor' {
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 55) return 'fair';
  return 'poor';
}

export const SCORE_TINT: Record<ReturnType<typeof scoreBand>, string> = {
  excellent: 'text-emerald-400',
  good: 'text-blue-400',
  fair: 'text-amber-400',
  poor: 'text-rose-400',
};

/** Average of trip scores, or null when there are none. */
export function averageScore(scores: number[]): number | null {
  if (scores.length === 0) return null;
  return Math.round(scores.reduce((s, n) => s + n, 0) / scores.length);
}

export const CHECK_IN_STATUS: Record<string, { label: string; emoji: string; tint: string }> = {
  safe: { label: 'Safe', emoji: '✅', tint: 'bg-emerald-500/15 text-emerald-300' },
  on_my_way: { label: 'On my way', emoji: '🚗', tint: 'bg-blue-500/15 text-blue-300' },
  arrived: { label: 'Arrived', emoji: '📍', tint: 'bg-violet-500/15 text-violet-300' },
  need_help: { label: 'Need help', emoji: '🆘', tint: 'bg-rose-500/15 text-rose-300' },
};

export const PLAY_DATE_STATUS: Record<string, { label: string; tint: string }> = {
  planned: { label: 'Planned', tint: 'bg-amber-500/15 text-amber-300' },
  confirmed: { label: 'Confirmed', tint: 'bg-emerald-500/15 text-emerald-300' },
  completed: { label: 'Completed', tint: 'bg-slate-500/15 text-slate-300' },
  cancelled: { label: 'Cancelled', tint: 'bg-rose-500/15 text-rose-300' },
};

export interface PlayDateLike { starts_at: string; status: string }

/** Split play dates into upcoming (future & not cancelled/completed) and past. */
export function splitPlayDates<T extends PlayDateLike>(rows: T[], now: Date = new Date()): { upcoming: T[]; past: T[] } {
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const r of rows) {
    const t = new Date(r.starts_at).getTime();
    if (t >= now.getTime() && r.status !== 'cancelled' && r.status !== 'completed') upcoming.push(r);
    else past.push(r);
  }
  upcoming.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  past.sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  return { upcoming, past };
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function relTime(iso: string, now: Date = new Date()): string {
  const diff = now.getTime() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}
