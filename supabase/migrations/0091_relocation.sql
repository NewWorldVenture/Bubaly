-- Relocation Guide — family moving/relocation task tracker

DO $$ BEGIN
  CREATE TYPE relocation_status AS ENUM (
    'researching',
    'planning',
    'in_progress',
    'completed',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE relocation_task_status AS ENUM (
    'todo',
    'in_progress',
    'done',
    'skipped'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS family_relocations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by      uuid REFERENCES family_members(id) ON DELETE SET NULL,

  title           text NOT NULL DEFAULT '',
  from_location   text NOT NULL DEFAULT '',
  to_location     text NOT NULL DEFAULT '',
  status          relocation_status NOT NULL DEFAULT 'researching',
  target_date     date,
  budget          numeric(12,2),
  reason          text NOT NULL DEFAULT '',
  notes           text NOT NULL DEFAULT '',

  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_family_relocations_family
  ON family_relocations(family_id) WHERE is_active;

ALTER TABLE family_relocations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY family_relocations_family ON family_relocations
    FOR ALL USING (is_family_member(family_id))
    WITH CHECK (is_family_member(family_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_family_relocations_updated_at
    BEFORE UPDATE ON family_relocations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Relocation tasks / checklist items
CREATE TABLE IF NOT EXISTS relocation_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  relocation_id   uuid NOT NULL REFERENCES family_relocations(id) ON DELETE CASCADE,
  created_by      uuid REFERENCES family_members(id) ON DELETE SET NULL,

  title           text NOT NULL DEFAULT '',
  category        text NOT NULL DEFAULT '',
  status          relocation_task_status NOT NULL DEFAULT 'todo',
  due_date        date,
  assigned_to     uuid REFERENCES family_members(id) ON DELETE SET NULL,
  sort_order      integer NOT NULL DEFAULT 0,
  notes           text NOT NULL DEFAULT '',

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_relocation_tasks_relocation
  ON relocation_tasks(relocation_id);
CREATE INDEX IF NOT EXISTS idx_relocation_tasks_family
  ON relocation_tasks(family_id);

ALTER TABLE relocation_tasks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY relocation_tasks_family ON relocation_tasks
    FOR ALL USING (is_family_member(family_id))
    WITH CHECK (is_family_member(family_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_relocation_tasks_updated_at
    BEFORE UPDATE ON relocation_tasks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
