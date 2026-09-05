// lib/concierge/suggested-prompts.ts — what Ask Bubaly offers before you type.
//
// Pure and dependency-free so the Ask bar, the command bar and the tests share
// one list. The six defaults are the §16 prompts verbatim; the contextual sets
// exist because a person on the meals page has already told us what they are
// thinking about, and offering "Plan our week" there is a worse guess than
// "Take care of dinner this week". Contextual prompts lead, then the defaults
// fill the row so a page never shows fewer than the six-slot rhythm.

export type SuggestedPrompt = { text: string; module: string | null };

/** The §16 suggested prompts, in the spec's order. */
export const SUGGESTED_PROMPTS: readonly string[] = [
  'Plan our week',
  'Take care of dinner',
  'Organize our weekend',
  'What are we forgetting?',
  'Prepare for our trip',
  'Help us save money',
];

export const MAX_SUGGESTIONS = 6;

/**
 * Pathname prefix → the module name the context envelope reports, plus the
 * prompts that make sense there. Order matters: the first matching prefix
 * wins, so nested routes come before their parents.
 */
const MODULE_PROMPTS: ReadonlyArray<{ prefixes: readonly string[]; module: string; prompts: readonly string[] }> = [
  { prefixes: ['/dashboard/meals', '/dashboard/recipes', '/dashboard/kitchen', '/dashboard/pantry-chef'], module: 'meals',
    prompts: ['Plan dinners for this week', 'Use what is in the pantry tonight', 'Build the grocery list from the meal plan'] },
  { prefixes: ['/dashboard/grocery', '/dashboard/pantry'], module: 'groceries',
    prompts: ['Restock the staples we are low on', 'Plan meals around what we already have', 'Split the shopping between us'] },
  { prefixes: ['/dashboard/calendar', '/dashboard/sync', '/dashboard/family-coo'], module: 'calendar',
    prompts: ['Find conflicts in our week', 'Who is free Saturday afternoon?', 'Remind everyone about tomorrow'] },
  { prefixes: ['/dashboard/chores', '/dashboard/todos'], module: 'tasks',
    prompts: ['Rebalance chores for the week', 'What is overdue and who owns it?', 'Remind the kids about their chores'] },
  { prefixes: ['/dashboard/trips', '/dashboard/trip-intel', '/dashboard/trip-memories'], module: 'trips',
    prompts: ['Prepare for our trip', 'Build the packing list', 'What do we still need before we leave?'] },
  { prefixes: ['/dashboard/billing', '/dashboard/expenses', '/dashboard/subscriptions', '/dashboard/family-cfo', '/dashboard/savings', '/wallet', '/economy'], module: 'finances',
    prompts: ['Why did we spend more this month?', 'Find subscriptions we can cancel', 'Help us save money'] },
  { prefixes: ['/dashboard/home', '/dashboard/utilities', '/dashboard/projects', '/dashboard/auto', '/dashboard/inventory', '/dashboard/binder'], module: 'home',
    prompts: ['Find a plumber for the leak', 'What maintenance is due?', 'Schedule the car service'] },
  { prefixes: ['/dashboard/school', '/dashboard/homework', '/dashboard/timetable', '/dashboard/family-school'], module: 'school',
    prompts: ['What is due at school this week?', 'Remind everyone about the school event', 'Plan homework time this week'] },
  { prefixes: ['/dashboard/sports'], module: 'sports',
    prompts: ['Who is driving to practice this week?', 'Add the game schedule to the calendar', 'Remind everyone about Saturday\'s game'] },
  { prefixes: ['/dashboard/documents', '/dashboard/tax-vault', '/dashboard/insurance', '/dashboard/renewals'], module: 'documents',
    prompts: ['What expires soon?', 'Are our travel documents ready?', 'Remind me before the renewal'] },
  { prefixes: ['/dashboard/messages', '/dashboard/announcements', '/dashboard/inbox'], module: 'messages',
    prompts: ['Remind everyone about the weekend plan', 'Tell the family dinner is at 7', 'Announce the change of plans'] },
  { prefixes: ['/dashboard/weekend'], module: 'weekend',
    prompts: ['Organize our weekend', 'What can we do together on Sunday?', 'Plan a rainy-day afternoon'] },
];

/** The module a pathname belongs to, for the request's context envelope; null on Home and unknown pages. */
export function moduleFromPathname(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const path = pathname.split('?')[0].replace(/\/+$/, '') || '/';
  for (const entry of MODULE_PROMPTS) {
    if (entry.prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return entry.module;
  }
  return null;
}

/** Contextual prompts first, then the §16 defaults, de-duplicated and capped. */
export function suggestedPromptsFor(pathname: string | null | undefined, max = MAX_SUGGESTIONS): SuggestedPrompt[] {
  const moduleName = moduleFromPathname(pathname);
  const contextual = moduleName ? MODULE_PROMPTS.find((entry) => entry.module === moduleName)?.prompts ?? [] : [];
  const out: SuggestedPrompt[] = [];
  const seen = new Set<string>();
  const push = (text: string, mod: string | null) => {
    const key = text.trim().toLowerCase();
    if (!key || seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push({ text, module: mod });
  };
  for (const text of contextual) push(text, moduleName);
  for (const text of SUGGESTED_PROMPTS) push(text, null);
  return out;
}
