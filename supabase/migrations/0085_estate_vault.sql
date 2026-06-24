-- Estate & Legacy Vault — family estate-planning document registry
-- Tracks wills, trusts, POAs, advance directives, beneficiary designations,
-- digital-account legacy plans, and important contacts.

-- Document type enum
DO $$ BEGIN
  CREATE TYPE estate_document_type AS ENUM (
    'will',
    'trust',
    'power_of_attorney',
    'advance_directive',
    'beneficiary_designation',
    'insurance_policy',
    'deed',
    'title',
    'digital_account',
    'letter_of_intent',
    'funeral_wishes',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Review status enum
DO $$ BEGIN
  CREATE TYPE estate_review_status AS ENUM (
    'current',
    'needs_review',
    'expired',
    'draft'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS estate_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES family_members(id) ON DELETE SET NULL,

  -- Core fields
  document_type estate_document_type NOT NULL DEFAULT 'other',
  title         text NOT NULL DEFAULT '',
  description   text NOT NULL DEFAULT '',
  holder_name   text NOT NULL DEFAULT '',

  -- Status & review
  review_status estate_review_status NOT NULL DEFAULT 'current',
  effective_date  date,
  expiration_date date,
  last_reviewed   date,
  next_review     date,

  -- Contacts
  attorney_name  text NOT NULL DEFAULT '',
  attorney_phone text NOT NULL DEFAULT '',
  attorney_email text NOT NULL DEFAULT '',

  -- Storage
  document_path text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT '',

  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_estate_documents_family
  ON estate_documents(family_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_estate_documents_type
  ON estate_documents(family_id, document_type) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_estate_documents_review
  ON estate_documents(next_review) WHERE is_active AND next_review IS NOT NULL;

-- RLS
ALTER TABLE estate_documents ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY estate_documents_family ON estate_documents
    FOR ALL USING (is_family_member(family_id))
    WITH CHECK (is_family_member(family_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Updated-at trigger
DO $$ BEGIN
  CREATE TRIGGER set_estate_documents_updated_at
    BEFORE UPDATE ON estate_documents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Digital accounts sub-table for legacy access planning
CREATE TABLE IF NOT EXISTS estate_digital_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES family_members(id) ON DELETE SET NULL,

  account_name  text NOT NULL DEFAULT '',
  provider      text NOT NULL DEFAULT '',
  account_type  text NOT NULL DEFAULT '',
  username      text NOT NULL DEFAULT '',
  legacy_contact_name  text NOT NULL DEFAULT '',
  legacy_contact_email text NOT NULL DEFAULT '',
  instructions  text NOT NULL DEFAULT '',
  has_2fa       boolean NOT NULL DEFAULT false,
  notes         text NOT NULL DEFAULT '',

  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_estate_digital_accounts_family
  ON estate_digital_accounts(family_id) WHERE is_active;

ALTER TABLE estate_digital_accounts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY estate_digital_accounts_family ON estate_digital_accounts
    FOR ALL USING (is_family_member(family_id))
    WITH CHECK (is_family_member(family_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_estate_digital_accounts_updated_at
    BEFORE UPDATE ON estate_digital_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
