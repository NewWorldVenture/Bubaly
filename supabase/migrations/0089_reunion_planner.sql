-- Family Reunion Planner — organize family reunions and gatherings

DO $$ BEGIN
  CREATE TYPE reunion_status AS ENUM (
    'planning',
    'confirmed',
    'active',
    'completed',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE rsvp_response AS ENUM (
    'attending',
    'not_attending',
    'maybe',
    'pending'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS family_reunions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES family_members(id) ON DELETE SET NULL,

  title         text NOT NULL DEFAULT '',
  description   text NOT NULL DEFAULT '',
  location      text NOT NULL DEFAULT '',
  venue         text NOT NULL DEFAULT '',
  status        reunion_status NOT NULL DEFAULT 'planning',
  start_date    date,
  end_date      date,
  budget        numeric(12,2),
  headcount     integer NOT NULL DEFAULT 0,
  contact_name  text NOT NULL DEFAULT '',
  contact_phone text NOT NULL DEFAULT '',
  contact_email text NOT NULL DEFAULT '',
  theme         text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT '',

  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_family_reunions_family
  ON family_reunions(family_id) WHERE is_active;

ALTER TABLE family_reunions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY family_reunions_family ON family_reunions
    FOR ALL USING (is_family_member(family_id))
    WITH CHECK (is_family_member(family_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_family_reunions_updated_at
    BEFORE UPDATE ON family_reunions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reunion RSVPs
CREATE TABLE IF NOT EXISTS reunion_rsvps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  reunion_id    uuid NOT NULL REFERENCES family_reunions(id) ON DELETE CASCADE,
  guest_name    text NOT NULL DEFAULT '',
  guest_email   text NOT NULL DEFAULT '',
  response      rsvp_response NOT NULL DEFAULT 'pending',
  party_size    integer NOT NULL DEFAULT 1,
  dietary_notes text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT '',

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reunion_rsvps_reunion
  ON reunion_rsvps(reunion_id);
CREATE INDEX IF NOT EXISTS idx_reunion_rsvps_family
  ON reunion_rsvps(family_id);

ALTER TABLE reunion_rsvps ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY reunion_rsvps_family ON reunion_rsvps
    FOR ALL USING (is_family_member(family_id))
    WITH CHECK (is_family_member(family_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_reunion_rsvps_updated_at
    BEFORE UPDATE ON reunion_rsvps
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
