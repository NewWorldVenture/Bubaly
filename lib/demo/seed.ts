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
  // NOTE: must be valid public.event_category enum values — 'personal' is NOT
  // one, and a single bad value fails the whole 24-row insert (best-effort catch
  // hid it: the demo calendar seeded ZERO events).
  const evCats = ['sports', 'appointment', 'school', 'general', 'birthday', 'holiday', 'maintenance', 'other'] as const;
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
  // todo_items require a parent todo_list, and both todo_lists/todo_items
  // reference family_members.id for created_by (not auth.users) — so seed a list
  // first and stamp the owning member, else the whole Tasks surface stays empty.
  const ownerMember = member(0);
  const taskTitles = ['Sign the permission slip', 'Renew library books', 'Book summer camp', 'Schedule car service', 'Order birthday gift', 'Plan weekend trip', 'Update emergency contacts', 'Fix the leaky faucet', 'Send thank-you cards', 'Review the budget', 'Clean out the garage', 'Refill prescriptions'] as const;
  try {
    const { data: lists } = await admin.from('todo_lists').insert(
      [{ ...fam, name: 'Family To-Dos', created_by: ownerMember }],
    ).select('id');
    const listId = lists?.[0]?.id as string | undefined;
    if (listId) {
      await ins('todo_items', taskTitles.map((title, g) => ({
        ...fam, list_id: listId, title, is_done: g % 4 === 0, due_date: dateKey((g % 10) + 1), created_by: ownerMember,
      })));
    }
  } catch { /* best-effort */ }
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
  // grocery_items also require a parent grocery_list, else Groceries renders empty.
  try {
    const { data: glists } = await admin.from('grocery_lists').insert(
      [{ ...fam, name: 'Weekly Groceries', created_by: ownerId }],
    ).select('id');
    const glistId = glists?.[0]?.id as string | undefined;
    if (glistId) {
      await ins('grocery_items', groceries.map((name, g) => ({ ...fam, list_id: glistId, name, is_checked: g % 5 === 0, created_by: ownerId })));
    }
  } catch { /* best-effort */ }
  const choreTitles = ['Take out the trash', 'Feed the dog', 'Load the dishwasher', 'Fold laundry', 'Vacuum the living room', 'Water the garden', 'Make the beds', 'Wipe the counters'] as const;
  // Capture chore ids so we can assign them to kids (the chores board reads
  // chore_assignments for who's-doing-what + status; without them it looks unused).
  try {
    const { data: choreRows } = await admin.from('chores').insert(
      choreTitles.map((title, g) => ({ ...fam, title, points: 3 + (g % 5), created_by: ownerId })),
    ).select('id');
    const choreIds = (choreRows ?? []).map((c: { id: string }) => c.id);
    if (choreIds.length) {
      const choreStatuses = ['todo', 'in_progress', 'submitted', 'done', 'approved'] as const;
      await ins('chore_assignments', choreIds.map((chore_id: string, g: number) => ({
        ...fam, chore_id, member_id: member(g % 3 + 1), status: pick(choreStatuses, g), due_at: iso((g % 7) - 2, 17),
      })));
    }
  } catch { /* best-effort */ }
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
  // Savings goals power the Finances → Savings tab (separate from Goals above).
  await ins('savings_goals', ([
    ['Vacation Fund', '🏖️', 4500, 1800], ['Emergency Fund', '🛟', 10000, 6200], ['New Bike', '🚲', 300, 120],
    ['Kids College', '🎓', 20000, 8600], ['Holiday Gifts', '🎁', 1200, 450],
  ] as const).map(([name, emoji, target_amount, current_amount], g) => ({
    ...fam, name, emoji, target_amount, current_amount, target_date: dateKey((g + 1) * 60), created_by: ownerId,
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

  // ── Health: medications, appointments, visits, immunizations ──────────────
  const medNames = ['Vitamin D', 'Amoxicillin', 'Allergy tablet', 'Inhaler', 'Melatonin', 'Ibuprofen'] as const;
  await ins('medications', range(6).map((g) => ({
    ...fam, member_id: member(g), name: pick(medNames, g), dosage: pick(['1 tablet', '5 mL', '10 mg', '1 puff', '1 gummy', '200 mg'] as const, g),
    instructions: 'Take as directed.', is_active: true, created_by: ownerId,
  })));
  const apptTitles = ['Dentist — Emma', 'Pediatrician — Leo', 'Eye exam', 'Annual physical', 'Orthodontist', 'Flu shot', 'Dermatologist', 'Vet — Biscuit'] as const;
  await ins('appointments', range(8).map((g) => ({
    ...fam, member_id: member(g), title: pick(apptTitles, g), provider: pick(['Dr. Kim', 'Dr. Lee', 'Dr. Patel', 'City Clinic'] as const, g),
    location: pick(['Downtown', 'Main St Clinic', 'Kids Health', 'Uptown'] as const, g), starts_at: iso((g % 20) + 1, 9 + (g % 7)), notes: 'Bring insurance card.', created_by: ownerId,
  })));
  const visitKinds = ['medical', 'dental', 'vision', 'specialist', 'therapy', 'urgent_care'] as const;
  await ins('health_visits', range(6).map((g) => ({
    ...fam, member_id: member(g), kind: pick(visitKinds, g), title: pick(['Annual physical', 'Cleaning', 'Eye check', 'Specialist', 'Therapy', 'Urgent care'] as const, g),
    provider_name: pick(['Dr. Lee', 'Bright Smiles', 'Vision Plus', 'Dr. Patel'] as const, g), visit_date: dateKey(-((g % 6) * 20 + 5)), created_by: ownerId,
  })));
  const vaccines = ['Flu', 'Tdap', 'MMR', 'HPV', 'COVID-19', 'Hepatitis B'] as const;
  await ins('immunizations', range(6).map((g) => ({
    ...fam, member_id: member(g), vaccine: pick(vaccines, g), dose_label: pick(['1st', '2nd', 'Booster', 'Annual'] as const, g),
    date_given: dateKey(-((g % 6) * 60 + 30)), provider_name: 'City Clinic', created_by: ownerId,
  })));

  // ── Kids: homework, classes, teams, wishlist, screen time, journal ────────
  const subjects = ['Math', 'Science', 'English', 'History', 'Spanish', 'Art'] as const;
  await ins('homework_assignments', range(10).map((g) => ({
    ...fam, member_id: member(g), subject: pick(subjects, g), title: `${pick(subjects, g)} — ${pick(['worksheet', 'reading', 'project', 'quiz prep', 'essay'] as const, g)}`,
    due_at: iso((g % 8) + 1, 15), status: g % 4 === 0 ? 'done' : 'assigned', created_by: ownerId,
  })));
  await ins('school_classes', range(6).map((g) => ({
    ...fam, member_id: member(g % 3 + 1), subject: pick(subjects, g), teacher: pick(['Ms. Rivera', 'Mr. Chen', 'Mrs. Gold', 'Mr. Diaz'] as const, g),
    room: `Room ${10 + g}`, day_of_week: (g % 5) + 1, created_by: ownerId,
  })));
  await ins('teams', range(4).map((g) => ({
    ...fam, member_id: member(g % 3 + 1), sport: pick(['Soccer', 'Basketball', 'Swimming', 'Baseball'] as const, g),
    team_name: pick(['Blue Jays', 'Sharks', 'Comets', 'Rockets'] as const, g), season: 'Fall', coach: pick(['Coach Dan', 'Coach Amy'] as const, g), is_active: true, created_by: ownerId,
  })));
  const wishTitles = ['New bike', 'Lego set', 'Soccer cleats', 'Headphones', 'Art kit', 'Board game', 'Skateboard', 'Book series'] as const;
  await ins('wishlist_items', range(8).map((g) => ({
    ...fam, member_id: member(g % 3 + 1), title: pick(wishTitles, g), price: 15 + (g % 8) * 20, priority: pick(['low', 'medium', 'high'] as const, g), created_by: ownerId,
  })));
  await ins('screen_time_entries', range(14).map((g) => ({
    ...fam, member_id: member(g % 3 + 1), entry_date: dateKey(-(g % 14)), minutes: 30 + (g % 6) * 20,
    category: pick(['gaming', 'video', 'social', 'education'] as const, g), device: pick(['tablet', 'phone', 'tv', 'laptop'] as const, g), logged_by: ownerId,
  })));
  const journalMoods = ['great', 'good', 'okay', 'tired', 'excited'] as const;
  await ins('journal_entries', range(8).map((g) => ({
    ...fam, member_id: member(g), entry_date: dateKey(-(g % 8)), mood: pick(journalMoods, g),
    title: pick(['A good day', 'Busy but fun', 'Quiet evening', 'Weekend adventure'] as const, g), body: 'A little snapshot of family life today.', created_by: ownerId,
  })));

  // ── Home: pets, vehicles, warranties ──────────────────────────────────────
  await ins('pets', [
    { ...fam, name: 'Biscuit', species: 'dog', breed: 'Beagle', birthday: dateKey(-1200), is_active: true, vet_name: 'Happy Paws Vet', created_by: ownerId },
    { ...fam, name: 'Mittens', species: 'cat', breed: 'Tabby', birthday: dateKey(-900), is_active: true, vet_name: 'Happy Paws Vet', created_by: ownerId },
  ]);
  await ins('vehicles', [
    { ...fam, nickname: 'The Van', make: 'Honda', model: 'Odyssey', year: 2019, mileage: 54200, status: 'active', created_by: ownerId },
    { ...fam, nickname: 'Commuter', make: 'Toyota', model: 'Corolla', year: 2021, mileage: 28900, status: 'active', created_by: ownerId },
  ]);
  const warTitles = ['Refrigerator', 'Washer/Dryer', 'HVAC system', 'Dishwasher', 'Water heater', 'Roof'] as const;
  await ins('home_warranties', range(6).map((g) => ({
    ...fam, name: `${pick(warTitles, g)} warranty`, provider: pick(['Whirlpool', 'Samsung', 'Carrier', 'HomeShield'] as const, g),
    warranty_type: 'appliance', expires_on: dateKey((g % 6) * 90 + 60), status: 'active', created_by: ownerId,
  })));

  // ── Trips + vacations + relationship + notes + reminders lists ────────────
  await ins('vacations', [
    { ...fam, title: 'Summer in Maui', kind: 'flight', status: 'planning', destination: 'Maui, HI', start_date: dateKey(40), end_date: dateKey(47), budget_cents: 450000, currency: 'USD', created_by: ownerId },
    { ...fam, title: 'Grandparents visit', kind: 'road_trip', status: 'booked', destination: 'Denver, CO', start_date: dateKey(80), end_date: dateKey(85), budget_cents: 120000, currency: 'USD', created_by: ownerId },
  ]);
  await ins('trips', [
    { ...fam, name: 'Ski weekend', destination: 'Lake Tahoe', start_date: dateKey(20), end_date: dateKey(22), status: 'planning', created_by: ownerId },
    { ...fam, name: 'Beach day', destination: 'Santa Cruz', start_date: dateKey(9), end_date: dateKey(9), status: 'planning', created_by: ownerId },
  ]);
  await ins('relationship_dates', [
    { ...fam, created_by: ownerId, kind: 'anniversary', title: 'Our Anniversary', event_date: dateKey(60), recurs_annually: true },
    { ...fam, created_by: ownerId, kind: 'date_night', title: 'Date night', event_date: dateKey(6), recurs_annually: false },
  ]);
  const noteTitles = ['Wifi password', 'Babysitter numbers', 'Weekend plan', 'Gift ideas', 'House rules', 'Vacation packing list'] as const;
  await ins('notes', range(6).map((g) => ({
    ...fam, title: pick(noteTitles, g), body: 'A handy family note everyone can see.', is_pinned: g % 4 === 0, created_by: ownerId,
  })));
  await ins('reminder_lists', [
    { ...fam, created_by: ownerId, name: 'Household' },
    { ...fam, created_by: ownerId, name: 'Kids' },
  ]);

  // ── Routines (Morning / Bedtime) with their steps ─────────────────────────
  try {
    const { data: routines } = await admin.from('routine_templates').insert([
      { ...fam, name: 'Morning Routine', icon: '☀️', color: '#f4996e', weekday_mask: 62, is_active: true, source: 'demo', created_by: ownerId },
      { ...fam, name: 'Bedtime Routine', icon: '🌙', color: '#6aa9ff', weekday_mask: 127, is_active: true, source: 'demo', created_by: ownerId },
    ]).select('id, name');
    for (const r of (routines ?? []) as { id: string; name: string }[]) {
      const steps = r.name.startsWith('Morning')
        ? [['Wake up + make bed', 420, 10], ['Breakfast', 435, 20], ['Brush teeth', 460, 5], ['Pack backpack', 470, 10]] as const
        : [['Tidy up toys', 1140, 10], ['Bath time', 1155, 20], ['Story time', 1180, 15], ['Lights out', 1200, 5]] as const;
      await ins('routine_template_items', steps.map(([title, start_minutes, duration_minutes], i) => ({
        ...fam, template_id: r.id, title, category: 'general', start_minutes, duration_minutes, assignee_id: member(i + 1), sort_order: i,
      })));
    }
  } catch { /* best-effort */ }

  // ── Family memories + milestones (grandparent portal / planning surfaces) ──
  const memTitles = ['First day of school', 'Beach vacation', 'Leo lost a tooth', 'Family reunion', 'Dance recital', 'Snow day'] as const;
  await ins('family_memories', range(6).map((g) => ({
    ...fam, member_id: member(g), title: pick(memTitles, g), body: 'A little moment worth keeping.', kind: 'photo',
    memory_date: dateKey(-((g % 6) * 45 + 10)), tags: ['family'], is_favorite: g % 3 === 0, status: 'active', created_by: ownerId,
  })));
  await ins('family_milestones', ([
    ['Leo first steps', 'baby'], ['Emma 10th birthday', 'birthday'], ['Moved into the new house', 'home'], ['Adopted Biscuit', 'pet'],
  ] as const).map(([title, category], g) => ({
    ...fam, member_id: member(g), title, description: 'A family milestone.', milestone_date: dateKey(-((g + 1) * 120)), category, status: 'active', created_by: ownerId,
  })));

  // ── Family economy: a currency + a small reward catalog ───────────────────
  try {
    const { data: currencies } = await admin.from('family_currencies').insert(
      [{ ...fam, name: 'Stars', emoji: '⭐', unit_label: 'star', is_active: true, created_by: ownerId }],
    ).select('id');
    const currencyId = currencies?.[0]?.id as string | undefined;
    if (currencyId) {
      const rewardTitles = ['Movie night pick', '30 min extra screen time', 'Choose dinner', 'Stay up 30 min late', 'Ice cream trip', 'Skip one chore'] as const;
      await ins('economy_rewards', rewardTitles.map((title, g) => ({
        ...fam, currency_id: currencyId, title, emoji: pick(['🎬', '📺', '🍽️', '🌙', '🍦', '🧹'] as const, g), cost: (g + 1) * 10, is_active: true, created_by: ownerId,
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
