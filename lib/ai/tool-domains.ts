// lib/ai/tool-domains.ts — the domain half of a dotted tool name, and the
// words a person reads for it.
//
// A tool's canonical name is `calendar.createEvent`: the part before the dot
// is the domain its ledger row belongs to, and it is what the Handled ledger
// (M6) shows as the SOURCE of a completed item — which tool acted, read from
// `ai_tool_calls`/`ai_plan_steps`, never inferred from the title. An
// `agent_activity` row names the specialist that wrote it (`scheduler`,
// `budget_coach`) in the same column, so those ids are labelled here too.
//
// PURE and dependency-free on purpose. The tool registry drags every domain
// service (and `server-only`) in behind it, but the Home ledger model
// (lib/home/today.ts) is bundled for the browser by the live "Working on"
// card and the run timeline is a client component; both only need the prefix
// and a catalogue key for its label. The English label stays beside the key so
// a reader of this file knows what the key says.
export type ToolDomainDef = { domain: string; label: string; labelKey: string };

export const TOOL_DOMAINS: readonly ToolDomainDef[] = [
  // Dotted tool-name prefixes (lib/ai/tools/registry.ts).
  { domain: 'calendar', label: 'Calendar', labelKey: 'toolDomain.calendar' },
  { domain: 'chores', label: 'Chores', labelKey: 'toolDomain.chores' },
  { domain: 'documents', label: 'Documents', labelKey: 'toolDomain.documents' },
  { domain: 'family', label: 'Family', labelKey: 'toolDomain.family' },
  { domain: 'finances', label: 'Finances', labelKey: 'toolDomain.finances' },
  { domain: 'goals', label: 'Goals', labelKey: 'toolDomain.goals' },
  { domain: 'groceries', label: 'Groceries', labelKey: 'toolDomain.groceries' },
  { domain: 'home', label: 'Home', labelKey: 'toolDomain.home' },
  { domain: 'meals', label: 'Meals', labelKey: 'toolDomain.meals' },
  { domain: 'memory', label: 'Memory', labelKey: 'toolDomain.memory' },
  { domain: 'messages', label: 'Messages', labelKey: 'toolDomain.messages' },
  { domain: 'notes', label: 'Notes', labelKey: 'toolDomain.notes' },
  { domain: 'notifications', label: 'Notifications', labelKey: 'toolDomain.notifications' },
  { domain: 'reminders', label: 'Reminders', labelKey: 'toolDomain.reminders' },
  { domain: 'routines', label: 'Routines', labelKey: 'toolDomain.routines' },
  { domain: 'school', label: 'School', labelKey: 'toolDomain.school' },
  { domain: 'sports', label: 'Sports', labelKey: 'toolDomain.sports' },
  { domain: 'tasks', label: 'Tasks', labelKey: 'toolDomain.tasks' },
  { domain: 'trips', label: 'Trips', labelKey: 'toolDomain.trips' },
  // Specialist agents and surfaces that write `agent_activity` rows
  // (lib/agents/roster.ts, lib/services/activity).
  { domain: 'autopilot', label: 'Autopilot', labelKey: 'toolDomain.autopilot' },
  { domain: 'budget_coach', label: 'Budget Coach', labelKey: 'toolDomain.budgetCoach' },
  { domain: 'chief_of_staff', label: 'Chief of Staff', labelKey: 'toolDomain.chiefOfStaff' },
  { domain: 'comms_assistant', label: 'Communications Assistant', labelKey: 'toolDomain.commsAssistant' },
  { domain: 'concierge', label: 'Concierge', labelKey: 'toolDomain.concierge' },
  { domain: 'health_guide', label: 'Health Guide', labelKey: 'toolDomain.healthGuide' },
  { domain: 'household_manager', label: 'Household Manager', labelKey: 'toolDomain.householdManager' },
  { domain: 'meal_planner', label: 'Meal Planner', labelKey: 'toolDomain.mealPlanner' },
  { domain: 'memory_keeper', label: 'Memory Keeper', labelKey: 'toolDomain.memoryKeeper' },
  { domain: 'scheduler', label: 'Scheduler', labelKey: 'toolDomain.scheduler' },
  { domain: 'school_coordinator', label: 'School Coordinator', labelKey: 'toolDomain.schoolCoordinator' },
  { domain: 'travel_planner', label: 'Travel Planner', labelKey: 'toolDomain.travelPlanner' },
];

const BY_DOMAIN = new Map(TOOL_DOMAINS.map((d) => [d.domain, d]));

/**
 * `calendar.createEvent` → `calendar`. A name without a dot — a legacy flat
 * alias, or the `agent_activity.agent` that wrote a row — is its own domain,
 * shown as it was persisted rather than guessed at.
 */
export function toolDomain(toolName: string): string {
  const trimmed = toolName.trim();
  const dot = trimmed.indexOf('.');
  return (dot > 0 ? trimmed.slice(0, dot) : trimmed).toLowerCase();
}

/** The catalogue key for a domain's label, or null for one the catalogue does not know (render the raw domain). */
export function toolDomainLabelKey(domain: string): string | null {
  return BY_DOMAIN.get(domain)?.labelKey ?? null;
}

/**
 * The words a person reads for a domain: the translated label when the
 * catalogue knows the domain, otherwise the persisted domain itself — a
 * truthful raw value beats a guessed pretty one.
 */
export function toolDomainLabel(domain: string, t: (key: string) => string): string {
  const key = toolDomainLabelKey(domain);
  return key ? t(key) : domain;
}

/**
 * "Calendar · Tasks" — one label per distinct domain, in ledger order, or null
 * when nothing persisted says who acted. Structural on purpose (anything with
 * a `domain`) so lib/home/today.ts can import this module without a cycle.
 */
export function sourcesLine(sources: readonly { domain: string }[], t: (key: string) => string): string | null {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const s of sources) {
    if (seen.has(s.domain)) continue;
    seen.add(s.domain);
    labels.push(toolDomainLabel(s.domain, t));
  }
  return labels.length ? labels.join(' · ') : null;
}
