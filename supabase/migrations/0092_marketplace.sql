-- Family Marketplace — classifieds board for sell/trade/free/wanted items

DO $$ BEGIN
  CREATE TYPE listing_type AS ENUM (
    'sell',
    'trade',
    'free',
    'wanted'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE listing_status AS ENUM (
    'active',
    'sold',
    'traded',
    'withdrawn'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE item_condition AS ENUM (
    'new',
    'like_new',
    'good',
    'fair',
    'poor'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS marketplace_listings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by      uuid REFERENCES family_members(id) ON DELETE SET NULL,

  title           text NOT NULL DEFAULT '',
  description     text NOT NULL DEFAULT '',
  category        text NOT NULL DEFAULT 'Other',
  condition       item_condition NOT NULL DEFAULT 'good',
  listing_type    listing_type NOT NULL DEFAULT 'sell',
  status          listing_status NOT NULL DEFAULT 'active',
  price           numeric(10,2),
  location        text NOT NULL DEFAULT '',
  photo_path      text,
  notes           text NOT NULL DEFAULT '',

  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_family
  ON marketplace_listings(family_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_status
  ON marketplace_listings(family_id, status) WHERE is_active;

ALTER TABLE marketplace_listings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY marketplace_listings_family ON marketplace_listings
    FOR ALL USING (is_family_member(family_id))
    WITH CHECK (is_family_member(family_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_marketplace_listings_updated_at
    BEFORE UPDATE ON marketplace_listings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
