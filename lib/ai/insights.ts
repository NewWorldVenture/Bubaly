// lib/ai/insights.ts — pure prompt registry for the per-module "AI Assist" feature.
//
// Each module gets a grounded AI helper. The server fetches the family's own rows
// (RLS-scoped) and hands them here as an `InsightData`; each kind turns that into a
// system + user prompt. Keeping this pure (no Supabase, no fetch) makes every prompt
// unit-testable: given data, assert the prompt carries the right facts.

export type InsightKind =
  | 'chores'
  | 'calendar'
  | 'expenses'
  | 'grocery'
  | 'homework'
  | 'medications'
  | 'shopping'
  | 'subscriptions'
  | 'todos'
  | 'trips'
  | 'wishlists'
  | 'home'
  | 'notifications'
  | 'messages'
  | 'weather'
  | 'settings'
  | 'event'
  | 'meals'
  | 'reminders'
  | 'notes'
  | 'recipes'
  | 'documents'
  | 'care'
  | 'contacts'
  | 'billing'
  | 'goals'
  | 'pets'
  | 'renewals'
  | 'school'
  | 'sports'
  | 'pantry'
  | 'announcements'
  | 'medical'
  | 'insurance'
  | 'rewards'
  | 'photos'
  | 'celebrations'
  | 'signups'
  | 'behavior'
  | 'screen_time'
  | 'binder'
  | 'memories'
  | 'timetable'
  | 'tax'
  | 'utilities'
  | 'rides'
  | 'votes'
  | 'closet'
  | 'watchlist';

export type InsightMember = { id: string; name: string };

export type InsightData = {
  familyName: string;
  /** Human-readable local date/time, e.g. "Wednesday, June 24, 2026, 3:00 PM". */
  now: string;
  members: InsightMember[];
  /** Raw rows fetched server-side, keyed by table name. */
  rows: Record<string, Record<string, unknown>[]>;
  /** Optional request params (e.g. eventId). */
  params?: Record<string, unknown>;
};

export type InsightDef = {
  /** Button label shown in the module. */
  label: string;
  /** Modal title. */
  title: string;
  /** One-line description shown under the title. */
  blurb: string;
  /** Whether the user can add a free-text question to focus the answer. */
  allowQuestion?: boolean;
  system: string;
  maxTokens: number;
  buildUser: (data: InsightData) => string;
};

// ── helpers ──────────────────────────────────────────────────────────────────
const money = (cents: number | null | undefined) =>
  typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}` : '$0.00';

const dollars = (n: number | null | undefined) =>
  typeof n === 'number' ? `$${n.toFixed(2)}` : '—';

const day = (iso: unknown) => (typeof iso === 'string' && iso ? iso.slice(0, 10) : 'no date');

function nameMap(members: InsightMember[]) {
  const m = new Map(members.map((x) => [x.id, x.name]));
  return (id: unknown) => (typeof id === 'string' && m.get(id)) || 'Unassigned';
}

/** Trim a list to N rows and note how many were omitted, so prompts stay bounded. */
function cap<T>(rows: T[], n: number): { shown: T[]; extra: number } {
  return { shown: rows.slice(0, n), extra: Math.max(0, rows.length - n) };
}

const r = (data: InsightData, table: string) => data.rows[table] ?? [];

const q = (data: InsightData) =>
  typeof data.params?.question === 'string' && (data.params.question as string).trim()
    ? `\n\nThe family specifically asks: ${(data.params.question as string).trim()}`
    : '';

const SHARED_RULES =
  'Use ONLY the household data provided — never invent items, names, dates, or amounts. ' +
  'If there is too little data to be useful, say so briefly and suggest what to add. ' +
  'Be concrete, warm, and concise. Prefer short plain-text sections and tight bullet lists over long paragraphs.';

// ── registry ───────────────────────────────────────────────────────────────
export const INSIGHTS: Record<InsightKind, InsightDef> = {
  chores: {
    label: 'AI suggestions',
    title: 'AI Chore Coach',
    blurb: 'Fairer assignments, motivation ideas, and what to tackle next.',
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are a family chore coach. Help balance the workload fairly across members, surface ' +
      'overdue or stuck chores, and suggest light motivation (streaks, point goals). ' + SHARED_RULES,
    buildUser: (d) => {
      const who = nameMap(d.members);
      const chores = cap(r(d, 'chores'), 25);
      const asg = cap(r(d, 'chore_assignments'), 40);
      const choreLines = chores.shown.map((c) => `- ${c.title} (${c.points ?? 0} pts, ${c.priority ?? 'normal'}${c.category ? `, ${c.category}` : ''})`).join('\n') || 'none';
      const asgLines = asg.shown.map((a) => `- ${who(a.member_id)}: ${a.status}${a.due_at ? ` (due ${day(a.due_at)})` : ''}`).join('\n') || 'none';
      return `Family: ${d.familyName}. Now: ${d.now}.\nMembers: ${d.members.map((m) => m.name).join(', ') || 'none'}\n\nActive chores:\n${choreLines}\n\nCurrent assignments:\n${asgLines}\n\nGive: (1) a quick read on workload balance, (2) 2–4 concrete suggested assignments or swaps, (3) one motivation idea.${q(d)}`;
    },
  },

  calendar: {
    label: 'AI week ahead',
    title: 'AI Calendar Assistant',
    blurb: 'A clear read on the week ahead, conflicts, and prep tips.',
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are a family scheduling assistant. Summarize the days ahead, flag tight back-to-back ' +
      'events or likely conflicts, and suggest prep or logistics (rides, meals, reminders). ' + SHARED_RULES,
    buildUser: (d) => {
      const who = nameMap(d.members);
      const ev = cap(r(d, 'calendar_events'), 40);
      const lines = ev.shown.map((e) => `- ${e.title} — ${typeof e.starts_at === 'string' ? e.starts_at.slice(0, 16).replace('T', ' ') : '?'}${e.all_day ? ' (all day)' : ''}${e.location ? ` @ ${e.location}` : ''}${e.assignee_id ? ` [${who(e.assignee_id)}]` : ''} (${e.category})`).join('\n') || 'none';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nUpcoming events:\n${lines}${ev.extra ? `\n…and ${ev.extra} more` : ''}\n\nGive: (1) a friendly summary of the week ahead, (2) any conflicts or tight transitions, (3) 2–3 prep suggestions.${q(d)}`;
    },
  },

  expenses: {
    label: 'AI spending insights',
    title: 'AI Spending Insights',
    blurb: 'Where the money went and easy ways to save.',
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are a household budgeting assistant. Analyze recent shared expenses, highlight the ' +
      'biggest categories and any spikes, and suggest realistic ways to save. ' + SHARED_RULES,
    buildUser: (d) => {
      const rows = r(d, 'expense_splits');
      const total = rows.reduce((s, e) => s + (Number(e.total_cents) || 0), 0);
      const byCat = new Map<string, number>();
      rows.forEach((e) => byCat.set((e.category as string) || 'Uncategorized', (byCat.get((e.category as string) || 'Uncategorized') || 0) + (Number(e.total_cents) || 0)));
      const catLines = [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([c, v]) => `- ${c}: ${money(v)}`).join('\n') || 'none';
      const recent = cap(rows, 20).shown.map((e) => `- ${day(e.spent_on)} ${e.description}: ${money(Number(e.total_cents))}${e.category ? ` (${e.category})` : ''}`).join('\n') || 'none';
      return `Family: ${d.familyName}. Now: ${d.now}.\nTotal of recent expenses: ${money(total)} across ${rows.length} entries.\n\nBy category:\n${catLines}\n\nRecent entries:\n${recent}\n\nGive: (1) a short spending summary, (2) the top categories and anything notable, (3) 2–4 specific savings ideas.${q(d)}`;
    },
  },

  grocery: {
    label: 'AI organize & suggest',
    title: 'AI Grocery Helper',
    blurb: 'Tidy the list by aisle and spot missing staples.',
    maxTokens: 600,
    allowQuestion: true,
    system:
      'You are a grocery-list assistant. Organize items by store aisle/section, point out likely ' +
      'duplicates, and suggest commonly-forgotten staples that fit what is already on the list. ' + SHARED_RULES,
    buildUser: (d) => {
      const items = cap(r(d, 'grocery_items'), 60);
      const lines = items.shown.map((i) => `- ${i.name}${i.quantity ? ` (${i.quantity})` : ''}${i.category ? ` [${i.category}]` : ''}`).join('\n') || 'none';
      return `Family: ${d.familyName}.\n\nGrocery list (unchecked items):\n${lines}${items.extra ? `\n…and ${items.extra} more` : ''}\n\nGive: (1) the list grouped by aisle/section, (2) any duplicates to merge, (3) 3–5 staples they may have forgotten.${q(d)}`;
    },
  },

  homework: {
    label: 'AI study plan',
    title: 'AI Homework Planner',
    blurb: 'Prioritize assignments and build a realistic study plan.',
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are a supportive study coach for a family with kids. Prioritize assignments by due ' +
      'date and effort, suggest an order to tackle them, and offer one focus/study tip. Keep it encouraging. ' + SHARED_RULES,
    buildUser: (d) => {
      const who = nameMap(d.members);
      const hw = cap(r(d, 'homework_assignments'), 40);
      const lines = hw.shown.map((h) => `- ${h.title}${h.subject ? ` (${h.subject})` : ''} — ${who(h.member_id)}, ${h.status}${h.due_at ? `, due ${day(h.due_at)}` : ''}`).join('\n') || 'none';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nOpen homework:\n${lines}\n\nGive: (1) what to do first and why, (2) a simple day-by-day plan for the next few days, (3) one study tip.${q(d)}`;
    },
  },

  medications: {
    label: 'AI med insights',
    title: 'AI Medication Helper',
    blurb: 'Adherence reminders and schedule tips. Not medical advice.',
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are a careful medication-organization assistant for a family. You are NOT a doctor and you do ' +
      'NOT give medical advice, dosing changes, or diagnoses. Help ONLY with organization: spotting gaps in ' +
      'the schedule, adherence/reminder ideas, and questions worth asking a pharmacist or doctor (e.g. possible ' +
      'interactions to confirm — never assert them). Always end with: "For anything medical, check with your doctor or pharmacist." ' + SHARED_RULES,
    buildUser: (d) => {
      const who = nameMap(d.members);
      const meds = cap(r(d, 'medications'), 30);
      const sched = r(d, 'medication_schedules');
      const schedByMed = new Map<string, string[]>();
      sched.forEach((s) => {
        const arr = schedByMed.get(s.medication_id as string) ?? [];
        arr.push(String(s.time_of_day));
        schedByMed.set(s.medication_id as string, arr);
      });
      const lines = meds.shown.map((m) => `- ${m.name}${m.dosage ? ` ${m.dosage}` : ''} — ${who(m.member_id)}${(schedByMed.get(m.id as string) || []).length ? `, times: ${(schedByMed.get(m.id as string) || []).join(', ')}` : ', no schedule set'}${m.instructions ? ` (${m.instructions})` : ''}`).join('\n') || 'none';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nActive medications:\n${lines}\n\nGive: (1) any schedule gaps or meds without reminders, (2) practical adherence ideas, (3) questions worth asking a pharmacist.${q(d)}`;
    },
  },

  shopping: {
    label: 'AI shopping tips',
    title: 'AI Shopping Assistant',
    blurb: 'Budget-savvy buying tips and what to bundle.',
    maxTokens: 600,
    allowQuestion: true,
    system:
      'You are a savvy shopping assistant. From the items to buy, suggest where bulk/own-brand swaps save ' +
      'money, what to bundle into one trip, and a sensible store order. ' + SHARED_RULES,
    buildUser: (d) => {
      const items = cap(r(d, 'grocery_items'), 60);
      const lines = items.shown.map((i) => `- ${i.name}${i.quantity ? ` (${i.quantity})` : ''}${i.category ? ` [${i.category}]` : ''}`).join('\n') || 'none';
      return `Family: ${d.familyName}.\n\nItems to buy:\n${lines}${items.extra ? `\n…and ${items.extra} more` : ''}\n\nGive: (1) money-saving swaps, (2) what to bundle / one-trip plan, (3) a smart order to shop in.${q(d)}`;
    },
  },

  subscriptions: {
    label: 'AI savings finder',
    title: 'AI Subscription Auditor',
    blurb: 'Find unused, overlapping, or pricey subscriptions to cut.',
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are a subscription-savings auditor. Find likely-unused subscriptions (stale "last used"), ' +
      'overlapping services, and the priciest recurring costs. Estimate monthly and annual savings from cuts. ' + SHARED_RULES,
    buildUser: (d) => {
      const subs = r(d, 'subscriptions_tracked');
      const monthly = subs.reduce((s, x) => {
        const c = Number(x.cost_cents) || 0;
        const cad = String(x.cadence || 'monthly');
        return s + (cad === 'yearly' ? c / 12 : cad === 'weekly' ? c * 4.33 : c);
      }, 0);
      const lines = cap(subs, 40).shown.map((x) => `- ${x.name}: ${money(Number(x.cost_cents))}/${x.cadence}${x.status ? `, ${x.status}` : ''}${x.last_used ? `, last used ${day(x.last_used)}` : ', never marked used'}${x.next_charge ? `, next ${day(x.next_charge)}` : ''}`).join('\n') || 'none';
      return `Family: ${d.familyName}. Now: ${d.now}.\nEstimated total: ${money(Math.round(monthly))}/month.\n\nTracked subscriptions:\n${lines}\n\nGive: (1) candidates to cancel and why, (2) overlaps, (3) estimated monthly + annual savings if they act.${q(d)}`;
    },
  },

  todos: {
    label: 'AI prioritize',
    title: 'AI To-Do Assistant',
    blurb: 'Prioritize, group, and break big tasks down.',
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are a productivity assistant for a busy family. Prioritize open to-dos by urgency and impact, ' +
      'group related ones, and break any vague/large task into clear next steps. ' + SHARED_RULES,
    buildUser: (d) => {
      const who = nameMap(d.members);
      const todos = cap(r(d, 'todo_items'), 50);
      const lines = todos.shown.map((t) => `- ${t.title} (${t.priority || 'normal'})${t.due_date ? `, due ${day(t.due_date)}` : ''}${t.assigned_to_id ? ` — ${who(t.assigned_to_id)}` : ''}`).join('\n') || 'none';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nOpen to-dos:\n${lines}\n\nGive: (1) a prioritized top 3 for today, (2) sensible groupings, (3) next-step breakdown for any large/vague item.${q(d)}`;
    },
  },

  trips: {
    label: 'AI trip helper',
    title: 'AI Trip Planner',
    blurb: 'Packing ideas, itinerary gaps, and to-dos before you go.',
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are a family travel planner. From the trip and its items, suggest a packing checklist tailored to ' +
      'the destination/dates, point out itinerary or logistics gaps, and list pre-trip to-dos. ' + SHARED_RULES,
    buildUser: (d) => {
      const trips = r(d, 'trips');
      const items = r(d, 'trip_items');
      const tLines = cap(trips, 10).shown.map((t) => `- ${t.name}${t.destination ? ` → ${t.destination}` : ''} (${day(t.start_date)} to ${day(t.end_date)}, ${t.status})`).join('\n') || 'none';
      const iLines = cap(items, 40).shown.map((i) => `- [${i.kind}] ${i.label}${i.is_done ? ' ✓' : ''}${i.due_at ? ` (due ${day(i.due_at)})` : ''}`).join('\n') || 'none';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nTrips:\n${tLines}\n\nTrip items:\n${iLines}\n\nGive: (1) a packing checklist for the nearest trip, (2) itinerary/logistics gaps, (3) pre-trip to-dos.${q(d)}`;
    },
  },

  wishlists: {
    label: 'AI gift ideas',
    title: 'AI Gift Assistant',
    blurb: 'Thoughtful gift ideas and budget pairings.',
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are a thoughtful gift assistant. From wishlist items, suggest complementary gift ideas in a ' +
      'similar style/price, flag good-value picks, and help match gifts to budgets. ' + SHARED_RULES,
    buildUser: (d) => {
      const who = nameMap(d.members);
      const items = cap(r(d, 'wishlist_items'), 40);
      const lines = items.shown.map((i) => `- ${who(i.member_id)} wants: ${i.title}${i.price != null ? ` (${dollars(Number(i.price))})` : ''}, priority ${i.priority}${i.is_purchased ? ' [purchased]' : ''}`).join('\n') || 'none';
      return `Family: ${d.familyName}.\n\nWishlist items:\n${lines}\n\nGive: (1) 3–5 complementary gift ideas with rough price ranges, (2) best-value picks already on the list, (3) a budget-friendly pairing per person.${q(d)}`;
    },
  },

  home: {
    label: 'AI home insights',
    title: 'AI Home Manager',
    blurb: 'Upcoming upkeep, overdue tasks, and seasonal maintenance.',
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are a home-maintenance assistant. From the household assets and tasks, flag overdue/upcoming ' +
      'maintenance, suggest seasonal upkeep, and note warranty or filter items worth acting on. ' + SHARED_RULES,
    buildUser: (d) => {
      const assets = cap(r(d, 'home_assets'), 30);
      const tasks = cap(r(d, 'maintenance_tasks'), 30);
      const aLines = assets.shown.map((a) => `- ${a.name}${a.category ? ` (${a.category})` : ''}${a.warranty_until ? `, warranty to ${day(a.warranty_until)}` : ''}${a.filter_size ? `, filter ${a.filter_size}` : ''}${a.last_serviced_on ? `, serviced ${day(a.last_serviced_on)}` : ''}`).join('\n') || 'none';
      const tLines = tasks.shown.map((t) => `- ${t.title} (${t.status}, ${t.priority})${t.due_at ? `, due ${day(t.due_at)}` : ''}`).join('\n') || 'none';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nHome assets:\n${aLines}\n\nMaintenance tasks:\n${tLines}\n\nGive: (1) overdue/upcoming maintenance to prioritize, (2) seasonal upkeep for this time of year, (3) warranty/filter items worth acting on.${q(d)}`;
    },
  },

  notifications: {
    label: 'AI digest',
    title: 'AI Notification Digest',
    blurb: 'A quick digest of what actually needs your attention.',
    maxTokens: 600,
    allowQuestion: false,
    system:
      'You are a notification triage assistant. Group recent notifications by theme, surface what is ' +
      'time-sensitive or needs action, and summarize the rest in a sentence. ' + SHARED_RULES,
    buildUser: (d) => {
      const n = cap(r(d, 'notifications'), 50);
      const lines = n.shown.map((x) => `- [${x.type}]${x.is_read ? '' : ' (unread)'} ${x.title}${x.body ? ` — ${x.body}` : ''}`).join('\n') || 'none';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nRecent notifications:\n${lines}\n\nGive: (1) what needs action now, (2) grouped themes, (3) a one-line "everything else" summary.`;
    },
  },

  messages: {
    label: 'AI summarize',
    title: 'AI Conversation Assistant',
    blurb: 'Catch up fast and get reply suggestions.',
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are a family-chat assistant. Summarize the recent conversation, extract any decisions, dates, ' +
      'or to-dos mentioned, and offer 2–3 short reply suggestions in a warm family tone. ' + SHARED_RULES,
    buildUser: (d) => {
      const msgs = cap(r(d, 'family_messages'), 40);
      const lines = msgs.shown.map((m) => `- ${m.sender_name || 'Someone'}: ${m.content || (m.attachment_name ? `[shared ${m.attachment_name}]` : '[no text]')}`).join('\n') || 'none';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nRecent messages (oldest first):\n${lines}\n\nGive: (1) a 2–3 sentence catch-up, (2) any decisions/dates/to-dos mentioned, (3) 2–3 suggested replies.${q(d)}`;
    },
  },

  weather: {
    label: 'AI activity ideas',
    title: 'AI Weather Planner',
    blurb: 'Family activity ideas suited to the season and place.',
    maxTokens: 600,
    allowQuestion: true,
    system:
      'You are a family activities planner. Given the saved locations and the current date/season, suggest ' +
      'a mix of indoor and outdoor activities suited to the likely weather, plus what to bring. ' +
      'You do not have a live forecast, so frame suggestions around the season and ask them to check conditions. ' + SHARED_RULES,
    buildUser: (d) => {
      const locs = cap(r(d, 'weather_locations'), 10);
      const lines = locs.shown.map((l) => `- ${l.name}${l.admin1 ? `, ${l.admin1}` : ''}${l.country ? `, ${l.country}` : ''}${l.is_default ? ' (default)' : ''}`).join('\n') || 'none';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nSaved locations:\n${lines}\n\nGive: (1) 3–4 seasonal family activity ideas (mix indoor/outdoor) for the default location, (2) what to wear/bring, (3) a reminder to check the live forecast.${q(d)}`;
    },
  },

  settings: {
    label: 'AI setup tips',
    title: 'AI Setup Assistant',
    blurb: 'Get more from Bubaly based on how your family uses it.',
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are an onboarding/optimization assistant for the Bubaly app. Based on family size, roles, and ' +
      'how much data exists in each area, recommend features to set up next and quick wins. Be specific and brief. ' + SHARED_RULES,
    buildUser: (d) => {
      const counts = Object.entries(d.rows).map(([k, v]) => `${k}: ${v.length}`).join(', ') || 'no activity yet';
      return `Family: ${d.familyName}. Now: ${d.now}.\nMembers (${d.members.length}): ${d.members.map((m) => m.name).join(', ') || 'none'}\nActivity counts: ${counts}\n\nGive: (1) the top 3 features to set up next for this family and why, (2) one quick win they can do today, (3) one tip to get the household more engaged.${q(d)}`;
    },
  },

  event: {
    label: 'AI prep',
    title: 'AI Event Prep',
    blurb: 'A tailored prep checklist for this event.',
    maxTokens: 600,
    allowQuestion: true,
    system:
      'You are an event-prep assistant. From a single calendar event, produce a short, tailored ' +
      'preparation checklist (what to bring, when to leave, who/what to arrange) based on its type, time, and location. ' + SHARED_RULES,
    buildUser: (d) => {
      const who = nameMap(d.members);
      const e = r(d, 'calendar_events')[0];
      if (!e) return `Family: ${d.familyName}. Now: ${d.now}.\n\nNo event was provided. Say you need an event to prep for.`;
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nEvent: ${e.title}\nWhen: ${typeof e.starts_at === 'string' ? e.starts_at.replace('T', ' ').slice(0, 16) : '?'}${e.all_day ? ' (all day)' : ''}\nCategory: ${e.category}\nLocation: ${e.location || 'not set'}\nFor: ${e.assignee_id ? who(e.assignee_id) : 'the family'}\nNotes: ${e.description || 'none'}\n\nGive a tight prep checklist: what to bring, when to leave (estimate), and anything to arrange beforehand.${q(d)}`;
    },
  },

  meals: {
    label: 'AI meal plan',
    title: 'AI Meal Planner',
    blurb: "Suggest balanced meals for the week based on what's on your plan.",
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are a family meal-planning assistant. Review the current meal plan and suggest improvements or ideas for the upcoming week. Consider balanced nutrition, variety, quick weeknight options, and kid-friendly choices. ' + SHARED_RULES,
    buildUser: (d) => {
      const plans = r(d, 'meal_plans').slice(0, 14);
      const meals = r(d, 'meals').slice(0, 20);
      const summary = plans.length ? `${plans.length} meals planned` : 'No meals planned yet';
      const names = meals.slice(0, 10).map((m) => m.name).filter(Boolean).join(', ');
      return `Family: ${d.familyName}. Members: ${d.members.length}. Now: ${d.now}.\nMeal plan: ${summary}.\nRecent meals: ${names || 'none'}.\n\nSuggest a balanced 7-day meal plan with: breakfast, lunch, dinner ideas, one prep-ahead tip, and one ingredient that would cover multiple meals.${q(d)}`;
    },
  },

  reminders: {
    label: 'AI reminders',
    title: 'AI Reminder Assistant',
    blurb: 'Review upcoming reminders and suggest what to prioritize.',
    maxTokens: 600,
    allowQuestion: true,
    system:
      'You are a family scheduling assistant. Review upcoming reminders and help the family stay on top of important tasks. Flag anything overdue, cluster related reminders, and suggest smart snooze or delegation strategies. ' + SHARED_RULES,
    buildUser: (d) => {
      const reminders = r(d, 'family_reminders').slice(0, 20);
      const list = reminders.map((r) => `- ${r.title} (due: ${r.due_at || 'no date'}, kind: ${r.kind || 'general'})`).join('\n') || 'No reminders.';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nReminders:\n${list}\n\nIdentify: (1) anything overdue or due soon, (2) what to prioritize today, (3) one reminder to snooze or delegate.${q(d)}`;
    },
  },

  notes: {
    label: 'AI notes',
    title: 'AI Note Assistant',
    blurb: 'Summarize, organize, or extract action items from your notes.',
    maxTokens: 600,
    allowQuestion: true,
    system:
      'You are a personal notes assistant. Help the family summarize, categorize, and extract actionable next steps from their notes. Suggest tags, follow-ups, or connections between notes. ' + SHARED_RULES,
    buildUser: (d) => {
      const notes = r(d, 'notes').slice(0, 10);
      const list = notes.map((n) => `- "${n.title || 'Untitled'}": ${String(n.content || '').slice(0, 120)}`).join('\n') || 'No notes yet.';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nNotes (most recent):\n${list}\n\nGive: (1) a 2-sentence summary of key themes, (2) top 2 action items hidden in these notes, (3) one suggestion to organize better.${q(d)}`;
    },
  },

  recipes: {
    label: 'AI recipe ideas',
    title: 'AI Recipe Suggester',
    blurb: 'Get recipe ideas based on what\'s in your pantry and meal history.',
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are a creative family chef assistant. Suggest recipes that use available ingredients, match dietary preferences, and the family will enjoy. Prioritize quick weeknight dinners and one fun weekend project. ' + SHARED_RULES,
    buildUser: (d) => {
      const recipes = r(d, 'recipes').slice(0, 15);
      const pantry = r(d, 'pantry_items').slice(0, 20);
      const recipeNames = recipes.map((r) => r.name).filter(Boolean).join(', ') || 'none saved';
      const ingredients = pantry.map((p) => p.name).filter(Boolean).join(', ') || 'none tracked';
      return `Family: ${d.familyName}. Members: ${d.members.length}. Now: ${d.now}.\nSaved recipes: ${recipeNames}.\nPantry items: ${ingredients}.\n\nSuggest 3 recipe ideas: 2 quick weeknight dinners (under 30 min) and 1 weekend project. Include key ingredients needed.${q(d)}`;
    },
  },

  documents: {
    label: 'AI document help',
    title: 'AI Document Assistant',
    blurb: 'Organize, summarize, or find what you need in your family documents.',
    maxTokens: 600,
    allowQuestion: true,
    system:
      'You are a family document management assistant. Help organize, categorize, and surface important information from stored documents. Flag anything that may be expiring, needs action, or could be better organized. ' + SHARED_RULES,
    buildUser: (d) => {
      const docs = r(d, 'documents').slice(0, 15);
      const list = docs.map((doc) => `- "${doc.name || doc.original_name || 'Untitled'}" (${doc.category || 'uncategorized'}, ${doc.created_at ? String(doc.created_at).slice(0, 10) : 'unknown date'})`).join('\n') || 'No documents stored.';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nDocuments:\n${list}\n\nGive: (1) any documents that may need attention or renewal, (2) categories that seem disorganized, (3) one thing to do to improve the document vault.${q(d)}`;
    },
  },

  care: {
    label: 'AI care summary',
    title: 'AI Care Log Summary',
    blurb: 'Summarize care activities and suggest what to track next.',
    maxTokens: 600,
    allowQuestion: true,
    system:
      'You are a compassionate family care assistant. Review care log entries and help the family track patterns, identify care gaps, and plan upcoming care activities. Be empathetic and practical. ' + SHARED_RULES,
    buildUser: (d) => {
      const entries = r(d, 'care_logs').slice(0, 15);
      const list = entries.map((e) => `- ${e.care_type || 'General'}: ${e.notes || 'no notes'} (${String(e.occurred_at || e.created_at || '').slice(0, 10)})`).join('\n') || 'No care entries logged.';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nCare log entries:\n${list}\n\nGive: (1) a brief summary of care activities, (2) any patterns or gaps in care, (3) one care task to schedule soon.${q(d)}`;
    },
  },

  contacts: {
    label: 'AI contacts',
    title: 'AI Contact Helper',
    blurb: 'Organize contacts and surface important follow-ups.',
    maxTokens: 500,
    allowQuestion: true,
    system:
      'You are a family contacts and relationship assistant. Help organize contacts, identify who to follow up with, and suggest ways to strengthen important relationships. ' + SHARED_RULES,
    buildUser: (d) => {
      const contacts = r(d, 'contacts').slice(0, 20);
      const list = contacts.slice(0, 12).map((c) => `- ${c.name || 'Unknown'} (${c.category || 'general'})`).join('\n') || 'No contacts saved.';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nContacts (${contacts.length} total):\n${list}\n\nGive: (1) categories that could be better organized, (2) 1-2 contact types the family should add, (3) one relationship to nurture this week.${q(d)}`;
    },
  },

  billing: {
    label: 'AI finance insight',
    title: 'AI Finance Insight',
    blurb: 'Review your family finances and identify savings opportunities.',
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are a family financial wellness assistant. Review the family\'s finances (subscriptions, expenses, billing) and give practical, actionable advice. Focus on savings, categorization, and budget priorities. Never give investment advice. ' + SHARED_RULES,
    buildUser: (d) => {
      const subs = r(d, 'subscriptions').slice(0, 15);
      const expenses = r(d, 'expenses').slice(0, 20);
      const subList = subs.map((s) => `- ${s.name}: $${s.amount || '?'}/${s.billing_period || 'mo'}`).join('\n') || 'No subscriptions.';
      const expTotal = expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nSubscriptions:\n${subList}\n\nRecent expenses: ${expenses.length} items, total ~$${expTotal.toFixed(0)}.\n\nGive: (1) subscriptions to consider canceling, (2) top spending category to review, (3) one money-saving action for this month.${q(d)}`;
    },
  },

  goals: {
    label: 'AI goal coach',
    title: 'AI Goal Coach',
    blurb: 'Review family goals and get coaching on what to focus on next.',
    maxTokens: 600,
    allowQuestion: true,
    system:
      'You are a family goal-setting coach. Review active goals, celebrate progress, and give practical next steps. Encourage without overwhelming. Keep focus on the 1-2 most impactful goals. ' + SHARED_RULES,
    buildUser: (d) => {
      const goals = r(d, 'family_goals').slice(0, 10);
      const list = goals.map((g) => `- ${g.title || 'Goal'}: ${g.progress || 0}% complete (${g.status || 'active'})`).join('\n') || 'No goals set yet.';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nGoals:\n${list}\n\nGive: (1) congratulate any recent progress, (2) the 1 goal to focus on this week and why, (3) one small action to take today toward it.${q(d)}`;
    },
  },

  pets: {
    label: 'AI pet care',
    title: 'AI Pet Care Assistant',
    blurb: 'Track pet care, upcoming vet visits, and wellness tips.',
    maxTokens: 600,
    allowQuestion: true,
    system:
      'You are a friendly pet care assistant. Review the family\'s pets and their care records. Flag any upcoming care tasks, vet appointments, or wellness concerns. Give practical, loving advice. ' + SHARED_RULES,
    buildUser: (d) => {
      const pets = r(d, 'pets').slice(0, 8);
      const list = pets.map((p) => `- ${p.name || 'Pet'} (${p.species || '?'}, ${p.breed || 'mixed'})`).join('\n') || 'No pets logged.';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nPets:\n${list}\n\nGive: (1) any upcoming vet or care tasks to schedule, (2) one wellness tip for the most recent pet, (3) one thing to track in the pet log.${q(d)}`;
    },
  },

  closet: {
    label: 'AI stylist',
    title: 'AI Closet Stylist',
    blurb: 'Outfits for today from what each person actually owns, plus gaps and items to retire.',
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are a practical family stylist. Work ONLY from the closet inventory and recent outfit logs provided. ' +
      'Suggest outfits by combining real items (name them exactly), respect each member\'s items only, prefer pieces not worn recently, ' +
      'and keep advice age-appropriate and budget-aware. ' + SHARED_RULES,
    buildUser: (d) => {
      const who = nameMap(d.members);
      const items = r(d, 'wardrobe_items');
      const byMember = new Map<string, string[]>();
      for (const i of items) {
        const key = who(i.member_id);
        const line = `${i.name} [${i.category}${i.color ? `, ${i.color}` : ''}, warmth ${i.warmth}/5, formality ${i.formality}/5${i.status !== 'active' ? `, ${i.status}` : ''}${i.last_worn_on ? `, last worn ${day(i.last_worn_on)}` : ', never worn'}]`;
        byMember.set(key, [...(byMember.get(key) ?? []), line]);
      }
      const closet = [...byMember.entries()].map(([name, lines]) => {
        const c = cap(lines, 30);
        return `${name}:\n${c.shown.map((l) => `- ${l}`).join('\n')}${c.extra ? `\n- …and ${c.extra} more` : ''}`;
      }).join('\n\n') || 'No items in the closet yet.';
      const logs = cap(r(d, 'outfit_logs'), 20).shown
        .map((l) => `- ${day(l.worn_on)} ${who(l.member_id)}: ${l.occasion || 'everyday'}${typeof l.temp_c === 'number' ? ` at ${l.temp_c}°C` : ''}`)
        .join('\n') || 'No outfits logged yet.';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nCloset by member:\n${closet}\n\nRecent outfit logs:\n${logs}\n\nGive: (1) one outfit for today per member using only their items (assume mild weather unless told otherwise), (2) the two most useful gaps to buy next, (3) items to retire, donate, or move to storage, with a reason each.${q(d)}`;
    },
  },

  watchlist: {
    label: 'AI movie night',
    title: 'AI Movie Night Picker',
    blurb: 'Tonight’s pick for the people on the couch, from the family’s own watchlist and votes.',
    maxTokens: 650,
    allowQuestion: true,
    system:
      'You are the family\'s movie-night host. Work ONLY from the watchlist, votes and recent sessions provided. ' +
      'Respect age ratings for the youngest viewer, keep runtimes realistic for a school night, and never recommend a title that is not on the list. ' + SHARED_RULES,
    buildUser: (d) => {
      const who = nameMap(d.members);
      const votes = r(d, 'watchlist_votes');
      const votesFor = (id: unknown) => votes.filter((v) => v.title_id === id).map((v) => `${who(v.member_id)} ${v.vote === 'love' ? '❤️' : v.vote === 'up' ? '👍' : '👎'}`).join(', ');
      const queue = cap(r(d, 'watchlist_titles'), 40).shown
        .map((t) => `- ${t.title} (${t.kind}${t.year ? ` ${t.year}` : ''}, ${t.age_rating || 'NR'} / ${t.min_age}+, ${t.runtime_min ?? '?'} min, ${t.service}, priority ${t.priority}${t.status === 'watching' ? ', in progress' : ''})${votesFor(t.id) ? ` — votes: ${votesFor(t.id)}` : ''}`)
        .join('\n') || 'Nothing on the watchlist yet.';
      const recent = cap(r(d, 'watch_sessions'), 12).shown
        .map((s) => `- ${day(s.watched_on)}: ${s.title_name}${typeof s.rating === 'number' ? ` (${s.rating}/5)` : ''}`)
        .join('\n') || 'No movie nights logged yet.';
      const members = d.members.map((m) => m.name).join(', ') || 'the family';
      return `Family: ${d.familyName} (${members}). Now: ${d.now}.\n\nWatchlist:\n${queue}\n\nRecent movie nights:\n${recent}\n\nGive: (1) tonight's pick for the whole family with a one-line why, (2) a backup if the youngest goes to bed early, (3) two titles worth adding based on what they rated highly.${q(d)}`;
    },
  },

  renewals: {
    label: 'AI renewal alerts',
    title: 'AI Renewal Tracker',
    blurb: 'Review upcoming renewals and decide what to renew, cancel, or switch.',
    maxTokens: 600,
    allowQuestion: true,
    system:
      'You are a family renewal and subscription management assistant. Help families stay on top of expiring memberships, licenses, insurance, and subscriptions. Give clear action items. ' + SHARED_RULES,
    buildUser: (d) => {
      const renewals = r(d, 'renewals').slice(0, 15);
      const list = renewals.map((r) => `- ${r.name || 'Item'}: expires ${r.renewal_date || r.expires_at || 'unknown'} ($${r.annual_cost || r.cost || '?'}/yr)`).join('\n') || 'No renewals tracked.';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nRenewals:\n${list}\n\nGive: (1) what expires in the next 30 days, (2) anything worth shopping for a better deal, (3) one renewal to cancel.${q(d)}`;
    },
  },

  school: {
    label: 'AI school coach',
    title: 'AI School Coach',
    blurb: 'Review grades, assignments, and school schedule for insights.',
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are a supportive academic coach for families. Review school assignments, grades, and schedules. Flag overdue work, celebrate achievements, and suggest study strategies. Be encouraging and age-appropriate. ' + SHARED_RULES,
    buildUser: (d) => {
      const assignments = r(d, 'homework_assignments').slice(0, 15);
      const grades = r(d, 'grades').slice(0, 10);
      const aList = assignments.map((a) => `- ${a.title || 'Assignment'} (${a.status || 'pending'}, due: ${a.due_at ? String(a.due_at).slice(0, 10) : 'no date'})`).join('\n') || 'No assignments.';
      const gList = grades.slice(0, 6).map((g) => `- ${g.subject || 'Subject'}: ${g.grade || g.score || '?'}`).join('\n') || 'No grades.';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nAssignments:\n${aList}\n\nRecent grades:\n${gList}\n\nGive: (1) assignments overdue or due soon, (2) subject areas needing attention, (3) one encouragement or study tip.${q(d)}`;
    },
  },

  sports: {
    label: 'AI sports coach',
    title: 'AI Sports Assistant',
    blurb: 'Track game schedules, team performance, and training tips.',
    maxTokens: 600,
    allowQuestion: true,
    system:
      'You are an enthusiastic family sports assistant. Review upcoming games, team results, and schedules. Give practical tips for game-day preparation, encourage young athletes, and suggest training ideas. ' + SHARED_RULES,
    buildUser: (d) => {
      const events = r(d, 'sports_events').slice(0, 10);
      const teams = r(d, 'sports_teams').slice(0, 5);
      const eList = events.map((e) => `- ${e.title || 'Game'} (${String(e.starts_at || e.event_date || '').slice(0, 10)}, ${e.home_away || ''} at ${e.location || 'TBD'})`).join('\n') || 'No events.';
      const tList = teams.map((t) => `- ${t.name || 'Team'} (${t.sport || 'sport'}, W:${t.wins || 0} L:${t.losses || 0})`).join('\n') || 'No teams.';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nTeams:\n${tList}\n\nUpcoming events:\n${eList}\n\nGive: (1) next game to prepare for, (2) one game-day tip, (3) one training idea for this week.${q(d)}`;
    },
  },

  pantry: {
    label: 'AI pantry check',
    title: 'AI Pantry Assistant',
    blurb: 'See what needs restocking and get meal ideas from what you have.',
    maxTokens: 600,
    allowQuestion: true,
    system:
      'You are a smart pantry and kitchen assistant. Review pantry inventory and suggest what to restock, what meals can be made with current items, and how to reduce food waste. ' + SHARED_RULES,
    buildUser: (d) => {
      const items = r(d, 'pantry_items').slice(0, 30);
      const low = items.filter((i) => i.is_low_stock || i.quantity === 0 || Number(i.quantity) <= 1);
      const allNames = items.slice(0, 20).map((i) => i.name).filter(Boolean).join(', ') || 'none tracked';
      const lowNames = low.slice(0, 10).map((i) => i.name).filter(Boolean).join(', ') || 'none';
      return `Family: ${d.familyName}. Members: ${d.members.length}. Now: ${d.now}.\n\nPantry items: ${allNames}.\nLow stock: ${lowNames}.\n\nGive: (1) top 5 items to restock this week, (2) a quick dinner idea from current pantry, (3) one item to use before it expires.${q(d)}`;
    },
  },

  announcements: {
    label: 'AI announcement',
    title: 'AI Announcement Writer',
    blurb: 'Draft a family announcement or summarize recent family news.',
    maxTokens: 500,
    allowQuestion: true,
    system:
      'You are a warm, friendly family communications assistant. Help draft announcements, summarize recent family news, or suggest what to share with the family. Keep tone positive and appropriate for all ages. ' + SHARED_RULES,
    buildUser: (d) => {
      const posts = r(d, 'announcements').slice(0, 8);
      const list = posts.map((p) => `- "${p.title || 'Post'}": ${String(p.content || '').slice(0, 80)}`).join('\n') || 'No announcements yet.';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nRecent announcements:\n${list}\n\nGive: (1) a summary of recent family news, (2) one suggested announcement to make this week, (3) one question to spark family conversation.${q(d)}`;
    },
  },

  medical: {
    label: 'AI medical review',
    title: 'AI Medical Records Assistant',
    blurb: 'Review health records and flag anything that needs attention.',
    maxTokens: 600,
    allowQuestion: true,
    system:
      'You are a helpful family health records assistant (NOT a doctor). You help families organize and understand their health records, flag upcoming appointments, and identify gaps in care. Always recommend consulting a healthcare provider for medical decisions. ' + SHARED_RULES,
    buildUser: (d) => {
      const records = r(d, 'medical_records').slice(0, 15);
      const appointments = r(d, 'appointments').slice(0, 10);
      const rList = records.slice(0, 8).map((r) => `- ${r.type || 'Record'}: ${r.provider || ''} (${String(r.date || r.created_at || '').slice(0, 10)})`).join('\n') || 'No records.';
      const aList = appointments.slice(0, 5).map((a) => `- ${a.appointment_type || 'Appt'} with ${a.provider_name || '?'} on ${String(a.appointment_date || '').slice(0, 10)}`).join('\n') || 'No appointments.';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nMedical records:\n${rList}\n\nAppointments:\n${aList}\n\nGive: (1) upcoming appointments to prepare for, (2) any records that look like they need follow-up, (3) one preventive care action to take.${q(d)}`;
    },
  },

  insurance: {
    label: 'AI insurance review',
    title: 'AI Insurance Assistant',
    blurb: 'Review your insurance policies and identify coverage gaps.',
    maxTokens: 600,
    allowQuestion: true,
    system:
      'You are a family insurance advisor. Help families understand their coverage, identify gaps, and flag expiring policies. Always recommend consulting a licensed insurance professional for specific advice. ' + SHARED_RULES,
    buildUser: (d) => {
      const policies = r(d, 'insurance_policies').slice(0, 10);
      const list = policies.map((p) => `- ${p.policy_type || 'Policy'}: ${p.insurer || '?'} | $${p.premium || '?'}/yr | expires: ${String(p.renewal_date || p.expires_at || '').slice(0, 10)}`).join('\n') || 'No policies tracked.';
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nInsurance policies:\n${list}\n\nGive: (1) policies expiring in 60 days, (2) coverage type that seems missing for this family size, (3) one cost-saving action.${q(d)}`;
    },
  },

  rewards: {
    label: 'AI rewards coach',
    title: 'AI Rewards Coach',
    blurb: 'Motivate kids with personalized reward suggestions.',
    maxTokens: 500,
    allowQuestion: true,
    system:
      'You are an encouraging family rewards and motivation coach. Review kids\' points, chore completion, and reward redemptions. Suggest motivating rewards and positive reinforcement strategies. ' + SHARED_RULES,
    buildUser: (d) => {
      const assignments = r(d, 'chore_assignments').slice(0, 20);
      const redemptions = r(d, 'reward_redemptions').slice(0, 10);
      const totalPoints = assignments.filter((a) => a.status === 'approved' || a.status === 'done')
        .reduce((s, a) => s + (Number(a.points_awarded) || 0), 0);
      const pending = assignments.filter((a) => a.status === 'todo' || a.status === 'in_progress').length;
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nTotal points earned: ${totalPoints}. Pending chores: ${pending}. Recent redemptions: ${redemptions.length}.\n\nGive: (1) one motivating observation about progress, (2) two reward ideas that would excite kids, (3) one strategy to keep engagement high.${q(d)}`;
    },
  },

  photos: {
    label: 'AI photo memory',
    title: 'AI Photo & Memory Assistant',
    blurb: 'Organize photos and create meaningful family memories.',
    maxTokens: 500,
    allowQuestion: true,
    system:
      'You are a warm family memory keeper. Help families organize their photo collection, create albums, and capture meaningful moments. Suggest creative ways to preserve and share family memories. ' + SHARED_RULES,
    buildUser: (d) => {
      const photos = r(d, 'photos').slice(0, 20);
      const albums = r(d, 'photo_albums').slice(0, 10);
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nPhotos: ${photos.length} total. Albums: ${albums.length}.\n\nGive: (1) a memory-keeping idea for this week, (2) one album to create from recent photos, (3) one creative way to share memories with family.${q(d)}`;
    },
  },

  celebrations: {
    label: 'AI celebration planner',
    title: 'AI Celebration Planner',
    blurb: 'Never miss a birthday or anniversary — get ideas for meaningful celebrations.',
    maxTokens: 500,
    allowQuestion: true,
    system:
      'You are a thoughtful family celebration planner. Help families prepare for upcoming birthdays, anniversaries, and special dates. Suggest meaningful, personalized celebration ideas that fit different ages and budgets. ' + SHARED_RULES,
    buildUser: (d) => {
      const dates = r(d, 'family_dates').slice(0, 20);
      const upcoming = dates.filter((dt) => {
        const dStr = dt.date as string;
        if (!dStr) return false;
        const thisYear = new Date().getFullYear();
        const next = new Date(`${thisYear}-${dStr.slice(5, 10)}`);
        if (next < new Date()) next.setFullYear(thisYear + 1);
        const diff = (next.getTime() - Date.now()) / 86400000;
        return diff >= 0 && diff <= 60;
      });
      return `Family: ${d.familyName}. Now: ${d.now}. Members: ${d.members.map((m) => m.name).join(', ')}.\n\nUpcoming celebrations (next 60 days): ${upcoming.length > 0 ? JSON.stringify(upcoming.map((dt) => ({ name: dt.name, type: dt.type, date: dt.date }))) : 'none found'}. Total saved dates: ${dates.length}.\n\nGive: (1) alert for any celebration within 2 weeks, (2) two creative ideas for the soonest upcoming occasion, (3) one year-round tradition to start.${q(d)}`;
    },
  },

  signups: {
    label: 'AI activity advisor',
    title: 'AI Activity & Signups Advisor',
    blurb: 'Stay on top of registration deadlines and find the right activities for your kids.',
    maxTokens: 500,
    allowQuestion: true,
    system:
      'You are a helpful family activity coordinator. Help families track registration deadlines, evaluate activity options, and balance kids\' schedules. Prioritize upcoming deadlines and suggest how to avoid over-scheduling. ' + SHARED_RULES,
    buildUser: (d) => {
      const opps = r(d, 'opportunities').slice(0, 30);
      const open = opps.filter((o) => o.status !== 'closed' && o.status !== 'passed');
      const urgent = open.filter((o) => {
        if (!o.deadline) return false;
        const diff = (new Date(o.deadline as string).getTime() - Date.now()) / 86400000;
        return diff >= 0 && diff <= 14;
      });
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nOpen opportunities: ${open.length}. Deadlines within 14 days: ${urgent.length}${urgent.length > 0 ? ': ' + JSON.stringify(urgent.map((o) => ({ name: o.name, deadline: o.deadline, type: o.type }))) : ''}.\n\nGive: (1) urgent deadline alerts if any, (2) advice on prioritizing which activities to sign up for, (3) one tip for managing a balanced activity schedule.${q(d)}`;
    },
  },

  behavior: {
    label: 'AI behavior coach',
    title: 'AI Behavior & Wellness Coach',
    blurb: 'Understand behavioral patterns and get positive strategies for your family.',
    maxTokens: 600,
    allowQuestion: true,
    system:
      'You are a supportive family behavior coach grounded in positive psychology. Analyze behavior log patterns and suggest constructive strategies. Always be encouraging, non-judgmental, and focus on growth. ' + SHARED_RULES,
    buildUser: (d) => {
      const logs = r(d, 'behavior_logs').slice(0, 30);
      const positive = logs.filter((l) => l.sentiment === 'positive' || (l.score as number) > 0).length;
      const negative = logs.filter((l) => l.sentiment === 'negative' || (l.score as number) < 0).length;
      return `Family: ${d.familyName}. Now: ${d.now}. Members: ${d.members.map((m) => m.name).join(', ')}.\n\nBehavior logs (recent ${logs.length}): ${positive} positive, ${negative} challenging. Sample: ${JSON.stringify(logs.slice(0, 5).map((l) => ({ member: l.member_id, note: l.note, sentiment: l.sentiment })))}.\n\nGive: (1) one positive pattern to celebrate, (2) one gentle strategy for any recurring challenge, (3) one family activity to reinforce positive behavior.${q(d)}`;
    },
  },

  screen_time: {
    label: 'AI screen time guide',
    title: 'AI Screen Time Advisor',
    blurb: 'Balance screen time with healthy habits and family connection.',
    maxTokens: 500,
    allowQuestion: true,
    system:
      'You are a balanced digital wellness advisor for families. Help families set healthy screen time boundaries, understand usage patterns, and create tech-free moments. Be practical and non-preachy. ' + SHARED_RULES,
    buildUser: (d) => {
      const entries = r(d, 'screen_time_entries').slice(0, 20);
      const limits = r(d, 'screen_time_limits').slice(0, 10);
      const totalMinutes = entries.reduce((sum, e) => sum + ((e.minutes as number) || 0), 0);
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nScreen time logs: ${entries.length} entries, ${totalMinutes} total minutes tracked. Active limits: ${limits.length}.\n\nGive: (1) one observation about screen time balance, (2) two practical ways to encourage tech-free family time, (3) one healthy screen habit to introduce this week.${q(d)}`;
    },
  },

  binder: {
    label: 'AI household guide',
    title: 'AI Household Binder Assistant',
    blurb: 'Keep your household information organized and easy to find.',
    maxTokens: 500,
    allowQuestion: true,
    system:
      'You are a meticulous household information organizer. Help families keep their household binder complete, well-organized, and actionable. Identify gaps in critical information and suggest what to add. ' + SHARED_RULES,
    buildUser: (d) => {
      const items = r(d, 'household_info').slice(0, 40);
      const categories = [...new Set(items.map((i) => i.category as string))];
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nHousehold binder: ${items.length} entries across ${categories.length} categories (${categories.join(', ')}).\n\nGive: (1) one critical category that might be missing (e.g., emergency contacts, utilities, insurance), (2) one item to update or review, (3) one tip for keeping the binder current.${q(d)}`;
    },
  },

  memories: {
    label: 'AI memory keeper',
    title: 'AI Trip Memory Keeper',
    blurb: 'Relive adventures and capture the stories behind your family trips.',
    maxTokens: 500,
    allowQuestion: true,
    system:
      'You are a nostalgic and creative family memory keeper. Help families document and celebrate their travel memories. Suggest ways to preserve stories, create mementos, and inspire future adventures. ' + SHARED_RULES,
    buildUser: (d) => {
      const memories = r(d, 'trip_memories').slice(0, 20);
      const trips = r(d, 'vacations').slice(0, 10);
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nTrip memories recorded: ${memories.length}. Vacations logged: ${trips.length}.\n\nGive: (1) one creative way to preserve a recent memory, (2) one idea for turning memories into a keepsake, (3) one suggestion for capturing better memories on the next trip.${q(d)}`;
    },
  },

  timetable: {
    label: 'AI schedule optimizer',
    title: 'AI Timetable Optimizer',
    blurb: 'Optimize class schedules and spot conflicts before they happen.',
    maxTokens: 400,
    allowQuestion: true,
    system:
      'You are a school schedule optimization expert. Help families organize class timetables, spot scheduling conflicts, and make the most of study time. Be concise and practical. ' + SHARED_RULES,
    buildUser: (d) => {
      const classes = r(d, 'school_classes').slice(0, 30);
      const byMember = d.members.map((m) => ({ name: m.name, classes: classes.filter((c) => c.member_id === m.id).length }));
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nScheduled classes: ${classes.length} total. Per student: ${JSON.stringify(byMember)}.\n\nGive: (1) one scheduling observation or potential conflict, (2) one tip to optimize the weekly study schedule, (3) one suggestion to improve academic-life balance.${q(d)}`;
    },
  },

  tax: {
    label: 'AI tax organizer',
    title: 'AI Tax Document Organizer',
    blurb: 'Keep your tax documents organized and never miss a deduction.',
    maxTokens: 500,
    allowQuestion: true,
    system:
      'You are a helpful tax document organizer (not a licensed tax advisor). Help families organize their tax documents, identify potential deductions, and stay prepared for tax season. Always recommend consulting a tax professional for advice. ' + SHARED_RULES,
    buildUser: (d) => {
      const docs = r(d, 'tax_documents').slice(0, 30);
      const years = [...new Set(docs.map((doc) => doc.tax_year as number))].sort((a, b) => b - a);
      const deductible = docs.filter((doc) => doc.is_deductible).length;
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nTax documents: ${docs.length} total across ${years.length} years (${years.slice(0, 3).join(', ')}). Deductible items: ${deductible}.\n\nGive: (1) one document category that might be missing (e.g., W-2, 1099, charitable receipts), (2) one deduction opportunity based on the documents stored, (3) one tip for staying organized year-round. Always note: consult a tax professional for personalized advice.${q(d)}`;
    },
  },

  utilities: {
    label: 'AI utility advisor',
    title: 'AI Utility Cost Advisor',
    blurb: 'Analyze utility bills and find ways to reduce household costs.',
    maxTokens: 500,
    allowQuestion: true,
    system:
      'You are a household energy and utility efficiency expert. Analyze utility bill trends and give practical, actionable advice to reduce costs and improve efficiency. Focus on high-impact changes. ' + SHARED_RULES,
    buildUser: (d) => {
      const bills = r(d, 'utility_bills').slice(0, 24);
      const totalCents = bills.reduce((sum, b) => sum + ((b.amount_cents as number) || 0), 0);
      const kinds = [...new Set(bills.map((b) => b.kind as string))];
      return `Family: ${d.familyName}. Now: ${d.now}.\n\nUtility bills tracked: ${bills.length} across ${kinds.length} utility types (${kinds.join(', ')}). Total tracked: $${(totalCents / 100).toFixed(2)}.\n\nGive: (1) one observation about spending trends, (2) two practical ways to reduce the highest bill type, (3) one energy-saving habit to introduce this month.${q(d)}`;
    },
  },

  rides: {
    label: 'AI ride coordinator',
    title: 'AI Ride Coordinator',
    blurb: 'Coordinate pickups, drop-offs, and carpools without the chaos.',
    maxTokens: 400,
    allowQuestion: true,
    system:
      'You are a helpful family logistics coordinator. Help families plan rides, identify carpool opportunities, and reduce transportation stress. Be specific and actionable. ' + SHARED_RULES,
    buildUser: (d) => {
      const rides = r(d, 'rides').slice(0, 30);
      const upcoming = rides.filter((ride) => {
        if (!ride.ride_date) return false;
        return new Date(ride.ride_date as string) >= new Date();
      });
      const pending = rides.filter((r) => r.status === 'requested' || r.status === 'pending').length;
      return `Family: ${d.familyName}. Now: ${d.now}. Members: ${d.members.map((m) => m.name).join(', ')}.\n\nUpcoming rides: ${upcoming.length}. Pending/unconfirmed: ${pending}.\n\nGive: (1) any urgent unconfirmed rides to address, (2) one carpool or consolidation opportunity, (3) one tip to streamline family transportation.${q(d)}`;
    },
  },

  votes: {
    label: 'AI decision facilitator',
    title: 'AI Family Decision Facilitator',
    blurb: 'Get insights on family polls and make collaborative decisions easier.',
    maxTokens: 400,
    allowQuestion: true,
    system:
      'You are a thoughtful family decision facilitator. Help families understand their poll results, encourage participation, and make collaborative decisions. Be encouraging and inclusive. ' + SHARED_RULES,
    buildUser: (d) => {
      const polls = r(d, 'family_polls').slice(0, 15);
      const open = polls.filter((p) => !p.is_closed).length;
      const closed = polls.filter((p) => p.is_closed).length;
      return `Family: ${d.familyName}. Now: ${d.now}. Members: ${d.members.map((m) => m.name).join(', ')}.\n\nFamily polls: ${polls.length} total (${open} open, ${closed} decided). Recent: ${JSON.stringify(polls.slice(0, 3).map((p) => ({ title: p.title, is_closed: p.is_closed })))}.\n\nGive: (1) a nudge to vote on any open polls, (2) one tip to make family decisions more inclusive, (3) one idea for a poll topic the family would enjoy.${q(d)}`;
    },
  },
};

/** Client-safe metadata (label/title/blurb/allowQuestion) without prompt internals. */
export type InsightMeta = Pick<InsightDef, 'label' | 'title' | 'blurb' | 'allowQuestion'>;
export const INSIGHT_META: Record<InsightKind, InsightMeta> = Object.fromEntries(
  Object.entries(INSIGHTS).map(([k, v]) => [k, { label: v.label, title: v.title, blurb: v.blurb, allowQuestion: v.allowQuestion }]),
) as Record<InsightKind, InsightMeta>;

export function isInsightKind(x: unknown): x is InsightKind {
  return typeof x === 'string' && x in INSIGHTS;
}
