-- AI Front Desk — Call Guardian (screening) + Receptionist (answering).
-- Tables: front_desk_settings (per-family config) + call_logs (call history).

-- ─── Front Desk Settings ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS front_desk_settings (
  family_id        UUID        PRIMARY KEY REFERENCES families(id) ON DELETE CASCADE,
  enabled          BOOLEAN     NOT NULL DEFAULT false,
  greeting         TEXT        NOT NULL DEFAULT 'Hi! You''ve reached the family. I''m their AI assistant — how can I help?'
                     CHECK (char_length(greeting) <= 1000),
  screening_mode   TEXT        NOT NULL DEFAULT 'smart'
                     CHECK (screening_mode IN ('off','smart','strict','allowlist')),
  voicemail_enabled BOOLEAN    NOT NULL DEFAULT true,
  forward_number   TEXT        CHECK (char_length(forward_number) <= 30),
  quiet_hours_start SMALLINT   CHECK (quiet_hours_start BETWEEN 0 AND 23),
  quiet_hours_end   SMALLINT   CHECK (quiet_hours_end BETWEEN 0 AND 23),
  block_spam       BOOLEAN     NOT NULL DEFAULT true,
  block_unknown    BOOLEAN     NOT NULL DEFAULT false,
  blocked_numbers  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  allowed_numbers  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Call Logs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS call_logs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  contact_id    UUID        REFERENCES family_contacts(id) ON DELETE SET NULL,
  caller_name   TEXT        CHECK (char_length(caller_name) <= 120),
  caller_number TEXT        CHECK (char_length(caller_number) <= 30),
  direction     TEXT        NOT NULL DEFAULT 'inbound'
                  CHECK (direction IN ('inbound','outbound')),
  status        TEXT        NOT NULL DEFAULT 'screened'
                  CHECK (status IN ('screened','answered','voicemail','blocked','missed','forwarded')),
  classification TEXT       NOT NULL DEFAULT 'unknown'
                  CHECK (classification IN ('important','known','unknown','spam','robocall','telemarketer')),
  priority      TEXT        NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('low','normal','high','urgent')),
  transcript    TEXT        CHECK (char_length(transcript) <= 20000),
  ai_summary    TEXT        CHECK (char_length(ai_summary) <= 2000),
  action_items  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  voicemail_url TEXT        CHECK (char_length(voicemail_url) <= 500),
  duration_secs INTEGER     CHECK (duration_secs >= 0),
  is_read       BOOLEAN     NOT NULL DEFAULT false,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_logs_family_idx     ON call_logs(family_id, received_at DESC);
CREATE INDEX IF NOT EXISTS call_logs_status_idx     ON call_logs(family_id, status);
CREATE INDEX IF NOT EXISTS call_logs_class_idx      ON call_logs(family_id, classification);
CREATE INDEX IF NOT EXISTS call_logs_unread_idx     ON call_logs(family_id, is_read) WHERE is_read = false;
CREATE INDEX IF NOT EXISTS call_logs_contact_idx    ON call_logs(contact_id) WHERE contact_id IS NOT NULL;

-- ─── Triggers ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'front_desk_settings_updated_at') THEN
    CREATE TRIGGER front_desk_settings_updated_at BEFORE UPDATE ON front_desk_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'call_logs_updated_at') THEN
    CREATE TRIGGER call_logs_updated_at BEFORE UPDATE ON call_logs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ─── RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE front_desk_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_logs           ENABLE ROW LEVEL SECURITY;

-- Settings: any active member can read; only owner/admin can write.
CREATE POLICY "front_desk_select" ON front_desk_settings FOR SELECT USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = front_desk_settings.family_id AND user_id = auth.uid() AND is_active)
);
CREATE POLICY "front_desk_insert" ON front_desk_settings FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM family_members fm WHERE fm.family_id = front_desk_settings.family_id AND fm.user_id = auth.uid() AND fm.role IN ('owner','admin') AND fm.is_active)
);
CREATE POLICY "front_desk_update" ON front_desk_settings FOR UPDATE USING (
  EXISTS (SELECT 1 FROM family_members fm WHERE fm.family_id = front_desk_settings.family_id AND fm.user_id = auth.uid() AND fm.role IN ('owner','admin') AND fm.is_active)
);

-- Call logs: any active member can read/write their family's calls.
CREATE POLICY "call_logs_select" ON call_logs FOR SELECT USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = call_logs.family_id AND user_id = auth.uid() AND is_active)
);
CREATE POLICY "call_logs_insert" ON call_logs FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = call_logs.family_id AND user_id = auth.uid() AND is_active)
);
CREATE POLICY "call_logs_update" ON call_logs FOR UPDATE USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = call_logs.family_id AND user_id = auth.uid() AND is_active)
);
CREATE POLICY "call_logs_delete" ON call_logs FOR DELETE USING (
  EXISTS (SELECT 1 FROM family_members fm WHERE fm.family_id = call_logs.family_id AND fm.user_id = auth.uid() AND fm.role IN ('owner','admin') AND fm.is_active)
);

-- ─── Realtime ──────────────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE front_desk_settings;
ALTER PUBLICATION supabase_realtime ADD TABLE call_logs;
