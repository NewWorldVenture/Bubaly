import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

type DB = SupabaseClient<Database>;

// Seed a fresh demo family with a rich, realistic dataset (~200 rows) so a
// visitor can immediately see — and CRUD — every populated Family+ surface.
// Every table insert is best-effort: a schema drift on one table skips it rather
// than aborting the whole demo. Column choices mirror supabase/seed_demo_account.sql
// (PG16-validated) so the two demo paths stay consistent.

const iso = (daysFromNow: number, hour = 9) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
const dateKey = (daysFromNow: number) => iso(daysFromNow).slice(0, 10);
const pick = <T>(arr: readonly T[], i: number): T => arr[i % arr.length];
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

export async function seedDemoFamily(admin: DB, familyId: string, ownerId: string): Promise<void> {
  const fam = { family_id: familyId };
  type Inserter = { insert: (rows: unknown) => PromiseLike<unknown> };
  const ins = async (table: string, rows: unknown[]) => {
    try { await (admin.from(table as never) as unknown as Inserter).insert(rows); } catch { /* best-effort */ }
  };

  // People — a partner + two kids (local, no-login members).
  await ins('family_members', [
    { ...fam, role: 'adult', display_name: 'Sam', color: '#6aa9ff', is_active: true },
    { ...fam, role: 'teen', display_name: 'Emma', color: '#f4996e', is_active: true },
    { ...fam, role: 'child', display_name: 'Leo', color: '#4ac99b', is_active: true },
  ]);

  // Member ids for assignee / member_id references (owner "You" + the three above).
  let memberIds: string[] = [];
  try {
    const { data } = await admin.from('family_members').select('id').eq('family_id', familyId).eq('is_active', true);
    memberIds = (data ?? []).map((m: { id: string }) => m.id);
  } catch { /* best-effort */ }
  const member = (i: number): string | null => (memberIds.length ? pick(memberIds, i) : null);

  // ── Calendar (24) — this fortnight, morning-to-evening ────────────────────
  const evTitles = ['Soccer practice', 'Dentist — Emma', 'Piano lesson', 'Book club', 'Team meeting', 'Swim class', 'Birthday party', 'Parent–teacher night', 'Dance recital', 'Doctor visit', 'Study group', 'Family movie night'] as const;
  const evCats = ['sports', 'appointment', 'school', 'general', 'birthday', 'personal', 'maintenance', 'other'] as const;
  await ins('calendar_events', range(24).map((g) => ({
    ...fam,
    title: pick(evTitles, g),
    description: 'A believable family event.',
    location: `Place ${g % 8}`,
    category: pick(evCats, g),
    starts_at: iso(g % 14, 8 + (g % 9)),
    ends_at: iso(g % 14, 9 + (g % 9)),
    all_day: false,
    recurrence: 'none',
    assignee_id: member(g),
    created_by: ownerId,
  })));

  // ── Tasks + reminders ─────────────────────────────────────────────────────
  const taskTitles = ['Sign the permission slip', 'Renew library books', 'Book summer camp', 'Schedule car service', 'Order birthday gift', 'Plan weekend trip', 'Update emergency contacts', 'Fix the leaky faucet', 'Send thank-you cards', 'Review the budget', 'Clean out the garage', 'Refill prescriptions'] as const;
  await ins('todo_items', taskTitles.map((title, g) => ({
    ...fam, title, is_done: g % 4 === 0, due_date: dateKey((g % 10) + 1), created_by: ownerId,
  })));
  const remTitles = ['Pick up Leo at 3pm', 'Pay the water bill', 'Water plants', 'Call grandma', 'Renew library books', 'School forms due', 'Take out the trash'] as const;
  await ins('family_reminders', range(14).map((g) => ({
    ...fam, title: pick(remTitles, g), kind: g % 3 === 0 ? 'bill' : 'time', status: 'active',
    remind_at: iso(g % 5, 8 + (g % 10)), created_by: ownerId,
  })));

  // ── Meals for the week (plan them onto dinner) ────────────────────────────
  const mealNames = ['Taco Tuesday', 'Sheet-pan salmon', 'Veggie stir-fry', 'Spaghetti bolognese', 'Chicken curry', 'Homemade pizza'] as const;
  try {
    const { data: meals } = await admin.from('meals').insert(
      mealNames.map((name) => ({ ...fam, name, meal_type: 'dinner', created_by: ownerId })),
    ).select('id');
    if (meals?.length) {
      await ins('meal_plans', meals.map((m: { id: string }, i: number) => ({
        ...fam, meal_id: m.id, plan_date: dateKey(i), meal_type: 'dinner', created_by: ownerId,
      })));
    }
  } catch { /* best-effort */ }
  await ins('meal_votes', range(6).map((g) => ({ ...fam, title: `Dinner vote ${g + 1}`, status: 'open', created_by: ownerId })));

  // ── Groceries + chores + pantry ───────────────────────────────────────────
  const groceries = ['Milk', 'Bananas', 'Bread', 'Eggs', 'Chicken', 'Rice', 'Apples', 'Coffee', 'Yogurt', 'Spinach', 'Cheese', 'Tomatoes', 'Cereal', 'Butter', 'Pasta'] as const;
  await ins('grocery_items', groceries.map((name, g) => ({ ...fam, name, is_checked: g % 5 === 0, created_by: ownerId })));
  const choreTitles = ['Take out the trash', 'Feed the dog', 'Load the dishwasher', 'Fold laundry', 'Vacuum the living room', 'Water the garden', 'Make the beds', 'Wipe the counters'] as const;
  await ins('chores', choreTitles.map((title, g) => ({ ...fam, title, points: 3 + (g % 5), created_by: ownerId })));
  const pantryNames = ['Milk', 'Eggs', 'Flour', 'Rice', 'Pasta', 'Cereal', 'Coffee', 'Sugar', 'Butter', 'Bread', 'Apples', 'Chicken'] as const;
  const pantryLoc = ['pantry', 'fridge', 'freezer', 'counter'] as const;
  await ins('pantry_items', range(20).map((g) => ({
    ...fam, name: pick(pantryNames, g), location: pick(pantryLoc, g), quantity: g % 3 === 0 ? 1 : 6, low_threshold: 3, created_by: ownerId,
  })));

  // ── Finances: transactions, budgets, accounts, bills ──────────────────────
  const txNames = ['Groceries', 'Coffee', 'Gas', 'Dining', 'Shopping', 'Pharmacy', 'Toys', 'Books'] as const;
  const txCats = ['Groceries', 'Dining', 'Transportation', 'Shopping', 'Kids', 'Utilities', 'Entertainment', 'Health'] as const;
  await ins('transactions', range(24).map((g) => ({
    ...fam, name: pick(txNames, g), amount: 8 + (g % 60), category: pick(txCats, g),
    date: dateKey(-(g % 28)), type: 'expense', notes: 'Demo transaction', created_by: ownerId,
  })));
  await ins('budgets', [
    ['Groceries', 600], ['Dining', 200], ['Transportation', 150], ['Kids', 250], ['Entertainment', 120], ['Utilities', 300],
  ].map(([category, amount]) => ({ ...fam, category, amount, period: 'monthly', created_by: ownerId })));
  await ins('financial_accounts', [
    ['Everyday Checking', 'checking', 3240.55], ['Family Savings', 'savings', 12800.0], ['Rewards Card', 'credit', -640.2], ['Kids College', 'investment', 8600.0], ['Vacation Fund', 'savings', 2150.0],
  ].map(([name, type, balance]) => ({ ...fam, name, type, balance, currency: 'USD', created_by: ownerId })));
  const billNames = ['Electricity', 'Water', 'Internet', 'Phone', 'Streaming', 'Insurance', 'Mortgage', 'Gym', 'Trash', 'Daycare', 'Music', 'Car'] as const;
  await ins('bills', range(12).map((g) => ({
    ...fam, name: pick(billNames, g), amount: 30 + ((g * 13) % 220), due_date: dateKey(g % 20),
    is_recurring: true, recurrence: 'monthly', status: g % 6 === 0 ? 'overdue' : 'upcoming', category: 'Utilities', autopay: g % 3 === 0, created_by: ownerId,
  })));

  // ── Goals, documents, maintenance ─────────────────────────────────────────
  const goalTitles = ['Family trip to Japan', 'New bikes', 'Emergency fund', 'Kitchen remodel', 'Read 20 books', 'Learn guitar', 'Garden makeover', 'Save for laptop', 'Run a 5K', 'Declutter garage'] as const;
  await ins('goals', goalTitles.map((title, g) => ({
    ...fam, title, progress: (g * 9) % 100, is_complete: g % 7 === 0, target_date: dateKey(g * 10 + 5), created_by: ownerId,
  })));
  const docTitles = ['Passport', 'Insurance policy', 'Warranty', 'Lease', 'Vaccination record', 'Car registration', 'Will', 'School report', 'Tax return', 'Membership'] as const;
  await ins('documents', docTitles.map((title, g) => ({
    ...fam, title, category: 'general', storage_path: `${familyId}/demo/doc-${g}.pdf`, expires_at: dateKey((g % 40) + 5), created_by: ownerId,
  })));
  const maintTitles = ['Change HVAC filter', 'Test smoke alarms', 'Clean gutters', 'Service the car', 'Descale kettle', 'Check tire pressure', 'Flush water heater', 'Mow the lawn'] as const;
  await ins('maintenance_tasks', maintTitles.map((title, g) => ({
    ...fam, title, status: 'todo', priority: 'medium', recurrence: 'none', due_at: iso((g % 20) - 5, 10), created_by: ownerId,
  })));

  // ── Family knowledge + polls ──────────────────────────────────────────────
  const factCats = ['preference', 'sizes', 'medical', 'contact', 'important', 'about'] as const;
  const factLabels = ['Shoe size', 'Allergy', 'Pediatrician', 'Wifi password', 'Favorite meal', 'Shirt size', 'Blood type', 'Emergency contact', 'Coffee order', 'Bedtime', 'Dentist', 'Car plate'] as const;
  const factVals = ['US 8', 'Peanuts', 'Dr. Lee 555-0100', 'on the fridge', 'Taco night', 'Medium', 'O+', 'Aunt May', 'oat latte', '8:30pm', 'Dr. Kim', 'ABC-1234'] as const;
  await ins('family_facts', range(12).map((g) => ({
    ...fam, category: pick(factCats, g), label: pick(factLabels, g), value: pick(factVals, g), is_pinned: g % 5 === 0, created_by: ownerId,
  })));
  const pollQs = ['Movie night pick?', 'Weekend plan?', 'Where to eat?', 'Vacation spot?', 'Chore swap?', 'Game to play?'] as const;
  await ins('family_polls', pollQs.map((question) => ({ ...fam, question, kind: 'single', status: 'open', created_by: ownerId })));

  // ── Marketplace: listings (12) + saves + reviews ──────────────────────────
  const listTitles = ['Balance bike', 'Board games bundle', 'Winter coat', 'Bookshelf', 'Lego set', 'Guitar', 'Stroller', 'Desk lamp', 'Tennis racket', 'Puzzle', 'Baby monitor', 'Cookbook'] as const;
  const listKinds = ['sell', 'sell', 'rent', 'free', 'wanted', 'borrow'] as const;
  const listCats = ['toys', 'books', 'clothing', 'furniture', 'sports', 'baby', 'games', 'other'] as const;
  const listCond = ['good', 'like_new', 'new', 'fair'] as const;
  try {
    const { data: listings } = await admin.from('marketplace_listings').insert(
      range(12).map((g) => ({
        ...fam, member_id: member(g), title: pick(listTitles, g), description: 'A well-loved family item, ready for a new home.',
        kind: pick(listKinds, g), category: pick(listCats, g), condition: pick(listCond, g), price_cents: (g % 5) * 1000, status: 'available', location: 'Garage', created_by: ownerId,
      })),
    ).select('id');
    const ids = (listings ?? []).map((l: { id: string }) => l.id);
    if (ids.length) {
      await ins('marketplace_saves', ids.slice(0, 8).map((id: string, i: number) => ({ ...fam, listing_id: id, member_id: member(i + 1) })));
      await ins('marketplace_reviews', ids.slice(0, 8).map((id: string, i: number) => ({
        ...fam, listing_id: id, reviewer_member: member(i), reviewee_member: member(i + 1), role: 'buyer', rating: 4 + (i % 2), comment: 'Smooth hand-off — thank you!',
      })));
    }
  } catch { /* best-effort */ }

  // ── Assistant activity so the proactive front door + "time saved" light up ─
  await ins('autopilot_suggestions', [
    { ...fam, kind: 'groceries', title: 'Reordered milk', status: 'auto_executed', confidence: 92, urgency: 1, dedupe_key: 'demo:milk', action_type: 'none' },
    { ...fam, kind: 'reminder', title: 'Set a leave-by reminder for soccer', status: 'auto_executed', confidence: 88, urgency: 2, dedupe_key: 'demo:soccer', action_type: 'none' },
    { ...fam, kind: 'document', title: 'Filed the field-trip form', status: 'auto_executed', confidence: 90, urgency: 1, dedupe_key: 'demo:form', action_type: 'none' },
  ]);
  await ins('approval_requests', [
    { ...fam, domain: 'finance', title: 'Approve the field-trip payment', status: 'pending', priority: 'high', agent: 'Budget Coach', requested_by_kind: 'ai' },
    { ...fam, domain: 'calendar', title: 'Confirm the weekend babysitter', status: 'pending', priority: 'normal', agent: 'Scheduler', requested_by_kind: 'ai' },
  ]);
  await ins('agent_activity', [
    { ...fam, agent: 'scheduler', kind: 'action', title: 'Resolved a calendar conflict', status: 'done', severity: 'info' },
    { ...fam, agent: 'meal_planner', kind: 'action', title: 'Built this week’s dinner plan', status: 'done', severity: 'info' },
  ]);
}
