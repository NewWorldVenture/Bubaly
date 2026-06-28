-- ============================================================
-- One-off: set subscription tiers for three accounts + ensure
-- ONLY daniel.hughen@gmail.com is a site Super Admin.
--
-- Run in the Supabase SQL editor (or psql) for the PROD project.
-- Idempotent: safe to re-run. Skips (with a NOTICE) any email that
-- has no auth user / no family yet.
--
--   Newworldventurellc@gmail.com  -> Parent · Free  (plan 'free')
--   Blackstoneagencyllc@gmail.com -> Parent · Basic (plan 'basic')
--   SurgeServicesllc@gmail.com    -> Parent · Plus  (plan 'plus')
-- ============================================================

-- 1) Tiers + ensure they are an active parent of their family ----------------
DO $$
DECLARE
  rec     record;
  v_uid   uuid;
  v_family uuid;
  v_sub   uuid;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('newworldventurellc@gmail.com', 'free'),
      ('blackstoneagencyllc@gmail.com',  'basic'),
      ('surgeservicesllc@gmail.com', 'plus')
    ) AS t(email, plan)
  LOOP
    SELECT id INTO v_uid FROM auth.users WHERE lower(email) = lower(rec.email) LIMIT 1;
    IF v_uid IS NULL THEN
      RAISE NOTICE 'No auth user for % — skipped', rec.email;
      CONTINUE;
    END IF;

    -- Target family: their active family, else one they created, else any
    -- active membership.
    v_family := NULL;
    SELECT up.active_family_id INTO v_family
      FROM public.user_preferences up WHERE up.user_id = v_uid;
    IF v_family IS NULL THEN
      SELECT id INTO v_family FROM public.families
        WHERE created_by = v_uid ORDER BY created_at LIMIT 1;
    END IF;
    IF v_family IS NULL THEN
      SELECT family_id INTO v_family FROM public.family_members
        WHERE user_id = v_uid AND is_active ORDER BY created_at LIMIT 1;
    END IF;
    IF v_family IS NULL THEN
      RAISE NOTICE 'No family for % — skipped', rec.email;
      CONTINUE;
    END IF;

    -- Make sure it is their active family.
    INSERT INTO public.user_preferences (user_id, active_family_id)
      VALUES (v_uid, v_family)
      ON CONFLICT (user_id) DO UPDATE SET active_family_id = EXCLUDED.active_family_id;

    -- Ensure they are an active PARENT of that family.
    UPDATE public.family_members
      SET role = 'parent', is_active = true
      WHERE family_id = v_family AND user_id = v_uid;

    -- Set the plan (update newest subscription row, else create one).
    SELECT id INTO v_sub FROM public.subscriptions
      WHERE family_id = v_family ORDER BY created_at DESC LIMIT 1;
    IF v_sub IS NULL THEN
      INSERT INTO public.subscriptions (family_id, plan, status, current_period_end)
        VALUES (v_family, rec.plan, 'active', now() + interval '100 years');
    ELSE
      UPDATE public.subscriptions
        SET plan = rec.plan, status = 'active', current_period_end = now() + interval '100 years'
        WHERE id = v_sub;
    END IF;

    RAISE NOTICE 'Set % -> % (family %)', rec.email, rec.plan, v_family;
  END LOOP;
END $$;

-- 2) ONLY daniel.hughen@gmail.com is a Super Admin --------------------------
DELETE FROM public.super_admins WHERE lower(email) <> 'daniel.hughen@gmail.com';
INSERT INTO public.super_admins (email) VALUES ('daniel.hughen@gmail.com')
  ON CONFLICT (email) DO NOTHING;

-- 3) Verify ------------------------------------------------------------------
SELECT u.email, s.plan, s.status
FROM auth.users u
JOIN public.user_preferences up ON up.user_id = u.id
LEFT JOIN public.subscriptions s ON s.family_id = up.active_family_id
WHERE lower(u.email) IN (
  'newworldventurellc@gmail.com','blackstoneagencyllc@gmail.com','surgeservicesllc@gmail.com'
)
ORDER BY u.email;

SELECT email FROM public.super_admins ORDER BY email;
