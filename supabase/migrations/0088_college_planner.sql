-- College & Scholarship Planner — track applications, scholarships, deadlines

DO $$ BEGIN
  CREATE TYPE college_app_status AS ENUM (
    'researching',
    'applying',
    'submitted',
    'accepted',
    'waitlisted',
    'rejected',
    'enrolled',
    'declined'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE scholarship_status AS ENUM (
    'researching',
    'applying',
    'submitted',
    'awarded',
    'denied',
    'accepted',
    'declined'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS college_applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id     uuid REFERENCES family_members(id) ON DELETE SET NULL,
  created_by    uuid REFERENCES family_members(id) ON DELETE SET NULL,

  school_name   text NOT NULL DEFAULT '',
  location      text NOT NULL DEFAULT '',
  program       text NOT NULL DEFAULT '',
  status        college_app_status NOT NULL DEFAULT 'researching',
  deadline      date,
  decision_date date,
  tuition       numeric(12,2),
  financial_aid numeric(12,2),
  notes         text NOT NULL DEFAULT '',
  url           text NOT NULL DEFAULT '',

  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_college_applications_family
  ON college_applications(family_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_college_applications_member
  ON college_applications(member_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_college_applications_deadline
  ON college_applications(deadline) WHERE is_active AND deadline IS NOT NULL;

ALTER TABLE college_applications ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY college_applications_family ON college_applications
    FOR ALL USING (is_family_member(family_id))
    WITH CHECK (is_family_member(family_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_college_applications_updated_at
    BEFORE UPDATE ON college_applications
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Scholarships
CREATE TABLE IF NOT EXISTS scholarships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id     uuid REFERENCES family_members(id) ON DELETE SET NULL,
  created_by    uuid REFERENCES family_members(id) ON DELETE SET NULL,

  name          text NOT NULL DEFAULT '',
  provider      text NOT NULL DEFAULT '',
  amount        numeric(12,2),
  status        scholarship_status NOT NULL DEFAULT 'researching',
  deadline      date,
  renewable     boolean NOT NULL DEFAULT false,
  requirements  text NOT NULL DEFAULT '',
  url           text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT '',

  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scholarships_family
  ON scholarships(family_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_scholarships_member
  ON scholarships(member_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_scholarships_deadline
  ON scholarships(deadline) WHERE is_active AND deadline IS NOT NULL;

ALTER TABLE scholarships ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY scholarships_family ON scholarships
    FOR ALL USING (is_family_member(family_id))
    WITH CHECK (is_family_member(family_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_scholarships_updated_at
    BEFORE UPDATE ON scholarships
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
