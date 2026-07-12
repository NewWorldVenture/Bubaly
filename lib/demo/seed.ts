import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

type DB = SupabaseClient<Database>;

// Seed a fresh demo family with a HIGH-VOLUME, realistic dataset so a visitor can
// fully test every Family+ surface at scale (pagination, search, filters, charts).
// Every list/record/log surface gets ≥ VOL rows; naturally-singular surfaces
// (accounts, budgets, pets, vehicles, the currency) keep realistic counts.
//
// Robustness:
//  • Every insert is best-effort — a schema drift on one table skips it rather
//    than aborting the whole demo (column choices are PG16-validated).
//  • Only `autopilot_suggestions` has a UNIQUE constraint (family_id, dedupe_key),
//    so its dedupe_key is made distinct per row; every other seeded table has no
//    unique key, so repeated title/label values across VOL rows are safe.
//  • The independent inserts run concurrently (Promise.all) so 20× the volume
//    doesn't slow the demo-login reseed to a crawl.

const VOL = 200;                        // rows per list/record surface ("≥ 200 for everything")

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

  // People — a partner + two kids (local, no-login members). Must be first so the
  // rest can reference member ids.
  await ins('family_members', [
    { ...fam, role: 'adult', display_name: 'Sam', color: '#6aa9ff', is_active: true },
    { ...fam, role: 'teen', display_name: 'Emma', color: '#f4996e', is_active: true },
    { ...fam, role: 'child', display_name: 'Leo', color: '#4ac99b', is_active: true },
  ]);
  let memberIds: string[] = [];
  try {
    const { data } = await admin.from('family_members').select('id').eq('family_id', familyId).eq('is_active', true);
    memberIds = (data ?? []).map((m: { id: string }) => m.id);
  } catch { /* best-effort */ }
  const member = (i: number): string | null => (memberIds.length ? pick(memberIds, i) : null);
  const ownerMember = member(0);

  // Title/label pools (cycled across VOL rows via pick()).
  const evTitles = ['Soccer practice', 'Dentist — Emma', 'Piano lesson', 'Book club', 'Team meeting', 'Swim class', 'Birthday party', 'Parent–teacher night', 'Dance recital', 'Doctor visit', 'Study group', 'Family movie night'] as const;
  const evCats = ['sports', 'appointment', 'school', 'general', 'birthday', 'holiday', 'maintenance', 'other'] as const;
  const taskTitles = ['Sign the permission slip', 'Renew library books', 'Book summer camp', 'Schedule car service', 'Order birthday gift', 'Plan weekend trip', 'Update emergency contacts', 'Fix the leaky faucet', 'Send thank-you cards', 'Review the budget', 'Clean out the garage', 'Refill prescriptions'] as const;
  const remTitles = ['Pick up Leo at 3pm', 'Pay the water bill', 'Water plants', 'Call grandma', 'Renew library books', 'School forms due', 'Take out the trash'] as const;
  const mealNames = ['Taco Tuesday', 'Sheet-pan salmon', 'Veggie stir-fry', 'Spaghetti bolognese', 'Chicken curry', 'Homemade pizza', 'Roast chicken', 'Beef tacos', 'Pad thai', 'Lentil soup', 'BBQ ribs', 'Caesar salad'] as const;
  const groceries = ['Milk', 'Bananas', 'Bread', 'Eggs', 'Chicken', 'Rice', 'Apples', 'Coffee', 'Yogurt', 'Spinach', 'Cheese', 'Tomatoes', 'Cereal', 'Butter', 'Pasta'] as const;
  const choreTitles = ['Take out the trash', 'Feed the dog', 'Load the dishwasher', 'Fold laundry', 'Vacuum the living room', 'Water the garden', 'Make the beds', 'Wipe the counters'] as const;
  const pantryNames = ['Milk', 'Eggs', 'Flour', 'Rice', 'Pasta', 'Cereal', 'Coffee', 'Sugar', 'Butter', 'Bread', 'Apples', 'Chicken'] as const;
  const pantryLoc = ['pantry', 'fridge', 'freezer', 'counter'] as const;
  const txNames = ['Groceries', 'Coffee', 'Gas', 'Dining', 'Shopping', 'Pharmacy', 'Toys', 'Books'] as const;
  const txCats = ['Groceries', 'Dining', 'Transportation', 'Shopping', 'Kids', 'Utilities', 'Entertainment', 'Health'] as const;
  const billNames = ['Electricity', 'Water', 'Internet', 'Phone', 'Streaming', 'Insurance', 'Mortgage', 'Gym', 'Trash', 'Daycare', 'Music', 'Car'] as const;
  const goalTitles = ['Family trip to Japan', 'New bikes', 'Emergency fund', 'Kitchen remodel', 'Read 20 books', 'Learn guitar', 'Garden makeover', 'Save for laptop', 'Run a 5K', 'Declutter garage'] as const;
  const docTitles = ['Passport', 'Insurance policy', 'Warranty', 'Lease', 'Vaccination record', 'Car registration', 'Will', 'School report', 'Tax return', 'Membership'] as const;
  const maintTitles = ['Change HVAC filter', 'Test smoke alarms', 'Clean gutters', 'Service the car', 'Descale kettle', 'Check tire pressure', 'Flush water heater', 'Mow the lawn'] as const;
  const factCats = ['preference', 'sizes', 'medical', 'contact', 'important', 'about'] as const;
  const factLabels = ['Shoe size', 'Allergy', 'Pediatrician', 'Wifi password', 'Favorite meal', 'Shirt size', 'Blood type', 'Emergency contact', 'Coffee order', 'Bedtime', 'Dentist', 'Car plate'] as const;
  const factVals = ['US 8', 'Peanuts', 'Dr. Lee 555-0100', 'on the fridge', 'Taco night', 'Medium', 'O+', 'Aunt May', 'oat latte', '8:30pm', 'Dr. Kim', 'ABC-1234'] as const;
  const pollQs = ['Movie night pick?', 'Weekend plan?', 'Where to eat?', 'Vacation spot?', 'Chore swap?', 'Game to play?'] as const;
  const listTitles = ['Balance bike', 'Board games bundle', 'Winter coat', 'Bookshelf', 'Lego set', 'Guitar', 'Stroller', 'Desk lamp', 'Tennis racket', 'Puzzle', 'Baby monitor', 'Cookbook'] as const;
  const listKinds = ['sell', 'sell', 'rent', 'free', 'wanted', 'borrow'] as const;
  const listCats = ['toys', 'books', 'clothing', 'furniture', 'sports', 'baby', 'games', 'other'] as const;
  const listCond = ['good', 'like_new', 'new', 'fair'] as const;
  const medNames = ['Vitamin D', 'Amoxicillin', 'Allergy tablet', 'Inhaler', 'Melatonin', 'Ibuprofen'] as const;
  const apptTitles = ['Dentist — Emma', 'Pediatrician — Leo', 'Eye exam', 'Annual physical', 'Orthodontist', 'Flu shot', 'Dermatologist', 'Vet — Biscuit'] as const;
  const visitKinds = ['medical', 'dental', 'vision', 'specialist', 'therapy', 'urgent_care'] as const;
  const vaccines = ['Flu', 'Tdap', 'MMR', 'HPV', 'COVID-19', 'Hepatitis B'] as const;
  const subjects = ['Math', 'Science', 'English', 'History', 'Spanish', 'Art'] as const;
  const wishTitles = ['New bike', 'Lego set', 'Soccer cleats', 'Headphones', 'Art kit', 'Board game', 'Skateboard', 'Book series'] as const;
  const journalMoods = ['great', 'good', 'okay', 'low', 'stressed'] as const;
  const warTitles = ['Refrigerator', 'Washer/Dryer', 'HVAC system', 'Dishwasher', 'Water heater', 'Roof'] as const;
  const noteTitles = ['Wifi password', 'Babysitter numbers', 'Weekend plan', 'Gift ideas', 'House rules', 'Vacation packing list'] as const;
  const memTitles = ['First day of school', 'Beach vacation', 'Leo lost a tooth', 'Family reunion', 'Dance recital', 'Snow day'] as const;
  const rewardTitles = ['Movie night pick', '30 min extra screen time', 'Choose dinner', 'Stay up 30 min late', 'Ice cream trip', 'Skip one chore'] as const;

  // A todo_list → items (todo_lists/items reference family_members.id for created_by).
  const seedTodos = async () => {
    try {
      const { data: lists } = await admin.from('todo_lists').insert([{ ...fam, name: 'Family To-Dos', created_by: ownerMember }]).select('id');
      const listId = lists?.[0]?.id as string | undefined;
      if (listId) await ins('todo_items', range(VOL).map((g) => ({
        ...fam, list_id: listId, title: pick(taskTitles, g), is_done: g % 4 === 0, due_date: dateKey((g % 40) - 10), created_by: ownerMember,
      })));
    } catch { /* best-effort */ }
  };

  // Meals → a plan per meal (distinct plan_date so no collision).
  const seedMeals = async () => {
    try {
      const { data: meals } = await admin.from('meals').insert(
        range(VOL).map((g) => ({ ...fam, name: `${pick(mealNames, g)} #${g + 1}`, meal_type: pick(['breakfast', 'lunch', 'dinner', 'snack'] as const, g), created_by: ownerId })),
      ).select('id');
      const mrows = (meals ?? []) as { id: string }[];
      if (mrows.length) await ins('meal_plans', mrows.map((m, i) => ({
        ...fam, meal_id: m.id, plan_date: dateKey(i - 100), meal_type: pick(['breakfast', 'lunch', 'dinner', 'snack'] as const, i), created_by: ownerId,
      })));
    } catch { /* best-effort */ }
  };

  // Grocery list → items.
  const seedGroceries = async () => {
    try {
      const { data: glists } = await admin.from('grocery_lists').insert([{ ...fam, name: 'Weekly Groceries', created_by: ownerId }]).select('id');
      const glistId = glists?.[0]?.id as string | undefined;
      if (glistId) await ins('grocery_items', range(VOL).map((g) => ({ ...fam, list_id: glistId, name: pick(groceries, g), is_checked: g % 5 === 0, created_by: ownerId })));
    } catch { /* best-effort */ }
  };

  // Chores → assignments (one per chore, spread across kids + statuses).
  const seedChores = async () => {
    try {
      const { data: choreRows } = await admin.from('chores').insert(
        range(VOL).map((g) => ({ ...fam, title: `${pick(choreTitles, g)} #${g + 1}`, points: 3 + (g % 5), created_by: ownerId })),
      ).select('id');
      const choreIds = (choreRows ?? []).map((c: { id: string }) => c.id);
      const choreStatuses = ['todo', 'in_progress', 'submitted', 'done', 'approved'] as const;
      if (choreIds.length) await ins('chore_assignments', choreIds.map((chore_id: string, g: number) => ({
        ...fam, chore_id, member_id: member(g % 3 + 1), status: pick(choreStatuses, g), due_at: iso((g % 20) - 7, 17),
      })));
    } catch { /* best-effort */ }
  };

  // Marketplace listings → saves + reviews (one each per listing).
  const seedMarketplace = async () => {
    try {
      const { data: listings } = await admin.from('marketplace_listings').insert(
        range(VOL).map((g) => ({
          ...fam, member_id: member(g), title: `${pick(listTitles, g)} #${g + 1}`, description: 'A well-loved family item, ready for a new home.',
          kind: pick(listKinds, g), category: pick(listCats, g), condition: pick(listCond, g), price_cents: (g % 20) * 500, status: 'available', location: 'Garage', created_by: ownerId,
        })),
      ).select('id');
      const ids = (listings ?? []).map((l: { id: string }) => l.id);
      if (ids.length) {
        await ins('marketplace_saves', ids.map((id: string, i: number) => ({ ...fam, listing_id: id, member_id: member(i + 1) })));
        await ins('marketplace_reviews', ids.map((id: string, i: number) => ({
          ...fam, listing_id: id, reviewer_member: member(i), reviewee_member: member(i + 1), role: 'buyer', rating: 4 + (i % 2), comment: 'Smooth hand-off — thank you!',
        })));
      }
    } catch { /* best-effort */ }
  };

  // Routines (Morning / Bedtime) with their steps.
  const seedRoutines = async () => {
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
  };

  // Family economy: a currency + a reward catalog (VOL rewards).
  const seedEconomy = async () => {
    try {
      const { data: currencies } = await admin.from('family_currencies').insert(
        [{ ...fam, name: 'Stars', emoji: '⭐', unit_label: 'star', is_active: true, created_by: ownerId }],
      ).select('id');
      const currencyId = currencies?.[0]?.id as string | undefined;
      if (currencyId) await ins('economy_rewards', range(VOL).map((g) => ({
        ...fam, currency_id: currencyId, title: `${pick(rewardTitles, g)} #${g + 1}`, emoji: pick(['🎬', '📺', '🍽️', '🌙', '🍦', '🧹'] as const, g), cost: (g % 20 + 1) * 10, is_active: true, created_by: ownerId,
      })));
    } catch { /* best-effort */ }
  };

  // Everything else is independent → build the row sets, then fire concurrently.
  await Promise.all([
    // Calendar — spread across ±45 days, morning-to-evening.
    ins('calendar_events', range(VOL).map((g) => ({
      ...fam, title: pick(evTitles, g), description: 'A believable family event.', location: `Place ${g % 8}`,
      category: pick(evCats, g), starts_at: iso((g % 90) - 45, 8 + (g % 10)), ends_at: iso((g % 90) - 45, 9 + (g % 10)),
      all_day: false, recurrence: 'none', assignee_id: member(g), created_by: ownerId,
    }))),
    seedTodos(),
    ins('family_reminders', range(VOL).map((g) => ({
      ...fam, title: pick(remTitles, g), kind: g % 3 === 0 ? 'bill' : 'time', status: pick(['active', 'active', 'active', 'completed'] as const, g),
      remind_at: iso((g % 30) - 5, 8 + (g % 12)), created_by: ownerId,
    }))),
    seedMeals(),
    ins('meal_votes', range(VOL).map((g) => ({ ...fam, title: `Dinner vote ${g + 1}`, status: pick(['open', 'open', 'closed'] as const, g), created_by: ownerId }))),
    seedGroceries(),
    seedChores(),
    ins('pantry_items', range(VOL).map((g) => ({
      ...fam, name: `${pick(pantryNames, g)} ${g + 1}`, location: pick(pantryLoc, g), quantity: g % 3 === 0 ? 1 : 6, low_threshold: 3, created_by: ownerId,
    }))),
    // Finances — transactions over the past ~180 days; bills over the next month.
    ins('transactions', range(VOL).map((g) => ({
      ...fam, name: pick(txNames, g), amount: 8 + (g % 120), category: pick(txCats, g),
      date: dateKey(-(g % 180)), type: pick(['expense', 'expense', 'expense', 'income'] as const, g), notes: 'Demo transaction', created_by: ownerId,
    }))),
    ins('bills', range(VOL).map((g) => ({
      ...fam, name: `${pick(billNames, g)} ${g + 1}`, amount: 30 + ((g * 13) % 260), due_date: dateKey((g % 45) - 5),
      is_recurring: true, recurrence: 'monthly', status: g % 6 === 0 ? 'overdue' : 'upcoming', category: 'Utilities', autopay: g % 3 === 0, created_by: ownerId,
    }))),
    ins('goals', range(VOL).map((g) => ({
      ...fam, title: `${pick(goalTitles, g)} #${g + 1}`, progress: (g * 9) % 100, is_complete: g % 7 === 0, target_date: dateKey((g % 200) + 5), created_by: ownerId,
    }))),
    ins('documents', range(VOL).map((g) => ({
      ...fam, title: `${pick(docTitles, g)} ${g + 1}`, category: 'general', storage_path: `${familyId}/demo/doc-${g}.pdf`, expires_at: dateKey((g % 200) + 5), created_by: ownerId,
    }))),
    ins('maintenance_tasks', range(VOL).map((g) => ({
      ...fam, title: `${pick(maintTitles, g)} #${g + 1}`, status: pick(['todo', 'todo', 'done'] as const, g), priority: pick(['low', 'medium', 'high'] as const, g), recurrence: 'none', due_at: iso((g % 60) - 15, 10), created_by: ownerId,
    }))),
    ins('family_facts', range(VOL).map((g) => ({
      ...fam, category: pick(factCats, g), label: `${pick(factLabels, g)} ${g + 1}`, value: pick(factVals, g), is_pinned: g % 8 === 0, created_by: ownerId,
    }))),
    ins('family_polls', range(VOL).map((g) => ({ ...fam, question: `${pick(pollQs, g)} (#${g + 1})`, kind: 'single', status: pick(['open', 'open', 'closed'] as const, g), created_by: ownerId }))),
    seedMarketplace(),
    // Health
    ins('medications', range(VOL).map((g) => ({
      ...fam, member_id: member(g), name: `${pick(medNames, g)} ${g + 1}`, dosage: pick(['1 tablet', '5 mL', '10 mg', '1 puff', '1 gummy', '200 mg'] as const, g),
      instructions: 'Take as directed.', is_active: g % 5 !== 0, created_by: ownerId,
    }))),
    ins('appointments', range(VOL).map((g) => ({
      ...fam, member_id: member(g), title: `${pick(apptTitles, g)} ${g + 1}`, provider: pick(['Dr. Kim', 'Dr. Lee', 'Dr. Patel', 'City Clinic'] as const, g),
      location: pick(['Downtown', 'Main St Clinic', 'Kids Health', 'Uptown'] as const, g), starts_at: iso((g % 90) - 20, 9 + (g % 8)), notes: 'Bring insurance card.', created_by: ownerId,
    }))),
    ins('health_visits', range(VOL).map((g) => ({
      ...fam, member_id: member(g), kind: pick(visitKinds, g), title: pick(['Annual physical', 'Cleaning', 'Eye check', 'Specialist', 'Therapy', 'Urgent care'] as const, g),
      provider_name: pick(['Dr. Lee', 'Bright Smiles', 'Vision Plus', 'Dr. Patel'] as const, g), visit_date: dateKey(-(g % 500) - 5), created_by: ownerId,
    }))),
    ins('immunizations', range(VOL).map((g) => ({
      ...fam, member_id: member(g), vaccine: pick(vaccines, g), dose_label: pick(['1st', '2nd', 'Booster', 'Annual'] as const, g),
      date_given: dateKey(-(g % 700) - 10), provider_name: 'City Clinic', created_by: ownerId,
    }))),
    // Kids / school
    ins('homework_assignments', range(VOL).map((g) => ({
      ...fam, member_id: member(g), subject: pick(subjects, g), title: `${pick(subjects, g)} — ${pick(['worksheet', 'reading', 'project', 'quiz prep', 'essay'] as const, g)} #${g + 1}`,
      due_at: iso((g % 30) - 5, 15), status: g % 4 === 0 ? 'done' : 'assigned', created_by: ownerId,
    }))),
    ins('school_classes', range(VOL).map((g) => ({
      ...fam, member_id: member(g % 3 + 1), subject: `${pick(subjects, g)} ${g + 1}`, teacher: pick(['Ms. Rivera', 'Mr. Chen', 'Mrs. Gold', 'Mr. Diaz'] as const, g),
      room: `Room ${10 + (g % 40)}`, day_of_week: (g % 5) + 1, created_by: ownerId,
    }))),
    ins('teams', range(VOL).map((g) => ({
      ...fam, member_id: member(g % 3 + 1), sport: pick(['Soccer', 'Basketball', 'Swimming', 'Baseball'] as const, g),
      team_name: `${pick(['Blue Jays', 'Sharks', 'Comets', 'Rockets'] as const, g)} ${g + 1}`, season: pick(['Fall', 'Winter', 'Spring', 'Summer'] as const, g), coach: pick(['Coach Dan', 'Coach Amy'] as const, g), is_active: g % 4 !== 0, created_by: ownerId,
    }))),
    ins('wishlist_items', range(VOL).map((g) => ({
      ...fam, member_id: member(g % 3 + 1), title: `${pick(wishTitles, g)} #${g + 1}`, price: 15 + (g % 20) * 20, priority: pick(['low', 'medium', 'high'] as const, g), created_by: ownerId,
    }))),
    ins('screen_time_entries', range(VOL).map((g) => ({
      ...fam, member_id: member(g % 3 + 1), entry_date: dateKey(-g), minutes: 30 + (g % 8) * 20,
      category: pick(['gaming', 'entertainment', 'social', 'educational'] as const, g), device: pick(['tablet', 'phone', 'tv', 'laptop'] as const, g), logged_by: ownerId,
    }))),
    ins('journal_entries', range(VOL).map((g) => ({
      ...fam, member_id: member(g), entry_date: dateKey(-g), mood: pick(journalMoods, g),
      title: `${pick(['A good day', 'Busy but fun', 'Quiet evening', 'Weekend adventure'] as const, g)} #${g + 1}`, body: 'A little snapshot of family life today.', created_by: ownerId,
    }))),
    // Home
    ins('home_warranties', range(VOL).map((g) => ({
      ...fam, name: `${pick(warTitles, g)} warranty ${g + 1}`, provider: pick(['Whirlpool', 'Samsung', 'Carrier', 'HomeShield'] as const, g),
      warranty_type: 'appliance', expires_on: dateKey((g % 200) + 30), status: pick(['active', 'active', 'expired'] as const, g), created_by: ownerId,
    }))),
    ins('notes', range(VOL).map((g) => ({
      ...fam, title: `${pick(noteTitles, g)} ${g + 1}`, body: 'A handy family note everyone can see.', is_pinned: g % 8 === 0, created_by: ownerId,
    }))),
    ins('family_memories', range(VOL).map((g) => ({
      ...fam, member_id: member(g), title: `${pick(memTitles, g)} #${g + 1}`, body: 'A little moment worth keeping.', kind: 'photo',
      memory_date: dateKey(-(g % 700) - 10), tags: ['family'], is_favorite: g % 4 === 0, status: 'active', created_by: ownerId,
    }))),
    seedRoutines(),
    seedEconomy(),
    // Assistant activity — distinct dedupe_key per row (the only UNIQUE constraint).
    ins('autopilot_suggestions', range(VOL).map((g) => ({
      ...fam, kind: pick(['groceries', 'reminder', 'document', 'calendar', 'finance'] as const, g),
      title: pick(['Reordered milk', 'Set a leave-by reminder for soccer', 'Filed the field-trip form', 'Flagged an overdue bill', 'Suggested a dinner plan'] as const, g),
      status: pick(['auto_executed', 'auto_executed', 'open'] as const, g), confidence: 70 + (g % 30), urgency: 1 + (g % 3), dedupe_key: `demo:${g}`, action_type: 'none',
    }))),
    ins('approval_requests', range(VOL).map((g) => ({
      ...fam, domain: pick(['finance', 'calendar', 'health', 'school'] as const, g),
      title: `${pick(['Approve the field-trip payment', 'Confirm the weekend babysitter', 'Approve a medication refill', 'Sign the permission slip'] as const, g)} #${g + 1}`,
      status: pick(['pending', 'pending', 'approved'] as const, g), priority: pick(['high', 'normal', 'low'] as const, g), agent: pick(['Budget Coach', 'Scheduler', 'Health Aide'] as const, g), requested_by_kind: 'ai',
    }))),
    ins('agent_activity', range(VOL).map((g) => ({
      ...fam, agent: pick(['scheduler', 'meal_planner', 'budget_coach', 'health_aide'] as const, g), kind: 'action',
      title: `${pick(['Resolved a calendar conflict', 'Built this week’s dinner plan', 'Trimmed the grocery bill', 'Booked a checkup'] as const, g)} #${g + 1}`, status: 'done', severity: 'info',
    }))),
  ]);

  // ── Naturally-singular / config surfaces (realistic counts, not 200) ──────
  await Promise.all([
    ins('budgets', ([
      ['Groceries', 600], ['Dining', 200], ['Transportation', 150], ['Kids', 250], ['Entertainment', 120], ['Utilities', 300], ['Health', 180], ['Clothing', 140], ['Home', 220], ['Savings', 400], ['Gifts', 90], ['Pets', 80],
    ] as const).map(([category, amount]) => ({ ...fam, category, amount, period: 'monthly', created_by: ownerId }))),
    ins('financial_accounts', ([
      ['Everyday Checking', 'checking', 3240.55], ['Family Savings', 'savings', 12800.0], ['Rewards Card', 'credit', -640.2], ['Kids College', 'investment', 8600.0], ['Vacation Fund', 'savings', 2150.0], ['Emergency Fund', 'savings', 6000.0], ['Business Checking', 'checking', 1875.0], ['Travel Card', 'credit', -220.0],
    ] as const).map(([name, type, balance]) => ({ ...fam, name, type, balance, currency: 'USD', created_by: ownerId }))),
    ins('savings_goals', ([
      ['Vacation Fund', '🏖️', 4500, 1800], ['Emergency Fund', '🛟', 10000, 6200], ['New Bike', '🚲', 300, 120], ['Kids College', '🎓', 20000, 8600], ['Holiday Gifts', '🎁', 1200, 450], ['New Laptop', '💻', 1500, 600], ['Home Reno', '🏠', 8000, 2400], ['Car Fund', '🚗', 15000, 4300], ['Camp', '🏕️', 900, 300], ['Braces', '🦷', 5000, 1500], ['Wedding', '💍', 12000, 3000], ['Rainy Day', '☔', 3000, 1100],
    ] as const).map(([name, emoji, target_amount, current_amount], g) => ({
      ...fam, name, emoji, target_amount, current_amount, target_date: dateKey((g + 1) * 45), created_by: ownerId,
    }))),
    ins('pets', ([
      ['Biscuit', 'dog', 'Beagle', -1200], ['Mittens', 'cat', 'Tabby', -900], ['Nibbles', 'small_mammal', 'Hamster', -300], ['Splash', 'fish', 'Goldfish', -150], ['Kiwi', 'bird', 'Parakeet', -600], ['Shadow', 'cat', 'Siamese', -1500],
    ] as const).map(([name, species, breed, born]) => ({ ...fam, name, species, breed, birthday: dateKey(born), is_active: true, vet_name: 'Happy Paws Vet', created_by: ownerId }))),
    ins('vehicles', ([
      ['The Van', 'Honda', 'Odyssey', 2019, 54200], ['Commuter', 'Toyota', 'Corolla', 2021, 28900], ['Weekend', 'Subaru', 'Outback', 2018, 61000], ['Teen Car', 'Mazda', '3', 2016, 88000],
    ] as const).map(([nickname, make, model, year, mileage]) => ({ ...fam, nickname, make, model, year, mileage, status: 'active', created_by: ownerId }))),
    ins('reminder_lists', ['Household', 'Kids', 'Health', 'Finance', 'Shopping', 'Pets'].map((name) => ({ ...fam, created_by: ownerId, name }))),
    ins('vacations', range(12).map((g) => ({
      ...fam, title: `${pick(['Summer in Maui', 'Grandparents visit', 'Ski trip', 'City break', 'Road trip', 'Cruise'] as const, g)} ${g + 1}`,
      kind: pick(['flight', 'road_trip', 'cruise', 'other'] as const, g), status: pick(['planning', 'booked', 'completed'] as const, g), destination: pick(['Maui, HI', 'Denver, CO', 'Lake Tahoe', 'New York, NY'] as const, g),
      start_date: dateKey(g * 30 + 20), end_date: dateKey(g * 30 + 27), budget_cents: (g + 1) * 50000, currency: 'USD', created_by: ownerId,
    }))),
    ins('trips', range(12).map((g) => ({
      ...fam, name: `${pick(['Ski weekend', 'Beach day', 'Camping', 'Museum trip', 'Hike'] as const, g)} ${g + 1}`, destination: pick(['Lake Tahoe', 'Santa Cruz', 'Yosemite', 'Downtown'] as const, g),
      start_date: dateKey(g * 15 + 5), end_date: dateKey(g * 15 + 7), status: pick(['planning', 'booked'] as const, g), created_by: ownerId,
    }))),
    ins('relationship_dates', range(12).map((g) => ({
      ...fam, created_by: ownerId, kind: pick(['anniversary', 'date_night', 'birthday', 'first_date'] as const, g),
      title: `${pick(['Our Anniversary', 'Date night', 'Weekend away', 'Dinner out'] as const, g)} ${g + 1}`, event_date: dateKey(g * 20 + 6), recurs_annually: g % 2 === 0,
    }))),
    ins('family_milestones', range(20).map((g) => ({
      ...fam, member_id: member(g), title: `${pick(['Leo first steps', 'Emma 10th birthday', 'Moved into the new house', 'Adopted Biscuit', 'First lost tooth', 'Learned to ride a bike'] as const, g)} #${g + 1}`,
      description: 'A family milestone.', milestone_date: dateKey(-((g + 1) * 60)), category: pick(['baby', 'birthday', 'home', 'pet', 'school'] as const, g), status: 'active', created_by: ownerId,
    }))),
  ]);
}
