-- Family Yearbook — annual family memory collections

CREATE TABLE IF NOT EXISTS family_yearbooks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES family_members(id) ON DELETE SET NULL,

  title         text NOT NULL DEFAULT '',
  year          integer NOT NULL DEFAULT EXTRACT(YEAR FROM CURRENT_DATE),
  description   text NOT NULL DEFAULT '',
  cover_photo   text NOT NULL DEFAULT '',
  is_published  boolean NOT NULL DEFAULT false,
  notes         text NOT NULL DEFAULT '',

  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_family_yearbooks_family
  ON family_yearbooks(family_id) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_family_yearbooks_year
  ON family_yearbooks(family_id, year) WHERE is_active;

ALTER TABLE family_yearbooks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY family_yearbooks_family ON family_yearbooks
    FOR ALL USING (is_family_member(family_id))
    WITH CHECK (is_family_member(family_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_family_yearbooks_updated_at
    BEFORE UPDATE ON family_yearbooks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Yearbook entries (memories/highlights per yearbook)
CREATE TABLE IF NOT EXISTS yearbook_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  yearbook_id   uuid NOT NULL REFERENCES family_yearbooks(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES family_members(id) ON DELETE SET NULL,

  title         text NOT NULL DEFAULT '',
  description   text NOT NULL DEFAULT '',
  entry_date    date,
  photo_path    text NOT NULL DEFAULT '',
  category      text NOT NULL DEFAULT '',
  member_id     uuid REFERENCES family_members(id) ON DELETE SET NULL,
  sort_order    integer NOT NULL DEFAULT 0,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_yearbook_entries_yearbook
  ON yearbook_entries(yearbook_id);
CREATE INDEX IF NOT EXISTS idx_yearbook_entries_family
  ON yearbook_entries(family_id);

ALTER TABLE yearbook_entries ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY yearbook_entries_family ON yearbook_entries
    FOR ALL USING (is_family_member(family_id))
    WITH CHECK (is_family_member(family_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_yearbook_entries_updated_at
    BEFORE UPDATE ON yearbook_entries
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
