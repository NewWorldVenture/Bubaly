// Specialized family agents (North Star pillar #6) — pure, unit-tested. The
// family sees ONE assistant; behind it a roster of domain specialists each turn
// the real family snapshot into a short briefing (status + concrete, deep-linked
// items). The Chief of Staff synthesizes across all of them. DB-free so every
// rule is testable; the route feeds it real Supabase counts.

export type AgentId =
  | 'chief_of_staff' | 'scheduler' | 'meal_planner' | 'budget_coach'
  | 'household_manager' | 'school_coordinator' | 'health_guide'
  | 'travel_planner' | 'memory_keeper' | 'comms_assistant';

export type Agent = {
  id: AgentId;
  name: string;
  role: string;
  /** icon key resolved to a lucide icon in the UI layer. */
  icon: string;
};

/** The roster, Chief of Staff first (it orchestrates the others). */
export const AGENTS: Agent[] = [
  { id: 'chief_of_staff',    name: 'Chief of Staff',          role: 'Keeps the whole household on track',        icon: 'compass' },
  { id: 'scheduler',         name: 'Scheduler',               role: 'Guards the calendar and resolves clashes',  icon: 'calendar' },
  { id: 'meal_planner',      name: 'Meal Planner',            role: 'Plans dinners and stocks the list',         icon: 'utensils' },
  { id: 'budget_coach',      name: 'Budget Coach',            role: 'Watches bills and spending',                icon: 'wallet' },
  { id: 'household_manager', name: 'Household Manager',       role: 'Chores, documents, and maintenance',        icon: 'home' },
  { id: 'school_coordinator',name: 'School Coordinator',      role: 'Homework, timetables, and sign-ups',        icon: 'graduation' },
  { id: 'health_guide',      name: 'Health Guide',            role: 'Meds, appointments, and records',           icon: 'heart-pulse' },
  { id: 'travel_planner',    name: 'Travel Planner',          role: 'Trips from idea to packed bags',            icon: 'plane' },
  { id: 'memory_keeper',     name: 'Memory Keeper',           role: 'Birthdays, milestones, and memories',       icon: 'cake' },
  { id: 'comms_assistant',   name: 'Communications Assistant',role: 'Messages, approvals, and the inbox',        icon: 'inbox' },
];

export const AGENTS_BY_ID: Record<AgentId, Agent> = Object.fromEntries(
  AGENTS.map((a) => [a.id, a]),
) as Record<AgentId, Agent>;

/** Real, family-scoped signals the route fills from Supabase (all default 0). */
export type AgentContext = {
  eventsToday: number;
  conflicts: number;
  unassignedEvents: number;
  unplannedDinners: number;
  openGrocery: number;
  billsDueSoon: number;
  subscriptions: number;
  overdueChores: number;
  expiringDocs: number;
  maintenanceDue: number;
  homeworkDue: number;
  medsDue: number;
  upcomingAppointments: number;
  upcomingTrips: number;
  birthdaysSoon: number;
  newMemories: number;
  unreadMessages: number;
  pendingApprovals: number;
};

export const EMPTY_AGENT_CONTEXT: AgentContext = {
  eventsToday: 0, conflicts: 0, unassignedEvents: 0, unplannedDinners: 0, openGrocery: 0,
  billsDueSoon: 0, subscriptions: 0, overdueChores: 0, expiringDocs: 0, maintenanceDue: 0,
  homeworkDue: 0, medsDue: 0, upcomingAppointments: 0, upcomingTrips: 0, birthdaysSoon: 0,
  newMemories: 0, unreadMessages: 0, pendingApprovals: 0,
};

export type AgentSeverity = 'info' | 'attention' | 'action';
export type AgentItem = { title: string; detail: string; href: string; severity: AgentSeverity };
export type AgentStatus = 'clear' | 'attention' | 'action';

export type AgentBriefing = {
  agentId: AgentId;
  status: AgentStatus;
  headline: string;
  items: AgentItem[];
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Roll item severities up to the briefing status. */
function statusFor(items: AgentItem[]): AgentStatus {
  if (items.some((i) => i.severity === 'action')) return 'action';
  if (items.length > 0) return 'attention';
  return 'clear';
}

/** Build one specialist's briefing from the context (Chief of Staff excluded). */
function runSpecialist(id: Exclude<AgentId, 'chief_of_staff'>, c: AgentContext): AgentItem[] {
  const items: AgentItem[] = [];
  const add = (cond: number, item: AgentItem) => { if (cond > 0) items.push(item); };
  switch (id) {
    case 'scheduler':
      add(c.conflicts, { title: `${plural(c.conflicts, 'schedule clash', 'schedule clashes')} to resolve`, detail: 'Two things overlap — decide who covers which.', href: '/dashboard/conflicts', severity: 'action' });
      add(c.unassignedEvents, { title: `${plural(c.unassignedEvents, 'event')} with no owner`, detail: 'Assign someone so nothing slips.', href: '/dashboard/calendar', severity: 'attention' });
      add(c.eventsToday, { title: `${plural(c.eventsToday, 'thing')} on today’s schedule`, detail: 'Here’s the plan for today.', href: '/dashboard/calendar', severity: 'info' });
      break;
    case 'meal_planner':
      add(c.unplannedDinners, { title: `${plural(c.unplannedDinners, 'dinner')} unplanned this week`, detail: 'Lock in a plan so evenings are easy.', href: '/dashboard/meals', severity: 'attention' });
      add(c.openGrocery, { title: `${plural(c.openGrocery, 'item')} on the shopping list`, detail: 'Ready for the next store run.', href: '/dashboard/grocery', severity: 'info' });
      break;
    case 'budget_coach':
      add(c.billsDueSoon, { title: `${plural(c.billsDueSoon, 'bill')} due soon`, detail: 'Stay ahead of what’s owed.', href: '/dashboard/bills', severity: 'action' });
      add(c.subscriptions, { title: `${plural(c.subscriptions, 'subscription')} to review`, detail: 'Trim anything you no longer use.', href: '/dashboard/subscriptions', severity: 'info' });
      break;
    case 'household_manager':
      add(c.overdueChores, { title: `${plural(c.overdueChores, 'overdue chore')}`, detail: 'Nudge or reassign these.', href: '/dashboard/chores', severity: 'action' });
      add(c.maintenanceDue, { title: `${plural(c.maintenanceDue, 'maintenance task')} due`, detail: 'Keep the home in good shape.', href: '/dashboard/home', severity: 'attention' });
      add(c.expiringDocs, { title: `${plural(c.expiringDocs, 'document')} expiring`, detail: 'Renew before they lapse.', href: '/dashboard/documents', severity: 'attention' });
      break;
    case 'school_coordinator':
      add(c.homeworkDue, { title: `${plural(c.homeworkDue, 'assignment')} due`, detail: 'Homework and projects on the horizon.', href: '/dashboard/homework', severity: 'attention' });
      break;
    case 'health_guide':
      add(c.medsDue, { title: `${plural(c.medsDue, 'medication')} to take or refill`, detail: 'Stay on schedule.', href: '/dashboard/medications', severity: 'action' });
      add(c.upcomingAppointments, { title: `${plural(c.upcomingAppointments, 'appointment')} coming up`, detail: 'Don’t miss a visit.', href: '/dashboard/health', severity: 'info' });
      break;
    case 'travel_planner':
      add(c.upcomingTrips, { title: `${plural(c.upcomingTrips, 'trip')} on the horizon`, detail: 'Plan, pack, and prep.', href: '/dashboard/trips', severity: 'attention' });
      break;
    case 'memory_keeper':
      add(c.birthdaysSoon, { title: `${plural(c.birthdaysSoon, 'birthday')} coming up`, detail: 'Plan a little celebration.', href: '/dashboard/celebrations', severity: 'attention' });
      add(c.newMemories, { title: `${plural(c.newMemories, 'new memory', 'new memories')}`, detail: 'Recently captured — relive them.', href: '/dashboard/memories', severity: 'info' });
      break;
    case 'comms_assistant':
      add(c.pendingApprovals, { title: `${plural(c.pendingApprovals, 'approval')} waiting`, detail: 'Someone needs a yes/no.', href: '/dashboard/inbox', severity: 'action' });
      add(c.unreadMessages, { title: `${plural(c.unreadMessages, 'unread message')}`, detail: 'Catch up with the family.', href: '/dashboard/messages', severity: 'info' });
      break;
  }
  return items;
}

const CLEAR_HEADLINE: Record<AgentId, string> = {
  chief_of_staff: 'Everyone’s on track — nothing needs the family right now.',
  scheduler: 'The calendar is clear and everything’s assigned.',
  meal_planner: 'Meals are planned and the list is stocked.',
  budget_coach: 'No bills due and spending looks steady.',
  household_manager: 'Chores, docs, and maintenance are all handled.',
  school_coordinator: 'No homework or school items outstanding.',
  health_guide: 'No meds or appointments need attention.',
  travel_planner: 'No trips to prep right now.',
  memory_keeper: 'No birthdays or milestones on the near horizon.',
  comms_assistant: 'Inbox is clear — no approvals or unread messages.',
};

/** Run a single specialist agent → a full briefing. */
export function runAgent(id: Exclude<AgentId, 'chief_of_staff'>, c: AgentContext): AgentBriefing {
  const items = runSpecialist(id, c);
  const status = statusFor(items);
  const attentionCount = items.filter((i) => i.severity !== 'info').length;
  const headline = status === 'clear'
    ? CLEAR_HEADLINE[id]
    : `${plural(attentionCount || items.length, 'thing')} could use attention.`;
  return { agentId: id, status, headline, items };
}

/**
 * The Chief of Staff synthesizes every specialist's briefing: it surfaces the
 * highest-severity items across all agents and a one-line state of the household.
 */
export function chiefOfStaff(specialists: AgentBriefing[]): AgentBriefing {
  const rank: Record<AgentSeverity, number> = { action: 0, attention: 1, info: 2 };
  const allItems = specialists.flatMap((b) => b.items);
  const top = [...allItems].sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 5);
  const actionAreas = specialists.filter((b) => b.status === 'action').length;
  const attnAreas = specialists.filter((b) => b.status !== 'clear').length;
  const status = statusFor(allItems);
  const headline = status === 'clear'
    ? CLEAR_HEADLINE.chief_of_staff
    : `${plural(allItems.filter((i) => i.severity !== 'info').length, 'thing')} across ${plural(attnAreas, 'area')} — ${actionAreas > 0 ? `${actionAreas} need${actionAreas === 1 ? 's' : ''} action first.` : 'nothing urgent.'}`;
  return { agentId: 'chief_of_staff', status, headline, items: top };
}

/** Run the whole roster (Chief of Staff synthesizes the rest). */
export function runAllAgents(c: AgentContext): AgentBriefing[] {
  const specialists = AGENTS
    .filter((a): a is Agent & { id: Exclude<AgentId, 'chief_of_staff'> } => a.id !== 'chief_of_staff')
    .map((a) => runAgent(a.id, c));
  return [chiefOfStaff(specialists), ...specialists];
}

/** Count of agents that need attention (status !== clear), Chief of Staff excluded. */
export function agentsNeedingAttention(briefings: AgentBriefing[]): number {
  return briefings.filter((b) => b.agentId !== 'chief_of_staff' && b.status !== 'clear').length;
}
