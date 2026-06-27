-- Relationship Helper — track anniversaries, birthdays, and date nights;
-- store partner preferences for AI gift suggestions; and a saved gift-idea list
-- (manual, AI-suggested, or pulled from a partner's wishlist).

-- One preferences row per family (the couple's shared space).
CREATE TABLE IF NOT EXISTS relationship_profile (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         UUID        NOT NULL UNIQUE REFERENCES families(id) ON DELETE CASCADE,
  created_by        UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  partner_name      TEXT,
  partner_member_id UUID        REFERENCES family_members(id) ON DELETE SET NULL,
  interests         TEXT[]      NOT NULL DEFAULT '{}',
  love_languages    TEXT[]      NOT NULL DEFAULT '{}',
  gift_budget_cents INTEGER     CHECK (gift_budget_cents IS NULL OR gift_budget_cents >= 0),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Important dates + planned date nights.
CREATE TABLE IF NOT EXISTS relationship_dates (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id            UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by           UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  kind                 TEXT        NOT NULL DEFAULT 'custom'
                         CHECK (kind IN ('anniversary','birthday','first_date','date_night','milestone','custom')),
  title                TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  event_date           DATE        NOT NULL,
  recurs_annually      BOOLEAN     NOT NULL DEFAULT true,
  reminder_days_before INTEGER     NOT NULL DEFAULT 14 CHECK (reminder_days_before BETWEEN 0 AND 365),
  member_id            UUID        REFERENCES family_members(id) ON DELETE SET NULL,
  partner_name         TEXT,
  location             TEXT,
  notes                TEXT,
  calendar_event_id    UUID        REFERENCES calendar_events(id) ON DELETE SET NULL,
  status               TEXT        NOT NULL DEFAULT 'upcoming'
                         CHECK (status IN ('idea','planned','booked','upcoming','completed','cancelled')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Saved gift ideas.
CREATE TABLE IF NOT EXISTS relationship_gift_ideas (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id        UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  for_member_id    UUID        REFERENCES family_members(id) ON DELETE SET NULL,
  for_name         TEXT,
  title            TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  url              TEXT,
  price_cents      INTEGER     CHECK (price_cents IS NULL OR price_cents >= 0),
  occasion         TEXT,
  reason           TEXT,
  source           TEXT        NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('manual','ai','wishlist')),
  wishlist_item_id UUID        REFERENCES wishlist_items(id) ON DELETE SET NULL,
  status           TEXT        NOT NULL DEFAULT 'idea'
                     CHECK (status IN ('idea','saved','ordered','purchased','given')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS relationship_dates_family_idx     ON relationship_dates(family_id, event_date);
CREATE INDEX IF NOT EXISTS relationship_dates_status_idx     ON relationship_dates(family_id, status);
CREATE INDEX IF NOT EXISTS relationship_gift_ideas_family_idx ON relationship_gift_ideas(family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS relationship_gift_ideas_status_idx ON relationship_gift_ideas(family_id, status);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'relationship_profile_updated_at') THEN
    CREATE TRIGGER relationship_profile_updated_at BEFORE UPDATE ON relationship_profile FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'relationship_dates_updated_at') THEN
    CREATE TRIGGER relationship_dates_updated_at BEFORE UPDATE ON relationship_dates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'relationship_gift_ideas_updated_at') THEN
    CREATE TRIGGER relationship_gift_ideas_updated_at BEFORE UPDATE ON relationship_gift_ideas FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

ALTER TABLE relationship_profile    ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_dates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_gift_ideas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "relationship_profile_family" ON relationship_profile FOR ALL USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = relationship_profile.family_id AND user_id = auth.uid() AND is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = relationship_profile.family_id AND user_id = auth.uid() AND is_active)
);

CREATE POLICY "relationship_dates_family" ON relationship_dates FOR ALL USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = relationship_dates.family_id AND user_id = auth.uid() AND is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = relationship_dates.family_id AND user_id = auth.uid() AND is_active)
);

CREATE POLICY "relationship_gift_ideas_family" ON relationship_gift_ideas FOR ALL USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = relationship_gift_ideas.family_id AND user_id = auth.uid() AND is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = relationship_gift_ideas.family_id AND user_id = auth.uid() AND is_active)
);

ALTER PUBLICATION supabase_realtime ADD TABLE relationship_profile;
ALTER PUBLICATION supabase_realtime ADD TABLE relationship_dates;
ALTER PUBLICATION supabase_realtime ADD TABLE relationship_gift_ideas;
