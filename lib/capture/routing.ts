// Capture routing: decide which destination a free-form note should go to.
// A fast deterministic heuristic runs instantly (and offline / when AI is off);
// the AI router refines it. Both are tier-aware so a note is never routed to a
// feature the family's plan can't use.

export type CaptureDestination = { key: string; label: string; url: string; minLevel: number };

export const CAPTURE_DESTINATIONS: CaptureDestination[] = [
  { key: 'grocery', label: 'Grocery List', url: '/dashboard/grocery', minLevel: 0 },
  { key: 'calendar', label: 'Calendar', url: '/dashboard/calendar', minLevel: 0 },
  { key: 'reminders', label: 'Reminders', url: '/dashboard/reminders', minLevel: 0 },
  { key: 'todos', label: 'To-Do List', url: '/dashboard/todos', minLevel: 0 },
  { key: 'notes', label: 'Notes', url: '/dashboard/notes', minLevel: 0 },
  { key: 'documents', label: 'Documents', url: '/dashboard/documents', minLevel: 0 },
  { key: 'tasks', label: 'Tasks & Chores', url: '/dashboard/chores', minLevel: 1 },
  { key: 'meals', label: 'Meals', url: '/dashboard/meals', minLevel: 1 },
  { key: 'trip', label: 'Trip Planner', url: '/dashboard/trips', minLevel: 1 },
  { key: 'health', label: 'Health', url: '/dashboard/health', minLevel: 1 },
  { key: 'expenses', label: 'Expenses', url: '/dashboard/expenses', minLevel: 1 },
  // Always-available catch-all (the AI assistant handles anything else).
  { key: 'assistant', label: 'AI Assistant', url: '/dashboard/assistant', minLevel: 0 },
];

export type RoutedDestination = { key: string; destination: string; url: string };

// Destinations Capture can create a record for directly (text → row). Others
// just route to their page.
export const FILEABLE_KEYS = new Set(['grocery', 'todos', 'notes']);

export function isFileableDestination(key: string): boolean {
  return FILEABLE_KEYS.has(key);
}

/** Destinations the plan can use. */
export function availableDestinations(planLevel: number): CaptureDestination[] {
  return CAPTURE_DESTINATIONS.filter((d) => d.minLevel <= planLevel);
}

function toRouted(d: CaptureDestination, text?: string): RoutedDestination {
  const url = d.key === 'assistant' && text ? `${d.url}?q=${encodeURIComponent(text)}` : d.url;
  return { key: d.key, destination: d.label, url };
}

const RULES: { key: string; re: RegExp }[] = [
  { key: 'grocery', re: /\b(buy|shop|grocery|groceries|store|milk|eggs|bread|chicken|produce|costco|target)\b/ },
  { key: 'calendar', re: /\b(event|party|birthday|meeting|appointment|schedule|doctor|dentist|school|practice|recital|game)\b/ },
  { key: 'meals', re: /\b(meal|recipe|dinner|lunch|breakfast|cook|food)\b/ },
  { key: 'trip', re: /\b(trip|vacation|travel|flight|hotel|pack|itinerary)\b/ },
  { key: 'health', re: /\b(health|symptom|medicine|medication|sick|pain|fever|prescription|refill)\b/ },
  { key: 'expenses', re: /\b(expense|spent|owe|reimburse|split the bill|paid for)\b/ },
  { key: 'documents', re: /\b(document|scan|file|pdf|receipt|invoice|statement)\b/ },
  { key: 'reminders', re: /\b(remind|reminder|don'?t forget|deadline|due)\b/ },
  { key: 'notes', re: /\b(note|remember|idea|thought|jot)\b/ },
  { key: 'tasks', re: /\b(task|todo|to-do|chore|clean|fix|repair|finish|assign)\b/ },
];

/**
 * Instant deterministic routing. Picks the first matching rule whose destination
 * the plan can use; otherwise the AI assistant (always available).
 */
export function routeCaptureHeuristic(text: string, planLevel: number): RoutedDestination {
  const lower = text.toLowerCase();
  const byKey = new Map(availableDestinations(planLevel).map((d) => [d.key, d]));
  for (const rule of RULES) {
    if (rule.re.test(lower)) {
      const dest = byKey.get(rule.key);
      if (dest) return toRouted(dest, text);
    }
  }
  return toRouted(byKey.get('assistant')!, text);
}

/** Resolve an AI-returned key to a routed destination (tier-validated). */
export function resolveAiKey(key: string | null | undefined, planLevel: number, text: string): RoutedDestination | null {
  if (!key) return null;
  const norm = key.trim().toLowerCase().replace(/[^a-z]/g, '');
  const dest = availableDestinations(planLevel).find((d) => d.key === norm);
  return dest ? toRouted(dest, text) : null;
}

export function buildCapturePrompt(text: string, planLevel: number): { system: string; user: string } {
  const dests = availableDestinations(planLevel);
  const list = dests.map((d) => `- ${d.key}: ${d.label}`).join('\n');
  const system =
    'You route a family-app quick note to the single best destination. ' +
    'Reply with ONLY the destination key (one word) from the provided list — no punctuation, no explanation. ' +
    "If nothing fits well, reply 'assistant'.";
  const user = `Destinations:\n${list}\n\nNote: "${text}"\n\nBest destination key:`;
  return { system, user };
}
