-- ============================================================================
-- Migration 0239: avoid regenerating already-populated marketing backfills
--
-- The canonical page backfill inserts pages with a source marker and
-- updated_by = null. Migration 0237's insert trigger predates that backfill and
-- queued a full regeneration for every inserted page, even when the page
-- already had source content and SEO data. That can bury the useful question
-- and embedding jobs behind thousands of unnecessary rewrites.
--
-- Admin-created pages still set updated_by and continue to enqueue automatic
-- regeneration. Every later admin edit remains covered by the update trigger.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enqueue_marketing_page_generation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- The backfill has already copied source material into the canonical row.
  -- Do not create a rewrite job for that bootstrap insert.
  IF TG_OP = 'INSERT'
     AND NEW.updated_by IS NULL
     AND NEW.content ? 'source' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.marketing_generation_jobs
    (job_type, target_type, target_id, target_path, idempotency_key, payload, created_by)
  VALUES
    ('regenerate_page', 'marketing_page', NEW.id, NEW.path,
     format('marketing-page:%s:v:%s', NEW.id, NEW.version),
     jsonb_build_object('page_id', NEW.id, 'path', NEW.path, 'version', NEW.version), NEW.updated_by)
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Remove only jobs created by the insert trigger immediately alongside a
-- source-marked published backfill row. Manual/admin-created jobs are kept.
DELETE FROM public.marketing_generation_jobs AS job
USING public.marketing_pages AS page
WHERE job.job_type = 'regenerate_page'
  AND job.status = 'queued'
  AND job.created_by IS NULL
  AND job.target_id = page.id
  AND page.status = 'published'
  AND page.deleted_at IS NULL
  AND page.content ? 'source'
  AND job.created_at <= page.created_at + interval '5 minutes';

