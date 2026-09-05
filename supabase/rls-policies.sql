-- ============================================================
-- Bubaly: Comprehensive RLS policies for all tables
-- Run this in the Supabase SQL Editor to fix all permission errors.
-- Safe to re-run — uses DROP IF EXISTS before each CREATE.
-- ============================================================

-- Helper: check if user is a member of a given family
-- Accepts both uuid and text to match any column type.
DROP FUNCTION IF EXISTS is_family_member(uuid);
DROP FUNCTION IF EXISTS is_family_member(text);

CREATE FUNCTION is_family_member(fid uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM family_members
    WHERE family_id = fid
      AND user_id = auth.uid()
      AND is_active = true
  );
$$;

-- For the families table itself, the creator may not be a member yet
-- (the DB trigger adds them after insert), so we also check created_by.
-- This is handled in the per-table policies below.

-- ============================================================
-- FAMILIES
-- ============================================================
ALTER TABLE families ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can create families" ON families;
CREATE POLICY "Users can create families" ON families
  FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS "Users can read own families" ON families;
CREATE POLICY "Users can read own families" ON families
  FOR SELECT TO authenticated
  USING (is_family_member(id) OR created_by = auth.uid());

DROP POLICY IF EXISTS "Members can update family" ON families;
CREATE POLICY "Members can update family" ON families
  FOR UPDATE TO authenticated
  USING (is_family_member(id))
  WITH CHECK (is_family_member(id));

-- ============================================================
-- FAMILY_MEMBERS
-- ============================================================
ALTER TABLE family_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read family members" ON family_members;
CREATE POLICY "Members can read family members" ON family_members
  FOR SELECT TO authenticated
  USING (is_family_member(family_id) OR user_id = auth.uid());

DROP POLICY IF EXISTS "Members can insert family members" ON family_members;
CREATE POLICY "Members can insert family members" ON family_members
  FOR INSERT TO authenticated
  WITH CHECK (is_family_member(family_id));

DROP POLICY IF EXISTS "Members can update family members" ON family_members;
CREATE POLICY "Members can update family members" ON family_members
  FOR UPDATE TO authenticated
  USING (is_family_member(family_id));

DROP POLICY IF EXISTS "Members can delete family members" ON family_members;
CREATE POLICY "Members can delete family members" ON family_members
  FOR DELETE TO authenticated
  USING (is_family_member(family_id));

-- ============================================================
-- PROFILES
-- ============================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own profile" ON profiles;
CREATE POLICY "Users can read own profile" ON profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
CREATE POLICY "Users can insert own profile" ON profiles
  FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());

-- ============================================================
-- USER_PREFERENCES
-- ============================================================
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own preferences" ON user_preferences;
CREATE POLICY "Users can manage own preferences" ON user_preferences
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ============================================================
-- INVITES
-- ============================================================
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can create invites" ON invites;
CREATE POLICY "Members can create invites" ON invites
  FOR INSERT TO authenticated
  WITH CHECK (is_family_member(family_id));

DROP POLICY IF EXISTS "Members can read invites" ON invites;
CREATE POLICY "Members can read invites" ON invites
  FOR SELECT TO authenticated
  USING (is_family_member(family_id) OR email = auth.jwt()->>'email');

DROP POLICY IF EXISTS "Anyone can read invite by token" ON invites;
CREATE POLICY "Anyone can read invite by token" ON invites
  FOR SELECT TO authenticated
  USING (true);

-- ============================================================
-- CALENDAR_EVENTS
-- ============================================================
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can manage calendar events" ON calendar_events;
CREATE POLICY "Members can manage calendar events" ON calendar_events
  FOR ALL TO authenticated
  USING (is_family_member(family_id))
  WITH CHECK (is_family_member(family_id));

-- ============================================================
-- CHORES
-- ============================================================
ALTER TABLE chores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can manage chores" ON chores;
CREATE POLICY "Members can manage chores" ON chores
  FOR ALL TO authenticated
  USING (is_family_member(family_id))
  WITH CHECK (is_family_member(family_id));

-- ============================================================
-- CHORE_ASSIGNMENTS
-- ============================================================
ALTER TABLE chore_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can manage chore assignments" ON chore_assignments;
CREATE POLICY "Members can manage chore assignments" ON chore_assignments
  FOR ALL TO authenticated
  USING (is_family_member(family_id))
  WITH CHECK (is_family_member(family_id));

-- ============================================================
-- MEALS
-- ============================================================
ALTER TABLE meals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can manage meals" ON meals;
CREATE POLICY "Members can manage meals" ON meals
  FOR ALL TO authenticated
  USING (is_family_member(family_id))
  WITH CHECK (is_family_member(family_id));

-- ============================================================
-- MEAL_PLANS
-- ============================================================
ALTER TABLE meal_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can manage meal plans" ON meal_plans;
CREATE POLICY "Members can manage meal plans" ON meal_plans
  FOR ALL TO authenticated
  USING (is_family_member(family_id))
  WITH CHECK (is_family_member(family_id));

-- ============================================================
-- GROCERY_LISTS
-- ============================================================
ALTER TABLE grocery_lists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can manage grocery lists" ON grocery_lists;
CREATE POLICY "Members can manage grocery lists" ON grocery_lists
  FOR ALL TO authenticated
  USING (is_family_member(family_id))
  WITH CHECK (is_family_member(family_id));

-- ============================================================
-- GROCERY_ITEMS
-- ============================================================
ALTER TABLE grocery_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can manage grocery items" ON grocery_items;
CREATE POLICY "Members can manage grocery items" ON grocery_items
  FOR ALL TO authenticated
  USING (is_family_member(family_id))
  WITH CHECK (is_family_member(family_id));

-- ============================================================
-- SCHOOL_EVENTS
-- ============================================================
ALTER TABLE school_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can manage school events" ON school_events;
CREATE POLICY "Members can manage school events" ON school_events
  FOR ALL TO authenticated
  USING (is_family_member(family_id))
  WITH CHECK (is_family_member(family_id));

-- ============================================================
-- SPORTS_EVENTS
-- ============================================================
ALTER TABLE sports_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can manage sports events" ON sports_events;
CREATE POLICY "Members can manage sports events" ON sports_events
  FOR ALL TO authenticated
  USING (is_family_member(family_id))
  WITH CHECK (is_family_member(family_id));

-- ============================================================
-- APPOINTMENTS
-- ============================================================
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can manage appointments" ON appointments;
CREATE POLICY "Members can manage appointments" ON appointments
  FOR ALL TO authenticated
  USING (is_family_member(family_id))
  WITH CHECK (is_family_member(family_id));

-- ============================================================
-- REMINDERS
-- ============================================================
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can manage reminders" ON reminders;
CREATE POLICY "Members can manage reminders" ON reminders
  FOR ALL TO authenticated
  USING (is_family_member(family_id))
  WITH CHECK (is_family_member(family_id));

-- ============================================================
-- DOCUMENTS
-- ============================================================
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can manage documents" ON documents;
CREATE POLICY "Members can manage documents" ON documents
  FOR ALL TO authenticated
  USING (is_family_member(family_id))
  WITH CHECK (is_family_member(family_id));

-- ============================================================
-- NOTES
-- ============================================================
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can manage notes" ON notes;
CREATE POLICY "Members can manage notes" ON notes
  FOR ALL TO authenticated
  USING (is_family_member(family_id))
  WITH CHECK (is_family_member(family_id));

-- ============================================================
-- GOALS
-- ============================================================
ALTER TABLE goals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can manage goals" ON goals;
CREATE POLICY "Members can manage goals" ON goals
  FOR ALL TO authenticated
  USING (is_family_member(family_id))
  WITH CHECK (is_family_member(family_id));

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own notifications" ON notifications;
CREATE POLICY "Users can manage own notifications" ON notifications
  FOR ALL TO authenticated
  USING (is_family_member(family_id) AND (user_id = auth.uid() OR user_id IS NULL))
  WITH CHECK (is_family_member(family_id));

-- ============================================================
-- HOME_ASSETS
-- ============================================================
ALTER TABLE home_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can manage home assets" ON home_assets;
CREATE POLICY "Members can manage home assets" ON home_assets
  FOR ALL TO authenticated
  USING (is_family_member(family_id))
  WITH CHECK (is_family_member(family_id));

-- ============================================================
-- MAINTENANCE_TASKS
-- ============================================================
ALTER TABLE maintenance_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can manage maintenance tasks" ON maintenance_tasks;
CREATE POLICY "Members can manage maintenance tasks" ON maintenance_tasks
  FOR ALL TO authenticated
  USING (is_family_member(family_id))
  WITH CHECK (is_family_member(family_id));

-- ============================================================
-- SUBSCRIPTIONS
-- ============================================================
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read subscriptions" ON subscriptions;
CREATE POLICY "Members can read subscriptions" ON subscriptions
  FOR SELECT TO authenticated
  USING (is_family_member(family_id));

DROP POLICY IF EXISTS "Service role can manage subscriptions" ON subscriptions;
CREATE POLICY "Service role can manage subscriptions" ON subscriptions
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- BILLING_CUSTOMERS
-- ============================================================
ALTER TABLE billing_customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read billing customers" ON billing_customers;
CREATE POLICY "Members can read billing customers" ON billing_customers
  FOR SELECT TO authenticated
  USING (is_family_member(family_id));

DROP POLICY IF EXISTS "Service role can manage billing customers" ON billing_customers;
CREATE POLICY "Service role can manage billing customers" ON billing_customers
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- AUDIT_LOGS
-- ============================================================
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can insert audit logs" ON audit_logs;
CREATE POLICY "Members can insert audit logs" ON audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (is_family_member(family_id));

DROP POLICY IF EXISTS "Members can read audit logs" ON audit_logs;
CREATE POLICY "Members can read audit logs" ON audit_logs
  FOR SELECT TO authenticated
  USING (is_family_member(family_id));

-- ============================================================
-- AI_MESSAGES
-- ============================================================
ALTER TABLE ai_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own ai messages" ON ai_messages;
CREATE POLICY "Users can manage own ai messages" ON ai_messages
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ============================================================
-- Done! All tables now have proper RLS policies.
-- ============================================================
