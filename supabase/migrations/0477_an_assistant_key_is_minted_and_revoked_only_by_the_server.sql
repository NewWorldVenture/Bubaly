-- Bubaly :: 0477 - an assistant key is minted and revoked only by the server
-- ----------------------------------------------------------------------------
-- From the 2026-10-10 assistant-links audit (proposed-assistant-links-lockdown.sql,
-- the SQL half of audit/assistant-links-fix). Numbered 0477 by owner decision of
-- 2026-10-10; the SQL is the proposal's, unchanged.
--
-- Measured on the replayed schema: 0283 already revoked SELECT from the client
-- roles (a key hash is read server-side only), so after this file a client holds
-- only 0283's DELETE on the table, behind 0343's parent-only delete guard. The
-- proposal's "clients keep SELECT" below describes the intent (reads are not
-- narrowed here), not a grant that exists.
--
-- Assistant (Alexa) keys are minted and revoked only by service-role server
-- actions (app/(app)/dashboard/assistants/actions.ts). Table-wide client
-- INSERT/UPDATE (0283:96) let a parent forge a key in a co-parent's name, or
-- re-point or un-revoke a key, so it survived their own removal (0419 revokes
-- only rows WHERE user_id = the departing user). Clients keep SELECT (and
-- DELETE, if 0283's grant is still needed); writes go through the server.
revoke insert, update on public.assistant_links from authenticated, anon;

-- ── self-check ───────────────────────────────────────────────────────────────
do $$
declare
  r text;
  v text;
begin
  if to_regclass('public.assistant_links') is null then
    raise exception '0477: public.assistant_links does not exist';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    foreach v in array array['INSERT', 'UPDATE'] loop
      if has_table_privilege(r, 'public.assistant_links', v) then
        raise exception '0477: % still holds % on public.assistant_links', r, v;
      end if;
    end loop;
  end loop;
  -- 0283's DELETE grant is left as it was: 0343's parent-only delete guard
  -- stands on it, and only-a-parent-mints-or-revokes-an-assistant-key-check
  -- measures it.
  if not has_table_privilege('authenticated', 'public.assistant_links', 'DELETE') then
    raise exception '0477: authenticated lost DELETE on public.assistant_links (0283''s grant, guarded by 0343)';
  end if;
  raise notice '0477 OK: assistant_links INSERT and UPDATE are the server''s; 0283''s DELETE grant stands';
end
$$;
