// lib/home/time-of-day.ts — Time-of-day "Mission Control" (Friction Backlog #7).
//
// Home is otherwise static across the day. This pure engine decides the current
// day phase and the ordered "what matters now" focus for it — morning leans on
// the day ahead (schedule / weather / school), midday on getting things done,
// evening on winding down + tomorrow, night on tomorrow + reflection. A server
// strip renders the top few. No I/O, so it's deterministic and unit-tested.

import { localPartsAt } from '@/lib/time/zoned';

export type DayPhase = 'morning' | 'midday' | 'evening' | 'night';

/** A catalogue lookup: the words live in lib/i18n/messages, not here. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Coarse phase from the local hour. Boundaries chosen for family rhythm:
 *  morning 5–11, midday 11–17, evening 17–21, night 21–5. */
export function dayPhase(now: Date = new Date(), timezone?: string): DayPhase {
  // The FAMILY's hour, not the server's. Every caller renders on the server,
  // which runs in UTC: at 8 pm in Los Angeles it is 3 am there, so the home
  // page said "Good morning" and offered the morning shortcuts at night.
  const h = timezone ? localPartsAt(now, timezone).hour : now.getHours();
  if (h >= 5 && h < 11) return 'morning';
  if (h >= 11 && h < 17) return 'midday';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

/** "Good morning" etc. — greeting for the phase (night reads "Good evening"). */
export function phaseGreeting(phase: DayPhase, t: Translate): string {
  switch (phase) {
    case 'morning': return t('timeOfDay.goodMorning');
    case 'midday': return t('timeOfDay.goodAfternoon');
    default: return t('timeOfDay.goodEvening');
  }
}

/** One-line "what matters now" framing for the phase. */
export function phaseBlurb(phase: DayPhase, t: Translate): string {
  switch (phase) {
    case 'morning': return t('timeOfDay.blurbMorning');
    case 'midday': return t('timeOfDay.blurbMidday');
    case 'evening': return t('timeOfDay.blurbEvening');
    case 'night': return t('timeOfDay.blurbNight');
  }
}

/** A focus shortcut. `icon` is a lucide name resolved by the renderer (engine
 *  stays React-free). */
export type FocusItem = { key: string; label: string; labelKey: string; href: string; icon: string };

const ITEMS: Record<string, FocusItem> = {
  schedule: { key: 'schedule', label: 'Today’s schedule', labelKey: 'timeOfDayFocus.schedule', href: '/dashboard/calendar', icon: 'CalendarClock' },
  tomorrow: { key: 'tomorrow', label: 'Tomorrow’s plan', labelKey: 'timeOfDayFocus.tomorrow', href: '/dashboard/calendar', icon: 'CalendarDays' },
  weather: { key: 'weather', label: 'Weather', labelKey: 'timeOfDayFocus.weather', href: '/dashboard/weather', icon: 'CloudSun' },
  school: { key: 'school', label: 'School & activities', labelKey: 'timeOfDayFocus.school', href: '/dashboard/school', icon: 'GraduationCap' },
  tasks: { key: 'tasks', label: 'Open tasks', labelKey: 'timeOfDayFocus.tasks', href: '/dashboard/todos', icon: 'ListChecks' },
  messages: { key: 'messages', label: 'Family messages', labelKey: 'timeOfDayFocus.messages', href: '/dashboard/messages', icon: 'MessageCircle' },
  shopping: { key: 'shopping', label: 'Shopping list', labelKey: 'timeOfDayFocus.shopping', href: '/dashboard/grocery', icon: 'ShoppingCart' },
  meals: { key: 'meals', label: 'Dinner plan', labelKey: 'timeOfDayFocus.meals', href: '/dashboard/meals', icon: 'UtensilsCrossed' },
  moments: { key: 'moments', label: 'Get ready', labelKey: 'timeOfDayFocus.moments', href: '/dashboard/moments', icon: 'Sparkles' },
  journal: { key: 'journal', label: 'Reflect', labelKey: 'timeOfDayFocus.journal', href: '/dashboard/journal', icon: 'BookOpen' },
};

const ORDER: Record<DayPhase, string[]> = {
  morning: ['schedule', 'weather', 'school', 'tasks'],
  midday: ['tasks', 'messages', 'shopping', 'meals'],
  evening: ['meals', 'tomorrow', 'school', 'tasks'],
  night: ['tomorrow', 'moments', 'journal'],
};

/** Ordered focus shortcuts for a phase (default: current time), capped at `max`. */
export function focusForPhase(phase: DayPhase, max = 4): FocusItem[] {
  return ORDER[phase].slice(0, max).map((k) => ITEMS[k]);
}
