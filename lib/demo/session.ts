import 'server-only';
import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/server';
import { DEMO_ACCOUNT_EMAIL, DEMO_ACCOUNT_NAME, DEMO_ACCOUNT_LEGACY_NAME } from './config';
import { seedDemoFamily } from './seed';

type Admin = SupabaseClient<Database>;

export type DemoCreds = { userId: string; email: string; password: string };

const newPassword = () => randomBytes(24).toString('base64url');

/** Find an auth user id by email (paginated — auth has no direct lookup). */
async function findUserIdByEmail(admin: Admin, email: string): Promise<string | null> {
  const wanted = email.toLowerCase();
  for (let page = 1; page <= 25; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    const users = data?.users ?? [];
    const hit = users.find((u) => u.email?.toLowerCase() === wanted);
    if (hit) return hit.id;
    if (users.length < 200) break;
  }
  return null;
}

/**
 * Get-or-create THE single shared demo account ("Bubaly Demo"). Idempotent: the
 * family is found by its stable name (only the demo ever creates a family with
 * this name), so repeat calls reuse the same user + family instead of spawning a
 * new throwaway user per visitor. Creates the auth user, family, owning member,
 * Family+ subscription and active-family preference on first run only.
 */
export async function ensureDemoAccount(admin: Admin): Promise<{ userId: string; familyId: string } | null> {
  // Already provisioned? Reuse it — matching the current name OR the legacy name,
  // which we rename in place so the existing shared account + its data carry over.
  const { data: existing } = await admin
    .from('families').select('id, created_by, name')
    .in('name', [DEMO_ACCOUNT_NAME, DEMO_ACCOUNT_LEGACY_NAME])
    .order('created_at').limit(1).maybeSingle();
  if (existing?.id) {
    // Migrate a legacy-named family to the canonical "Bubaly Demo Account".
    if (existing.name !== DEMO_ACCOUNT_NAME) {
      await admin.from('families').update({ name: DEMO_ACCOUNT_NAME }).eq('id', existing.id);
    }
    const userId = existing.created_by ?? (await findUserIdByEmail(admin, DEMO_ACCOUNT_EMAIL));
    if (userId) return { userId, familyId: existing.id };
  }

  // First run — create the account. If the auth user already exists (a prior
  // partial run), reuse it rather than failing on the duplicate email.
  let userId: string | null = null;
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email: DEMO_ACCOUNT_EMAIL, password: newPassword(), email_confirm: true,
    user_metadata: { demo: true, full_name: DEMO_ACCOUNT_NAME },
  });
  if (created?.user) userId = created.user.id;
  else userId = await findUserIdByEmail(admin, DEMO_ACCOUNT_EMAIL);
  if (!userId) { console.error('[demo] could not create/find demo user', cErr); return null; }

  const { data: family, error: fErr } = await admin
    .from('families').insert({ name: DEMO_ACCOUNT_NAME, timezone: 'UTC', created_by: userId })
    .select('id').single();
  if (fErr || !family) { console.error('[demo] family insert failed', fErr); return null; }
  const familyId = family.id;

  await admin.from('family_members').upsert(
    { family_id: familyId, user_id: userId, role: 'parent', display_name: 'You', is_active: true },
    { onConflict: 'family_id,user_id' },
  );
  // Family+ so every capability is unlocked (plan 'plus' resolves to level 2).
  await admin.from('subscriptions').insert({
    family_id: familyId, plan: 'plus', status: 'active',
    current_period_end: new Date(Date.now() + 3650 * 86_400_000).toISOString(),
  });
  await admin.from('user_preferences').upsert(
    { user_id: userId, active_family_id: familyId }, { onConflict: 'user_id' },
  );

  return { userId, familyId };
}

// The family-scoped tables the demo seed populates — cleared (children first) on
// every reset so each visitor gets a pristine, fully-seeded family. The owning
// member ("You") is preserved; only the seeded local members are removed.
const SEED_TABLES = [
  // Children strictly before their parents (FK / cascade safety).
  'marketplace_saves', 'marketplace_reviews', 'marketplace_listings',
  'meal_plans', 'meals', 'meal_votes',
  'calendar_events', 'family_reminders', 'chores', 'pantry_items',
  'todo_items', 'todo_lists', 'grocery_items', 'grocery_lists',
  'transactions', 'budgets', 'financial_accounts', 'bills',
  'goals', 'documents', 'maintenance_tasks', 'family_facts', 'family_polls',
  // Health
  'medications', 'appointments', 'health_visits', 'immunizations',
  // Kids / school
  'homework_assignments', 'school_classes', 'teams', 'wishlist_items',
  'screen_time_entries', 'journal_entries',
  // Home
  'pets', 'vehicles', 'home_warranties',
  // Trips / relationship / misc
  'vacations', 'trips', 'relationship_dates', 'notes', 'reminder_lists',
  // Economy (rewards reference the currency)
  'economy_rewards', 'family_currencies',
  // Assistant activity
  'autopilot_suggestions', 'approval_requests', 'agent_activity',
] as const;

/** Wipe the demo family's seeded data and re-seed it fresh (all ~200 rows). */
export async function resetDemoData(admin: Admin, familyId: string, ownerId: string): Promise<void> {
  for (const table of SEED_TABLES) {
    try { await admin.from(table as never).delete().eq('family_id', familyId); } catch { /* best-effort */ }
  }
  // Drop the seeded local members (Sam/Emma/Leo) but keep the owning account member.
  try { await admin.from('family_members').delete().eq('family_id', familyId).is('user_id', null); } catch { /* best-effort */ }
  await seedDemoFamily(admin, familyId, ownerId);
}

/**
 * Prepare a demo login: ensure the single "Bubaly Demo" account exists, reset its
 * data to a fresh, fully-seeded state, rotate its password (so we can sign the
 * visitor in without storing a secret), and open a demo_sessions row with the
 * clock NOT started yet (expires_at = null). The app opens behind the blurred
 * email-capture gate; the 5-minute countdown begins only once the visitor submits
 * their email (see `startDemoClockAction`). Returns credentials for sign-in.
 */
export async function startDemoSession(): Promise<DemoCreds | null> {
  const admin = createServiceClient();
  const account = await ensureDemoAccount(admin);
  if (!account) return null;
  const { userId, familyId } = account;

  await resetDemoData(admin, familyId, userId);

  const password = newPassword();
  const { error: pErr } = await admin.auth.admin.updateUserById(userId, { password });
  if (pErr) { console.error('[demo] password rotation failed', pErr); return null; }

  // Clock deferred: expires_at stays null until the email gate is submitted, so
  // (1) the app opens behind the email-capture pop-up and (2) the 5-minute clock
  // is fair — it starts when the visitor actually begins, not at provisioning.
  // If this fails (most likely: demo_sessions table missing because migrations
  // 0138/0161 aren't applied), the gate + timer won't render — so surface it
  // loudly instead of silently. Sign-in still proceeds (you land in the demo
  // family), the demo chrome just won't appear until the table exists.
  const { error: sErr } = await admin.from('demo_sessions').upsert(
    { user_id: userId, family_id: familyId, expires_at: null, email: null },
    { onConflict: 'user_id' },
  );
  if (sErr) console.error('[demo] demo_sessions upsert failed — apply migrations 0138/0161 to enable the timer.', sErr);

  return { userId, email: DEMO_ACCOUNT_EMAIL, password };
}

/** Rotate the shared demo password and return it — used to retry a sign-in that
 *  lost a concurrent-login race (another visitor rotated it first). */
export async function rotateDemoPassword(): Promise<string | null> {
  const admin = createServiceClient();
  const userId = await findUserIdByEmail(admin, DEMO_ACCOUNT_EMAIL);
  if (!userId) return null;
  const password = newPassword();
  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  return error ? null : password;
}

/**
 * End a demo session. The single shared account is NEVER deleted — we just clear
 * its session row (clock + captured email) so the next visitor starts behind a
 * fresh email gate. Sign-out (clearing the cookie) is handled by the caller.
 */
export async function endDemoSession(userId: string): Promise<void> {
  const admin = createServiceClient();
  try {
    await admin.from('demo_sessions').update({ expires_at: null, email: null }).eq('user_id', userId);
  } catch (e) {
    console.error('[demo] session reset failed', e);
  }
}

/** Reap expired demo clocks: clear the session row so it resets for the next
 *  visitor. The shared account and its data are left intact. */
export async function cleanupExpiredDemoSessions(now: Date = new Date()): Promise<number> {
  const admin = createServiceClient();
  const { data } = await admin
    .from('demo_sessions').select('user_id').lt('expires_at', now.toISOString()).limit(500);
  const ids = data ?? [];
  for (const r of ids) await endDemoSession(r.user_id);
  return ids.length;
}
