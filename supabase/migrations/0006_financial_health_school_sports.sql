-- ============================================================
-- Migration 0006: Financial, Health, School & Sports tables
-- Run in Supabase SQL Editor to create all new tables
-- ============================================================

-- ── Enums ──────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE account_type AS ENUM ('checking', 'savings', 'credit', 'investment', 'retirement');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE transaction_type AS ENUM ('income', 'expense', 'transfer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE budget_period AS ENUM ('weekly', 'monthly', 'yearly');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE bill_status AS ENUM ('upcoming', 'paid', 'overdue');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE metric_type AS ENUM ('steps', 'sleep_hours', 'heart_rate', 'calories', 'active_minutes', 'distance', 'weight', 'water_cups');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE game_result AS ENUM ('win', 'loss', 'tie');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE grade_type AS ENUM ('test', 'quiz', 'homework', 'project', 'final', 'participation', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Helper for timestamps ──────────────────────────────────
-- Reuse existing trigger function if available
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- ============================================================
-- FINANCIAL TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS financial_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name text NOT NULL,
  type account_type NOT NULL DEFAULT 'checking',
  institution text,
  last_four text,
  balance numeric(12,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_financial_accounts_family ON financial_accounts(family_id);
CREATE TRIGGER set_financial_accounts_updated BEFORE UPDATE ON financial_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  account_id uuid REFERENCES financial_accounts(id) ON DELETE SET NULL,
  name text NOT NULL,
  amount numeric(12,2) NOT NULL,
  category text,
  date date NOT NULL DEFAULT CURRENT_DATE,
  type transaction_type NOT NULL DEFAULT 'expense',
  notes text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transactions_family ON transactions(family_id);
CREATE INDEX IF NOT EXISTS idx_transactions_family_date ON transactions(family_id, date);
CREATE TRIGGER set_transactions_updated BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  category text NOT NULL,
  amount numeric(12,2) NOT NULL,
  period budget_period NOT NULL DEFAULT 'monthly',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_budgets_family ON budgets(family_id);
CREATE TRIGGER set_budgets_updated BEFORE UPDATE ON budgets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name text NOT NULL,
  amount numeric(12,2) NOT NULL,
  due_date date NOT NULL,
  is_recurring boolean NOT NULL DEFAULT false,
  recurrence text DEFAULT 'none',
  status bill_status NOT NULL DEFAULT 'upcoming',
  category text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bills_family ON bills(family_id);
CREATE TRIGGER set_bills_updated BEFORE UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS savings_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name text NOT NULL,
  target_amount numeric(12,2) NOT NULL,
  current_amount numeric(12,2) NOT NULL DEFAULT 0,
  target_date date,
  emoji text DEFAULT '🎯',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_savings_goals_family ON savings_goals(family_id);
CREATE TRIGGER set_savings_goals_updated BEFORE UPDATE ON savings_goals FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- HEALTH TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS health_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  type metric_type NOT NULL,
  value numeric(10,2) NOT NULL,
  unit text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_health_metrics_family ON health_metrics(family_id);
CREATE INDEX IF NOT EXISTS idx_health_metrics_member ON health_metrics(family_id, member_id);
CREATE INDEX IF NOT EXISTS idx_health_metrics_date ON health_metrics(family_id, recorded_at);

CREATE TABLE IF NOT EXISTS workout_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  activity text NOT NULL,
  duration_minutes int,
  calories int,
  distance numeric(8,2),
  notes text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workout_logs_family ON workout_logs(family_id);
CREATE INDEX IF NOT EXISTS idx_workout_logs_member ON workout_logs(family_id, member_id);
CREATE TRIGGER set_workout_logs_updated BEFORE UPDATE ON workout_logs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- SCHOOL TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS school_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  subject text NOT NULL,
  teacher text,
  room text,
  time_slot text,
  day_of_week int, -- 0=Sunday, 1=Monday, etc.
  school_name text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_school_classes_family ON school_classes(family_id);
CREATE INDEX IF NOT EXISTS idx_school_classes_member ON school_classes(family_id, member_id);
CREATE TRIGGER set_school_classes_updated BEFORE UPDATE ON school_classes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS grades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  class_id uuid REFERENCES school_classes(id) ON DELETE SET NULL,
  subject text NOT NULL,
  title text,
  grade text,
  grade_type grade_type NOT NULL DEFAULT 'other',
  score numeric(5,2),
  max_score numeric(5,2) DEFAULT 100,
  date date NOT NULL DEFAULT CURRENT_DATE,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_grades_family ON grades(family_id);
CREATE INDEX IF NOT EXISTS idx_grades_member ON grades(family_id, member_id);
CREATE TRIGGER set_grades_updated BEFORE UPDATE ON grades FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- SPORTS TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  sport text NOT NULL,
  team_name text NOT NULL,
  season text,
  coach text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_teams_family ON teams(family_id);
CREATE TRIGGER set_teams_updated BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS game_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  opponent text NOT NULL,
  our_score int NOT NULL DEFAULT 0,
  their_score int NOT NULL DEFAULT 0,
  date date NOT NULL DEFAULT CURRENT_DATE,
  result game_result NOT NULL,
  notes text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_game_results_family ON game_results(family_id);
CREATE INDEX IF NOT EXISTS idx_game_results_team ON game_results(team_id);
CREATE TRIGGER set_game_results_updated BEFORE UPDATE ON game_results FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- RLS POLICIES FOR ALL NEW TABLES
-- ============================================================

DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'financial_accounts', 'transactions', 'budgets', 'bills', 'savings_goals',
    'health_metrics', 'workout_logs',
    'school_classes', 'grades',
    'teams', 'game_results'
  ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "Members can manage %1$s" ON %1$I', tbl);
    EXECUTE format(
      'CREATE POLICY "Members can manage %1$s" ON %1$I FOR ALL TO authenticated USING (is_family_member(family_id)) WITH CHECK (is_family_member(family_id))',
      tbl
    );
  END LOOP;
END $$;

-- ============================================================
-- Done! 11 new tables with indexes, triggers, and RLS policies.
-- ============================================================
