-- Reminder details — bring family reminders to parity with best-in-class apps:
-- named lists, a URL, an early (lead-time) reminder, a flag, subtasks, and an
-- image attachment.

CREATE TABLE IF NOT EXISTS reminder_lists (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  name        TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  color       TEXT        NOT NULL DEFAULT 'brand',
  icon        TEXT        NOT NULL DEFAULT 'list',
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE family_reminders
  ADD COLUMN IF NOT EXISTS url                    TEXT,
  ADD COLUMN IF NOT EXISTS flagged                BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS early_reminder_minutes INTEGER CHECK (early_reminder_minutes IS NULL OR early_reminder_minutes >= 0),
  ADD COLUMN IF NOT EXISTS image_url              TEXT,
  ADD COLUMN IF NOT EXISTS subtasks               JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS list_id                UUID REFERENCES reminder_lists(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS reminder_lists_family_idx ON reminder_lists(family_id, sort_order);
CREATE INDEX IF NOT EXISTS family_reminders_list_idx ON family_reminders(list_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'reminder_lists_updated_at') THEN
    CREATE TRIGGER reminder_lists_updated_at BEFORE UPDATE ON reminder_lists FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

ALTER TABLE reminder_lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY "reminder_lists_family" ON reminder_lists FOR ALL USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = reminder_lists.family_id AND user_id = auth.uid() AND is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = reminder_lists.family_id AND user_id = auth.uid() AND is_active)
);

ALTER PUBLICATION supabase_realtime ADD TABLE reminder_lists;
