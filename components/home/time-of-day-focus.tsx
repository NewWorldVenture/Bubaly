// Time-of-day "Focus now" strip for Home (Friction Backlog #7). Renders the
// phase-appropriate shortcuts from lib/home/time-of-day — morning surfaces the
// schedule/weather/school, night surfaces tomorrow/prep/reflect — so Home leads
// with "what matters now" instead of the same static grid all day. Pure server
// render off the current time; additive (sits above the Home grid).
import Link from 'next/link';
import {
  CalendarClock, CalendarDays, CloudSun, GraduationCap, ListChecks, MessageCircle,
  ShoppingCart, UtensilsCrossed, Sparkles, BookOpen, Sunrise, Sun, Sunset, Moon,
} from 'lucide-react';
import { dayPhase, phaseBlurb, focusForPhase, type DayPhase } from '@/lib/home/time-of-day';

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  CalendarClock, CalendarDays, CloudSun, GraduationCap, ListChecks, MessageCircle,
  ShoppingCart, UtensilsCrossed, Sparkles, BookOpen,
};

const PHASE_ICON: Record<DayPhase, React.ComponentType<{ className?: string }>> = {
  morning: Sunrise, midday: Sun, evening: Sunset, night: Moon,
};

export function TimeOfDayFocus({ now = new Date() }: { now?: Date }) {
  const phase = dayPhase(now);
  const items = focusForPhase(phase);
  const PhaseIcon = PHASE_ICON[phase];

  return (
    <section className="rounded-2xl border border-brand/15 bg-gradient-to-br from-brand/[0.07] via-surface/40 to-surface/40 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand">
          <PhaseIcon className="h-4 w-4" />
        </span>
        <p className="text-sm font-semibold">Focus now <span className="font-normal text-muted">· {phaseBlurb(phase)}</span></p>
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((it) => {
          const Icon = ICONS[it.icon] ?? Sparkles;
          return (
            <Link
              key={it.key}
              href={it.href}
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm font-medium transition hover:bg-elevated hover:text-brand"
            >
              <Icon className="h-4 w-4 text-brand" /> {it.label}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
