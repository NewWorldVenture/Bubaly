-- Trip Intelligence — AI destination research + Smart Departure planning.
--
-- trip_plans:      a researched destination (restaurants/activities/tips) tied
--                  to an optional calendar event or vacation, scoped to a date
--                  range and the members going. AI recommendations cached as JSON.
-- departure_plans: a "when do we leave?" plan for one located calendar event.
--                  Stores the inputs (prep/park buffers, origin/destination) and
--                  the computed leave_by, plus the latest live snapshot (drive
--                  time, traffic factor, weather) and the linked "Head out"
--                  calendar event so we can keep it in sync.

CREATE TABLE IF NOT EXISTS trip_plans (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  event_id        UUID        REFERENCES calendar_events(id) ON DELETE SET NULL,
  title           TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  destination     TEXT        NOT NULL CHECK (char_length(destination) BETWEEN 1 AND 200),
  dest_lat        DOUBLE PRECISION,
  dest_lng        DOUBLE PRECISION,
  start_date      DATE,
  end_date        DATE,
  members         JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- member display names going
  interests       TEXT,                                       -- free-text "what we like"
  recommendations JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- { restaurants:[], activities:[], tips:[] }
  weather_summary TEXT,
  status          TEXT        NOT NULL DEFAULT 'researched'
                    CHECK (status IN ('researched','planning','booked','completed','archived')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS departure_plans (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id            UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by           UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  event_id             UUID        REFERENCES calendar_events(id) ON DELETE CASCADE,
  reminder_event_id    UUID        REFERENCES calendar_events(id) ON DELETE SET NULL,
  title                TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  origin               TEXT,
  origin_lat           DOUBLE PRECISION,
  origin_lng           DOUBLE PRECISION,
  destination          TEXT,
  dest_lat             DOUBLE PRECISION,
  dest_lng             DOUBLE PRECISION,
  event_start          TIMESTAMPTZ NOT NULL,
  prep_minutes         INTEGER     NOT NULL DEFAULT 30 CHECK (prep_minutes BETWEEN 0 AND 240),
  park_minutes         INTEGER     NOT NULL DEFAULT 10 CHECK (park_minutes BETWEEN 0 AND 120),
  buffer_minutes       INTEGER     NOT NULL DEFAULT 5  CHECK (buffer_minutes BETWEEN 0 AND 120),
  drive_seconds        INTEGER     NOT NULL DEFAULT 0  CHECK (drive_seconds >= 0),
  traffic_factor       DOUBLE PRECISION NOT NULL DEFAULT 1,
  weather_delay_minutes INTEGER    NOT NULL DEFAULT 0  CHECK (weather_delay_minutes >= 0),
  weather_summary      TEXT,
  leave_by             TIMESTAMPTZ,
  last_checked_at      TIMESTAMPTZ,
  status               TEXT        NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','done','cancelled')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trip_plans_family_idx      ON trip_plans(family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trip_plans_event_idx       ON trip_plans(event_id);
CREATE INDEX IF NOT EXISTS departure_plans_family_idx ON departure_plans(family_id, event_start);
CREATE INDEX IF NOT EXISTS departure_plans_event_idx  ON departure_plans(event_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trip_plans_updated_at') THEN
    CREATE TRIGGER trip_plans_updated_at BEFORE UPDATE ON trip_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'departure_plans_updated_at') THEN
    CREATE TRIGGER departure_plans_updated_at BEFORE UPDATE ON departure_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

ALTER TABLE trip_plans      ENABLE ROW LEVEL SECURITY;
ALTER TABLE departure_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "trip_plans_family" ON trip_plans FOR ALL USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = trip_plans.family_id AND user_id = auth.uid() AND is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = trip_plans.family_id AND user_id = auth.uid() AND is_active)
);

CREATE POLICY "departure_plans_family" ON departure_plans FOR ALL USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = departure_plans.family_id AND user_id = auth.uid() AND is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = departure_plans.family_id AND user_id = auth.uid() AND is_active)
);

ALTER PUBLICATION supabase_realtime ADD TABLE trip_plans;
ALTER PUBLICATION supabase_realtime ADD TABLE departure_plans;
