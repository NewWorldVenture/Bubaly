-- AI Family Communications Hub
-- Adds family_communications message log; family_contacts already exists (0014).

-- ─── Family Communications ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS family_communications (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  contact_id    UUID        REFERENCES family_contacts(id) ON DELETE SET NULL,
  thread_id     UUID        REFERENCES family_communications(id) ON DELETE SET NULL,
  channel       TEXT        NOT NULL DEFAULT 'other'
                  CHECK (channel IN ('call','sms','email','whatsapp','instagram','school','sports','note','other')),
  direction     TEXT        NOT NULL DEFAULT 'inbound'
                  CHECK (direction IN ('inbound','outbound')),
  subject       TEXT        CHECK (char_length(subject) <= 300),
  body          TEXT        CHECK (char_length(body) <= 10000),
  summary       TEXT        CHECK (char_length(summary) <= 2000),
  action_items  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  category      TEXT        NOT NULL DEFAULT 'general'
                  CHECK (category IN ('general','school','medical','sports','social','emergency','financial','legal','other')),
  status        TEXT        NOT NULL DEFAULT 'unread'
                  CHECK (status IN ('unread','read','replied','archived','snoozed')),
  priority      TEXT        NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('low','normal','high','urgent')),
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS family_comms_family_idx    ON family_communications(family_id, received_at DESC);
CREATE INDEX IF NOT EXISTS family_comms_status_idx    ON family_communications(family_id, status);
CREATE INDEX IF NOT EXISTS family_comms_channel_idx   ON family_communications(family_id, channel);
CREATE INDEX IF NOT EXISTS family_comms_category_idx  ON family_communications(family_id, category);
CREATE INDEX IF NOT EXISTS family_comms_contact_idx   ON family_communications(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS family_comms_thread_idx    ON family_communications(thread_id)  WHERE thread_id  IS NOT NULL;

-- ─── Auto-updated_at trigger ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'family_communications_updated_at') THEN
    CREATE TRIGGER family_communications_updated_at
      BEFORE UPDATE ON family_communications
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ─── RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE family_communications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "comms_family_select" ON family_communications
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM family_members WHERE family_id = family_communications.family_id AND user_id = auth.uid() AND is_active)
  );

CREATE POLICY "comms_family_insert" ON family_communications
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM family_members WHERE family_id = family_communications.family_id AND user_id = auth.uid() AND is_active)
  );

CREATE POLICY "comms_family_update" ON family_communications
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM family_members WHERE family_id = family_communications.family_id AND user_id = auth.uid() AND is_active)
  );

CREATE POLICY "comms_family_delete" ON family_communications
  FOR DELETE USING (
    public.can_manage_family(family_communications.family_id)
  );

-- ─── Realtime ─────────────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE family_communications;
