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
  | 'renewals';

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
    blurb: 'Get more from FamilyOS based on how your family uses it.',
    maxTokens: 700,
    allowQuestion: true,
    system:
      'You are an onboarding/optimization assistant for the FamilyOS app. Based on family size, roles, and ' +
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
};

/** Client-safe metadata (label/title/blurb/allowQuestion) without prompt internals. */
export type InsightMeta = Pick<InsightDef, 'label' | 'title' | 'blurb' | 'allowQuestion'>;
export const INSIGHT_META: Record<InsightKind, InsightMeta> = Object.fromEntries(
  Object.entries(INSIGHTS).map(([k, v]) => [k, { label: v.label, title: v.title, blurb: v.blurb, allowQuestion: v.allowQuestion }]),
) as Record<InsightKind, InsightMeta>;

export function isInsightKind(x: unknown): x is InsightKind {
  return typeof x === 'string' && x in INSIGHTS;
}
