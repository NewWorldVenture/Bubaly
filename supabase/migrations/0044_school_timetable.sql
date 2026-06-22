-- ============================================================
-- Migration 0044: School timetable — alternating-week support
-- Bubaly already stores recurring classes (school_classes: subject, teacher,
-- room, time_slot, day_of_week). FamilyWall additionally offers "alternating
-- week" timetables (A/B weeks). This adds a week_pattern so a class can repeat
-- every week, only on A weeks, or only on B weeks — powering the new visual
-- weekly timetable grid.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE week_pattern AS ENUM ('all', 'a', 'b');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.school_classes
  ADD COLUMN IF NOT EXISTS week_pattern week_pattern NOT NULL DEFAULT 'all';
