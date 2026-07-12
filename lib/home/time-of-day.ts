// lib/home/time-of-day.ts — Time-of-day "Mission Control" (Friction Backlog #7).
//
// Home is otherwise static across the day. This pure engine decides the current
// day phase and the ordered "what matters now" focus for it — morning leans on
// the day ahead (schedule / weather / school), midday on getting things done,
// evening on winding down + tomorrow, night on tomorrow + reflection. A server
// strip renders the top few. No I/O, so it's deterministic and unit-tested.

export type DayPhase = 'morning' | 'midday' | 'evening' | 'night';

/** Coarse phase from the local hour. Boundaries chosen for family rhythm:
 *  morning 5–11, midday 11–17, evening 17–21, night 21–5. */
export function dayPhase(now: Date = new Date()): DayPhase {
  const h = now.getHours();
  if (h >= 5 && h < 11) return 'morning';
  if (h >= 11 && h < 17) return 'midday';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

/** "Good morning" etc. — greeting for the phase (night reads "Good evening"). */
export function phaseGreeting(phase: DayPhase): string {
  switch (phase) {
    case 'morning': return 'Good morning';
    case 'midday': return 'Good afternoon';
    default: return 'Good evening';
  }
}

/** One-line "what matters now" framing for the phase. */
export function phaseBlurb(phase: DayPhase): string {
  switch (phase) {
    case 'morning': return 'Here’s the day ahead — get everyone out the door.';
    case 'midday': return 'Keep the day moving — knock out what’s open.';
    case 'evening': return 'Wind down and get a head start on tomorrow.';
    case 'night': return 'Set up tomorrow, then rest.';
  }
}

/** A focus shortcut. `icon` is a lucide name resolved by the renderer (engine
 *  stays React-free). */
export type FocusItem = { key: string; label: string; href: string; icon: string };

const ITEMS: Record<string, FocusItem> = {
  schedule: { key: 'schedule', label: 'Today’s schedule', href: '/dashboard/calendar', icon: 'CalendarClock' },
  tomorrow: { key: 'tomorrow', label: 'Tomorrow’s plan', href: '/dashboard/calendar', icon: 'CalendarDays' },
  weather: { key: 'weather', label: 'Weather', href: '/dashboard/weather', icon: 'CloudSun' },
  school: { key: 'school', label: 'School & activities', href: '/dashboard/school', icon: 'GraduationCap' },
  tasks: { key: 'tasks', label: 'Open tasks', href: '/dashboard/todos', icon: 'ListChecks' },
  messages: { key: 'messages', label: 'Family messages', href: '/dashboard/messages', icon: 'MessageCircle' },
  shopping: { key: 'shopping', label: 'Shopping list', href: '/dashboard/grocery', icon: 'ShoppingCart' },
  meals: { key: 'meals', label: 'Dinner plan', href: '/dashboard/meals', icon: 'UtensilsCrossed' },
  moments: { key: 'moments', label: 'Get ready', href: '/dashboard/moments', icon: 'Sparkles' },
  journal: { key: 'journal', label: 'Reflect', href: '/dashboard/journal', icon: 'BookOpen' },
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
