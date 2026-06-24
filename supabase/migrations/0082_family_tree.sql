-- 0082 Family Tree — genealogy / relationship hierarchy.
-- Each node represents a person in the family tree. Nodes can link to a
-- family_member but also represent ancestors who aren't active members.

CREATE TABLE IF NOT EXISTS family_tree_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  parent_node_id uuid REFERENCES family_tree_nodes(id) ON DELETE SET NULL,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  name text NOT NULL,
  relationship text NOT NULL DEFAULT 'other',
  birth_year int,
  death_year int,
  birth_place text,
  photo_url text,
  bio text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_family_tree_nodes_family ON family_tree_nodes(family_id);
CREATE INDEX IF NOT EXISTS idx_family_tree_nodes_parent ON family_tree_nodes(parent_node_id);
CREATE INDEX IF NOT EXISTS idx_family_tree_nodes_member ON family_tree_nodes(member_id);

ALTER TABLE family_tree_nodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY family_tree_nodes_select ON family_tree_nodes FOR SELECT
  USING (family_id IN (SELECT family_id FROM family_members WHERE user_id = auth.uid()));
CREATE POLICY family_tree_nodes_insert ON family_tree_nodes FOR INSERT
  WITH CHECK (family_id IN (SELECT family_id FROM family_members WHERE user_id = auth.uid()));
CREATE POLICY family_tree_nodes_update ON family_tree_nodes FOR UPDATE
  USING (family_id IN (SELECT family_id FROM family_members WHERE user_id = auth.uid()));
CREATE POLICY family_tree_nodes_delete ON family_tree_nodes FOR DELETE
  USING (family_id IN (SELECT family_id FROM family_members WHERE user_id = auth.uid()));

CREATE TRIGGER set_family_tree_nodes_updated_at
  BEFORE UPDATE ON family_tree_nodes
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- Video sharing: add media_type to family_photos so images and videos live together.
ALTER TABLE family_photos ADD COLUMN IF NOT EXISTS media_type text NOT NULL DEFAULT 'image';
ALTER TABLE family_photos ADD COLUMN IF NOT EXISTS duration_seconds int;
