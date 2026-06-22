-- ============================================================
-- Migration 0046: Family Announcements (broadcast board)
-- Parents broadcast updates ("Grandma visits Saturday", "Early dismissal
-- Friday") to the whole family. Members see them on a board and can mark them
-- read, so the poster gets simple read receipts. A Free-tier differentiator —
-- Cozi/FamilyWall have no real broadcast surface.
--
-- Posting is restricted to family admins in the app layer; RLS keeps everything
-- family-scoped. Reads are tracked per member.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.family_announcements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id        uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  author_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  author_member_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  title            text NOT NULL,
  body             text,
  is_pinned        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_announcements_family ON public.family_announcements(family_id, is_pinned DESC, created_at DESC);

DROP TRIGGER IF EXISTS trg_announcements_updated_at ON public.family_announcements;
CREATE TRIGGER trg_announcements_updated_at BEFORE UPDATE ON public.family_announcements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.family_announcements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage announcements" ON public.family_announcements;
CREATE POLICY "Members can manage announcements" ON public.family_announcements
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

CREATE TABLE IF NOT EXISTS public.announcement_reads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id uuid NOT NULL REFERENCES public.family_announcements(id) ON DELETE CASCADE,
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id       uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT announcement_reads_once UNIQUE (announcement_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_announcement_reads_ann ON public.announcement_reads(announcement_id);

ALTER TABLE public.announcement_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage announcement_reads" ON public.announcement_reads;
CREATE POLICY "Members can manage announcement_reads" ON public.announcement_reads
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

-- ============================================================
-- Done! Families have a broadcast board with read receipts.
-- ============================================================
