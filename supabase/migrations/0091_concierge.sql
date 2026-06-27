-- AI Concierge — stores conversation sessions and saved plans.

CREATE TABLE IF NOT EXISTS concierge_sessions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  title       TEXT        NOT NULL DEFAULT 'New Request',
  kind        TEXT        NOT NULL DEFAULT 'general'
                CHECK (kind IN ('getaway','restaurant','date_night','activity','party','travel','shopping','service','general')),
  status      TEXT        NOT NULL DEFAULT 'planning'
                CHECK (status IN ('planning','booked','confirmed','completed','cancelled')),
  notes       TEXT,
  ai_summary  TEXT,
  messages    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS concierge_plans (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  session_id    UUID        REFERENCES concierge_sessions(id) ON DELETE SET NULL,
  created_by    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  title         TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  kind          TEXT        NOT NULL DEFAULT 'general'
                  CHECK (kind IN ('getaway','restaurant','date_night','activity','party','travel','shopping','service','general')),
  description   TEXT,
  ai_suggestion TEXT,
  status        TEXT        NOT NULL DEFAULT 'idea'
                  CHECK (status IN ('idea','planning','booked','confirmed','completed','cancelled')),
  planned_for   DATE,
  budget_cents  INTEGER     CHECK (budget_cents >= 0),
  location      TEXT,
  members       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  links         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS concierge_sessions_family_idx ON concierge_sessions(family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS concierge_plans_family_idx    ON concierge_plans(family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS concierge_plans_kind_idx      ON concierge_plans(family_id, kind);
CREATE INDEX IF NOT EXISTS concierge_plans_status_idx    ON concierge_plans(family_id, status);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'concierge_sessions_updated_at') THEN
    CREATE TRIGGER concierge_sessions_updated_at BEFORE UPDATE ON concierge_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'concierge_plans_updated_at') THEN
    CREATE TRIGGER concierge_plans_updated_at BEFORE UPDATE ON concierge_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

ALTER TABLE concierge_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE concierge_plans    ENABLE ROW LEVEL SECURITY;

CREATE POLICY "concierge_sessions_family" ON concierge_sessions FOR ALL USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = concierge_sessions.family_id AND user_id = auth.uid() AND is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = concierge_sessions.family_id AND user_id = auth.uid() AND is_active)
);

CREATE POLICY "concierge_plans_family" ON concierge_plans FOR ALL USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = concierge_plans.family_id AND user_id = auth.uid() AND is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = concierge_plans.family_id AND user_id = auth.uid() AND is_active)
);

ALTER PUBLICATION supabase_realtime ADD TABLE concierge_sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE concierge_plans;
