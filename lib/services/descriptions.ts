// lib/services/descriptions.ts — what each service offers, in one sentence.
//
// Powers the "All Services" hover tooltips (and the super-admin editor). These
// are the VERSIONED DEFAULTS; a super admin can override any of them at
// /admin/services, and the override is stored in `service_descriptions` (0203)
// keyed by the service's nav route. `mergeServiceDescriptions` overlays those
// non-empty overrides on top of these defaults, so tooltips always have content
// — even before the migration is applied or any edit is made.
//
// Client-safe: no server imports. Keyed by nav href (see lib/constants/navigation.ts).

/** Default one-line descriptions, keyed by service route. */
export const SERVICE_DESCRIPTIONS: Record<string, string> = {
  // ── Suggested / AI ─────────────────────────────────────────────────────────
  '/dashboard/autopilot': 'Let the AI handle routine decisions for you — it acts on the high-confidence ones automatically and asks before anything that matters.',
  '/dashboard/briefing': 'Your morning rundown: today’s events, what needs a decision, and what was handled while you slept — in one calm scroll.',
  '/dashboard/weekly-briefing': 'A Sunday-night look at the whole week ahead: conflicts, busy days, and what to prep before it arrives.',
  '/dashboard/command-center': 'A single control room for the household — every pending action, alert, and shortcut in one dense dashboard.',
  '/dashboard/assistant': 'Chat with your family’s AI assistant — ask it anything and it turns words into real calendar events, lists, and reminders.',
  '/dashboard/moments': 'Organizes family life by moments, not menus — Morning, School, Dinner, Vacation, Birthday — each with everything that moment needs.',
  '/dashboard/next-best-actions': 'The few highest-impact things to do right now, ranked — so you always know what to tackle next.',
  '/dashboard/family-operating-index': 'A single 0–100 score for how smoothly your household is running, with the dimensions dragging it up or down.',
  '/dashboard/outcomes': 'Tracks the results the family actually cares about — time saved, decisions handled, stress reduced — not just activity.',
  '/dashboard/agents': 'Your roster of specialist AI agents (planner, scheduler, researcher) and everything they’ve done for you.',
  '/dashboard/graph': 'Sees your household as a connected web — how a rained-out game ripples to carpool, dinner, and bedtime — so the AI can reason across it.',
  '/dashboard/decisions': 'Turns a tough family choice into options, trade-offs, and a recommendation everyone can weigh in on.',
  '/dashboard/prep-plans': 'Auto-generated checklists for what’s coming — a trip, a first day of school, a party — so nothing gets forgotten.',
  '/dashboard/intelligence': 'Anonymous, opt-in insights from families like yours — what works for households at your stage of life.',
  '/dashboard/family-signals': 'Learns the hard-to-see patterns — which reminders get ignored, when stress peaks, which routines actually stick.',
  '/dashboard/reasoning': 'The one engine behind every AI surface — what matters, what’s likely forgotten, who needs help, and what’s next.',
  '/dashboard/calm': 'One prioritized inbox for everything demanding your attention, sorted so the loudest thing isn’t always first.',
  '/dashboard/connections': 'Connect the outside services your family already uses — calendars, email, smart home — into one hub.',
  '/dashboard/trust': 'Set who can do what: approval rules, permissions, and a full audit trail of every sensitive action.',
  '/dashboard/concierge': 'An AI planner for the big stuff — trips, events, projects — that researches options and builds the plan for you.',
  '/dashboard/trip-intel': 'Deep research for any trip: routes, timing, weather, and what to pack, assembled into one brief.',
  '/dashboard/front-desk': 'An AI receptionist that screens calls, takes messages, and handles the phone tasks you’d rather not.',
  '/dashboard/contact-center': 'Your family’s own @bubaly.com address and dedicated phone number — every call, text, and email lands in one AI-triaged inbox.',
  '/guardian': 'Screens unknown callers before they ever reach you and flags likely spam and scams.',
  '/dashboard/inbox': 'One place for every family message — school emails, texts, notices — with the action items pulled out automatically.',
  '/dashboard/calendar': 'One shared family calendar where every event has an owner, colour-coded by person, with conflict detection.',
  '/wallet': 'The family’s money hub — balances, allowances, cards, savings goals, and kid-safe spending in one place.',
  '/dashboard/chores': 'Assign, track, and reward chores — with optional payouts straight to a kid’s wallet when the job’s done.',
  '/missions': 'Turn family goals into playful missions with progress, points, and a little friendly competition.',
  '/dashboard/rewards': 'A rewards store where kids spend earned points on the perks and privileges you set.',
  '/dashboard/behavior': 'Track behaviour with positive reinforcement — points, streaks, and gentle nudges instead of nagging.',
  '/dashboard/screen-time': 'See and shape screen habits across the family — limits, schedules, and what everyone’s actually watching.',

  // ── Daily Life ─────────────────────────────────────────────────────────────
  '/dashboard/kitchen': 'A smart kitchen dashboard — what to cook tonight, what’s in the pantry, and what to use up before it turns.',
  '/dashboard/meals': 'Plan the week’s dinners with theme nights and a grocery list that builds itself from the plan.',
  '/dashboard/pantry': 'Track what’s in the pantry and fridge so nothing gets double-bought or forgotten at the back.',
  '/dashboard/messages': 'Private family chat — one place to talk, share, and keep everyone in the loop.',
  '/dashboard/announcements': 'Post family-wide notices everyone sees — the fridge whiteboard, but it follows you.',
  '/dashboard/activity': 'A live feed of what’s happening across the family — completed chores, new events, wins worth celebrating.',
  '/dashboard/celebrations': 'Never miss a birthday or anniversary — reminders, gift ideas, and a nudge to plan ahead.',
  '/dashboard/relationship': 'Little prompts to stay close — date-night ideas, check-ins, and remembering the things that matter.',
  '/dashboard/readiness': 'A quick read on how prepared the family is for what’s ahead — and the gaps worth closing now.',
  '/dashboard/memories': 'A private home for family photos and memories, organized and easy to look back on together.',
  '/dashboard/family-tree': 'Build your family tree and keep relatives, dates, and stories connected across generations.',
  '/dashboard/grandparent-portal': 'A gentle, simplified view so grandparents can see photos, milestones, and stay in the loop.',
  '/dashboard/pets': 'Everything for the four-legged family — vet dates, meds, feeding, and grooming, all tracked.',
  '/dashboard/closet': 'Every family member\'s closet in one place — today\'s outfit picked from what they own, laundry and outgrown tracking, and cost per wear.',
  '/dashboard/watchlist': 'The family watchlist with votes, age ratings and runtimes — so movie night is one pick for the people on the couch, not an hour of scrolling.',
  '/dashboard/locator': 'A private family map — see where everyone is, with check-ins and place alerts, on your terms.',
  '/dashboard/social': 'Coordinate the family’s social life — RSVPs, invites, and who’s doing what this weekend.',
  '/dashboard/social-feed': 'A private social feed just for your family — share updates without the whole internet watching.',
  '/dashboard/grocery': 'A shared grocery list that syncs live, sorts by aisle, and remembers your staples.',
  '/dashboard/reminders': 'Set reminders that nudge the right person at the right moment — so nobody has to be the nag.',
  '/dashboard/weather': 'The family forecast, tied to your plans — so an outdoor party gets a heads-up before the rain.',
  '/dashboard/recipes': 'Save, organize, and cook from your family’s recipes — add any to the week’s plan in a tap.',
  '/dashboard/photos': 'A shared photo library the whole family can add to and browse, safe and private.',
  '/dashboard/todos': 'Simple shared to-do lists for the household — assign, check off, and never lose a task.',
  '/dashboard/wishlists': 'Family wish lists for birthdays and holidays — so gifts land, and nobody double-buys.',
  '/dashboard/documents': 'A secure home for important family documents — searchable, organized, and easy to share.',
  '/dashboard/notes': 'Quick shared notes for the family — jot it down once and everyone can see it.',
  '/dashboard/habits': 'Build family habits that stick with streaks, shared goals, and low-key accountability.',
  '/dashboard/journal': 'A private family journal — capture the everyday moments worth keeping.',
  '/dashboard/focus': 'A calm, distraction-free mode for getting one thing done without the noise.',
  '/dashboard/contacts': 'The family address book with a relationship timeline — who to reconnect with and when.',

  // ── Family & Home ──────────────────────────────────────────────────────────
  '/dashboard/school': 'Keep school on track — dates, forms, teachers, and the two facts buried in every newsletter.',
  '/dashboard/timetable': 'Each kid’s class schedule at a glance, synced with the family calendar.',
  '/dashboard/homework': 'Track assignments and due dates so homework never becomes a bedtime surprise.',
  '/dashboard/signups': 'Manage the endless sign-ups — camps, sports, volunteer slots — before they quietly close.',
  '/dashboard/home': 'Stay on top of the house — maintenance, repairs, and seasonal tasks, all scheduled.',
  '/dashboard/utilities': 'Track utility accounts, usage, and bills so nothing lapses or spikes unnoticed.',
  '/dashboard/binder': 'The digital household binder — everything about your home in one organized place.',
  '/dashboard/security': 'Home security alerts and check-ins, gathered where the whole family can see them.',
  '/dashboard/devices': 'Manage the family’s smart-home devices and routines from one screen.',
  '/dashboard/auto': 'Track every vehicle — service, registration, insurance, and what’s due next.',
  '/dashboard/renewals': 'A radar for expiring things — passports, licenses, warranties — with reminders before they lapse.',
  '/dashboard/trips': 'Plan trips end to end — itinerary, bookings, packing, and who’s doing what.',
  '/dashboard/vacations': 'Design the family vacation together — ideas, votes, budget, and the day-by-day plan.',
  '/dashboard/weekend': 'Turn an empty weekend into a plan everyone’s happy with, in a few taps.',
  '/dashboard/voting': 'Settle family decisions fairly — propose options, everyone votes, the result is clear.',
  '/dashboard/life-events': 'Plan for the big milestones — a move, a new baby, a graduation — with a guided playbook.',
  '/dashboard/trip-memories': 'Collect the photos and stories from each trip into a keepsake you’ll revisit.',
  '/dashboard/sports': 'Keep every game, practice, and roster straight — with reminders and carpool built in.',
  '/dashboard/rides': 'Coordinate rides and carpools so every kid gets where they’re going, covered.',
  '/marketplace': 'Buy, sell, rent, borrow, and lend within a trusted family community — safer than the open web.',
  '/display': 'A always-on kitchen display showing today’s plan — the family command board on the counter.',
  '/dashboard/health': 'The family’s health hub — appointments, records, and who’s due for what.',
  '/dashboard/scan': 'Snap a flyer or form and the AI pulls out the dates, costs, and to-dos automatically.',
  '/dashboard/medical': 'Store medical history, providers, and visit notes securely for the whole family.',
  '/dashboard/medications': 'Track medications and refills with reminders so no dose or renewal slips.',
  '/dashboard/care': 'Log care for anyone who needs it — symptoms, visits, and notes shared among caregivers.',
  '/dashboard/dental': 'Keep dental appointments and history on track for everyone.',
  '/dashboard/family-access': 'Give kids their own safe logins — no email required — with the access you choose.',
  '/dashboard/settings': 'Manage your family, members, preferences, and how Bubaly works for you.',

  // ── Finances & Admin ───────────────────────────────────────────────────────
  '/dashboard/billing': 'The family finance hub — budgets, bills, spending, and savings, all in one view.',
  '/economy': 'Run a mini family economy — allowances, jobs, interest, and spend/save/share for the kids.',
  '/dashboard/expenses': 'Split and settle shared expenses fairly, with a clear record of who owes what.',
  '/dashboard/subscriptions': 'Find and tame recurring charges — the forgotten trials quietly draining the budget.',
  '/dashboard/insurance': 'Keep every policy, renewal, and claim organized in one insurance hub.',
  '/dashboard/tax-vault': 'A secure vault for tax documents, gathered and ready when filing season hits.',
  '/dashboard/sync': 'Two-way sync with Google, Outlook, and Apple calendars — one source of truth, everywhere.',
  '/dashboard/migrate': 'Bring your family’s data over from another app and switch to Bubaly with everything intact.',
  '/dashboard/settings#members': 'Add and manage family members, roles, and access — the who’s-who of your household.',
  '/referrals': 'Invite another family and earn rewards when they join.',

  // ── Family AI OS ───────────────────────────────────────────────────────────
  '/dashboard/family-operations': 'The operations console for the household — everything running, all at once, at a glance.',
  '/dashboard/conflicts': 'The AI spots schedule clashes before they happen and proposes fixes everyone can live with.',
  '/dashboard/autonomous-family-management': 'Hands-off management for the routine — the AI runs the recurring stuff so you don’t have to.',
  '/dashboard/voice': 'Run the household by voice — add events, lists, and reminders just by asking out loud.',
  '/dashboard/family-digital-twin': 'A living model of your family that simulates the week so the AI can plan ahead accurately.',
  '/dashboard/family-cfo': 'Your family’s AI finance chief — forecasts cash flow, flags heavy weeks, and finds savings.',
  '/dashboard/family-coo': 'The family’s operations chief — keeps the routines, logistics, and hand-offs running smoothly.',
  '/dashboard/family-health': 'A health coordinator that keeps appointments, meds, and follow-ups aligned for everyone.',
  '/dashboard/family-school': 'A school hub that pulls every kid’s dates, forms, and grades into one place.',
  '/dashboard/family-sports': 'A sports hub for all the teams — schedules, rosters, gear, and carpools in one view.',
  '/dashboard/knowledge': 'The family’s durable memory — shoe sizes, doctors, passwords, and answers in plain language.',
  '/dashboard/playbook': 'What Bubaly has learned about your family — favourite meals, routines, and traditions, editable.',
  '/dashboard/experience': 'A scorecard for how well the app is serving your family, with the rough edges called out.',
  '/dashboard/family-emergency': 'Everything for an emergency in one grab-and-go place — contacts, plans, and critical info.',
  '/dashboard/family-stress': 'Predicts the weeks that will run hot so you can lighten the load before it lands.',
  '/dashboard/family-automation': 'Automate the repetitive corners of family life — set it once and let it run.',
};

/**
 * Merge super-admin overrides over the code defaults. Only non-empty overrides
 * for KNOWN service keys win; anything else falls through to the default.
 */
export function mergeServiceDescriptions(overrides: Record<string, string> | null | undefined): Record<string, string> {
  const merged: Record<string, string> = { ...SERVICE_DESCRIPTIONS };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === 'string' && value.trim()) merged[key] = value.trim();
    }
  }
  return merged;
}

/** The description for one service route, honoring an optional override map. */
export function serviceDescription(href: string, overrides?: Record<string, string> | null): string {
  const override = overrides?.[href];
  if (typeof override === 'string' && override.trim()) return override.trim();
  return SERVICE_DESCRIPTIONS[href] ?? '';
}

/** Every service key that ships with a default description. */
export const SERVICE_DESCRIPTION_KEYS: string[] = Object.keys(SERVICE_DESCRIPTIONS);
