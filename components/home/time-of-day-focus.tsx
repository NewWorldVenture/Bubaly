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
import { roleSurface, focusHeadline, focusChipClasses } from '@/lib/ui/role-surface';
import type { MemberRole } from '@/lib/constants/roles';
import { cn } from '@/lib/utils/cn';

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  CalendarClock, CalendarDays, CloudSun, GraduationCap, ListChecks, MessageCircle,
  ShoppingCart, UtensilsCrossed, Sparkles, BookOpen,
};

const PHASE_ICON: Record<DayPhase, React.ComponentType<{ className?: string }>> = {
  morning: Sunrise, midday: Sun, evening: Sunset, night: Moon,
};

export function TimeOfDayFocus({ now = new Date(), role = null }: { now?: Date; role?: MemberRole | null }) {
  const phase = dayPhase(now);
  // Role-tailored (Friction #8): kids/guests get a shorter, simpler focus set,
  // the heading language matches who's reading, and the chips scale to the
  // reader's density (bigger, more tappable for kids).
  const items = focusForPhase(phase, roleSurface(role).focusMax);
  const sizing = focusChipClasses(role);
  const PhaseIcon = PHASE_ICON[phase];

  return (
    <section className="rounded-2xl border border-brand/15 bg-gradient-to-br from-brand/[0.07] via-surface/40 to-surface/40 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand-text">
          <PhaseIcon className="h-4 w-4" />
        </span>
        <p className="text-sm font-semibold">{focusHeadline(role)} <span className="font-normal text-muted">· {phaseBlurb(phase)}</span></p>
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((it) => {
          const Icon = ICONS[it.icon] ?? Sparkles;
          return (
            <Link
              key={it.key}
              href={it.href}
              className={cn(
                'inline-flex items-center border border-border bg-surface/60 font-medium transition hover:bg-elevated hover:text-brand-text',
                sizing.chip,
              )}
            >
              <Icon className={cn('text-brand-text', sizing.icon)} /> {it.label}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
