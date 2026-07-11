import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

type DB = SupabaseClient<Database>;

// Seed a fresh demo family with a compact, realistic dataset so a visitor can
// immediately see — and CRUD — populated Family+ surfaces. Every table insert is
// best-effort: a schema drift on one table skips it rather than aborting the whole
// demo. Volume is intentionally small (a believable family, not a load test).

const iso = (daysFromNow: number, hour = 9) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
const dateKey = (daysFromNow: number) => iso(daysFromNow).slice(0, 10);

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

  // This week's schedule.
  await ins('calendar_events', [
    { ...fam, title: 'Dentist — Emma', starts_at: iso(0, 8), category: 'appointment', created_by: ownerId },
    { ...fam, title: 'Soccer practice', starts_at: iso(0, 16), category: 'sports', created_by: ownerId },
    { ...fam, title: 'Parent–teacher night', starts_at: iso(2, 18), category: 'school', created_by: ownerId },
    { ...fam, title: 'Family movie night', starts_at: iso(4, 19), category: 'personal', created_by: ownerId },
  ]);

  // Tasks + reminders.
  await ins('todo_items', [
    { ...fam, title: 'Sign the permission slip', is_done: false, due_date: dateKey(1), created_by: ownerId },
    { ...fam, title: 'Renew library books', is_done: false, due_date: dateKey(3), created_by: ownerId },
    { ...fam, title: 'Book summer camp', is_done: false, created_by: ownerId },
  ]);
  await ins('family_reminders', [
    { ...fam, title: 'Pick up Leo at 3pm', kind: 'time', status: 'active', remind_at: iso(0, 15), created_by: ownerId },
    { ...fam, title: 'Pay the water bill', kind: 'bill', status: 'active', remind_at: iso(2, 9), created_by: ownerId },
  ]);

  // Meals for the week (capture ids to plan them onto dinner).
  try {
    const { data: meals } = await admin.from('meals').insert([
      { ...fam, name: 'Taco Tuesday', meal_type: 'dinner', created_by: ownerId },
      { ...fam, name: 'Sheet-pan salmon', meal_type: 'dinner', created_by: ownerId },
    ]).select('id');
    if (meals && meals.length) {
      await ins('meal_plans', meals.map((m, i) => ({ ...fam, meal_id: m.id, plan_date: dateKey(i), meal_type: 'dinner', created_by: ownerId })));
    }
  } catch { /* best-effort */ }

  // Groceries + a couple of chores.
  await ins('grocery_items', [
    { ...fam, name: 'Milk', is_checked: false, created_by: ownerId },
    { ...fam, name: 'Bananas', is_checked: false, created_by: ownerId },
    { ...fam, name: 'Bread', is_checked: true, created_by: ownerId },
  ]);
  await ins('chores', [
    { ...fam, title: 'Take out the trash', points: 5, created_by: ownerId },
    { ...fam, title: 'Feed the dog', points: 3, created_by: ownerId },
  ]);

  // Assistant activity so the proactive front door + "time saved" light up.
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
