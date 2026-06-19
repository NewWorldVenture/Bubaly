-- ============================================================
-- Migration 0009: Medical & Dental records
-- Providers (doctors/dentists), insurance policies, and per-member
-- medical profiles. One set of tables serves both the Medical and
-- Dental sections, discriminated by the record_kind enum.
-- Run in the Supabase SQL Editor.
-- ============================================================

-- ── Enum ───────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE record_kind AS ENUM ('medical', 'dental');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Reuse the shared updated_at trigger function ───────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- ============================================================
-- PROVIDERS  (doctors / dentists)
-- member_id null = a whole-family provider (e.g. family physician).
-- ============================================================
CREATE TABLE IF NOT EXISTS health_providers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id     uuid REFERENCES family_members(id) ON DELETE SET NULL,
  kind          record_kind NOT NULL DEFAULT 'medical',
  name          text NOT NULL,
  specialty     text,
  practice_name text,
  phone         text,
  fax           text,
  email         text,
  address       text,
  is_primary    boolean NOT NULL DEFAULT false,
  notes         text,
  created_by    uuid REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_health_providers_family ON health_providers(family_id, kind);
CREATE INDEX IF NOT EXISTS idx_health_providers_member ON health_providers(family_id, member_id);
CREATE TRIGGER set_health_providers_updated BEFORE UPDATE ON health_providers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- INSURANCE POLICIES  (medical or dental)
-- member_id null = covers the whole family.
-- Card photos live in the private "documents" Storage bucket;
-- we keep only the object path here.
-- ============================================================
CREATE TABLE IF NOT EXISTS insurance_policies (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id              uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id              uuid REFERENCES family_members(id) ON DELETE SET NULL,
  kind                   record_kind NOT NULL DEFAULT 'medical',
  insurer                text NOT NULL,
  plan_name              text,
  plan_type              text,
  policy_number          text,
  group_number           text,
  rx_bin                 text,
  rx_pcn                 text,
  rx_group               text,
  customer_service_phone text,
  front_image_path       text,
  back_image_path        text,
  effective_date         date,
  is_primary             boolean NOT NULL DEFAULT true,
  notes                  text,
  created_by             uuid REFERENCES auth.users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_insurance_policies_family ON insurance_policies(family_id, kind);
CREATE INDEX IF NOT EXISTS idx_insurance_policies_member ON insurance_policies(family_id, member_id);
CREATE TRIGGER set_insurance_policies_updated BEFORE UPDATE ON insurance_policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- MEDICAL PROFILES  (one row per member; shared by both sections)
-- Holds the history copied onto every check-in form.
-- ============================================================
CREATE TABLE IF NOT EXISTS medical_profiles (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id                  uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id                  uuid NOT NULL UNIQUE REFERENCES family_members(id) ON DELETE CASCADE,
  blood_type                 text,
  allergies                  text,
  conditions                 text,
  current_medications        text,
  primary_physician          text,
  preferred_pharmacy         text,
  pharmacy_phone             text,
  emergency_contact_name     text,
  emergency_contact_phone    text,
  emergency_contact_relation text,
  immunizations              text,
  dental_notes               text,
  notes                      text,
  updated_by                 uuid REFERENCES auth.users(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_medical_profiles_family ON medical_profiles(family_id);
CREATE TRIGGER set_medical_profiles_updated BEFORE UPDATE ON medical_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- RLS — everyone in the family can READ; only parents/adults can WRITE.
-- This is what enforces "children view their own info read-only" at the
-- database boundary (can_manage_family => role in parent/adult).
-- ============================================================
DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['health_providers', 'insurance_policies', 'medical_profiles'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);

    EXECUTE format('DROP POLICY IF EXISTS "Members can read %1$s" ON %1$I', tbl);
    EXECUTE format(
      'CREATE POLICY "Members can read %1$s" ON %1$I FOR SELECT TO authenticated USING (is_family_member(family_id))',
      tbl
    );

    EXECUTE format('DROP POLICY IF EXISTS "Managers can insert %1$s" ON %1$I', tbl);
    EXECUTE format(
      'CREATE POLICY "Managers can insert %1$s" ON %1$I FOR INSERT TO authenticated WITH CHECK (can_manage_family(family_id))',
      tbl
    );

    EXECUTE format('DROP POLICY IF EXISTS "Managers can update %1$s" ON %1$I', tbl);
    EXECUTE format(
      'CREATE POLICY "Managers can update %1$s" ON %1$I FOR UPDATE TO authenticated USING (can_manage_family(family_id)) WITH CHECK (can_manage_family(family_id))',
      tbl
    );

    EXECUTE format('DROP POLICY IF EXISTS "Managers can delete %1$s" ON %1$I', tbl);
    EXECUTE format(
      'CREATE POLICY "Managers can delete %1$s" ON %1$I FOR DELETE TO authenticated USING (can_manage_family(family_id))',
      tbl
    );
  END LOOP;
END $$;

-- ============================================================
-- Done! 3 new tables (health_providers, insurance_policies,
-- medical_profiles) + record_kind enum, with indexes, triggers,
-- and read-all / write-managers RLS.
-- ============================================================
