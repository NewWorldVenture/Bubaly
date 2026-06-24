-- Volunteer Hub — track family volunteer commitments, hours, and organizations

DO $$ BEGIN
  CREATE TYPE volunteer_status AS ENUM (
    'active',
    'upcoming',
    'completed',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE volunteer_category AS ENUM (
    'community',
    'school',
    'church',
    'sports',
    'environment',
    'animal',
    'health',
    'elderly',
    'youth',
    'disaster',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS volunteer_opportunities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES family_members(id) ON DELETE SET NULL,

  title         text NOT NULL DEFAULT '',
  organization  text NOT NULL DEFAULT '',
  category      volunteer_category NOT NULL DEFAULT 'community',
  status        volunteer_status NOT NULL DEFAULT 'upcoming',
  description   text NOT NULL DEFAULT '',
  location      text NOT NULL DEFAULT '',
  contact_name  text NOT NULL DEFAULT '',
  contact_phone text NOT NULL DEFAULT '',
  contact_email text NOT NULL DEFAULT '',

  start_date    date,
  end_date      date,
  recurring     boolean NOT NULL DEFAULT false,
  url           text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT '',

  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_volunteer_opportunities_family
  ON volunteer_opportunities(family_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_volunteer_opportunities_status
  ON volunteer_opportunities(family_id, status) WHERE is_active;

ALTER TABLE volunteer_opportunities ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY volunteer_opportunities_family ON volunteer_opportunities
    FOR ALL USING (is_family_member(family_id))
    WITH CHECK (is_family_member(family_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_volunteer_opportunities_updated_at
    BEFORE UPDATE ON volunteer_opportunities
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Volunteer hours log
CREATE TABLE IF NOT EXISTS volunteer_hours (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  opportunity_id  uuid REFERENCES volunteer_opportunities(id) ON DELETE SET NULL,
  member_id       uuid REFERENCES family_members(id) ON DELETE SET NULL,

  hours           numeric(6,2) NOT NULL DEFAULT 0,
  log_date        date NOT NULL DEFAULT CURRENT_DATE,
  description     text NOT NULL DEFAULT '',
  notes           text NOT NULL DEFAULT '',

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_volunteer_hours_family
  ON volunteer_hours(family_id);
CREATE INDEX IF NOT EXISTS idx_volunteer_hours_opportunity
  ON volunteer_hours(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_volunteer_hours_member
  ON volunteer_hours(member_id);

ALTER TABLE volunteer_hours ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY volunteer_hours_family ON volunteer_hours
    FOR ALL USING (is_family_member(family_id))
    WITH CHECK (is_family_member(family_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_volunteer_hours_updated_at
    BEFORE UPDATE ON volunteer_hours
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
