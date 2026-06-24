-- Donation Tracker — family charitable giving ledger

DO $$ BEGIN
  CREATE TYPE donation_type AS ENUM (
    'monetary',
    'goods',
    'stock',
    'vehicle',
    'real_estate',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS family_donations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by      uuid REFERENCES family_members(id) ON DELETE SET NULL,

  organization    text NOT NULL DEFAULT '',
  donation_type   donation_type NOT NULL DEFAULT 'monetary',
  amount          numeric(12,2),
  description     text NOT NULL DEFAULT '',
  donation_date   date NOT NULL DEFAULT CURRENT_DATE,
  tax_year        integer NOT NULL DEFAULT EXTRACT(YEAR FROM CURRENT_DATE),
  is_tax_deductible boolean NOT NULL DEFAULT true,
  receipt_path    text NOT NULL DEFAULT '',
  ein             text NOT NULL DEFAULT '',
  category        text NOT NULL DEFAULT '',
  notes           text NOT NULL DEFAULT '',

  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_family_donations_family
  ON family_donations(family_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_family_donations_year
  ON family_donations(family_id, tax_year) WHERE is_active;

ALTER TABLE family_donations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY family_donations_family ON family_donations
    FOR ALL USING (is_family_member(family_id))
    WITH CHECK (is_family_member(family_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_family_donations_updated_at
    BEFORE UPDATE ON family_donations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
