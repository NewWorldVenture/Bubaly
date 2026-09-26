-- Bubaly :: 0343 - only a parent mints or revokes an assistant key
--
-- 0283 created public.assistant_links and said, in its own header at line 66,
-- "only a parent/admin can create or revoke one, because a link is a standing
-- grant to act as the family." It then wrote the policies against
-- can_manage_family(), which is `role in ('parent','adult')` (0003:22-29). The
-- parent-only predicate the comment describes is is_family_admin() (0003:32-39),
-- two definitions further down, and it was not used here.
--
-- So the rule existed in exactly one place that enforces nothing a client cannot
-- route around: app/(app)/dashboard/assistants/actions.ts, whose canManage() is
-- isAdmin(role) === 'parent' (:28-32, refusing at :37 and :78). Both of that
-- action's writes go through createServiceClient() (:49, :81), which is
-- BYPASSRLS — so on the app's own path RLS never runs, and the parent-only rule
-- is a TypeScript `if`. Meanwhile 0283:96 grants `insert, update, delete` on the
-- table to `authenticated` with no column list, and lib/supabase/client.ts hands
-- every signed-in member a browser client on the anon key with their own JWT.
-- /rest/v1/assistant_links is therefore reachable directly, and the only gate
-- waiting there is can_manage_family.
--
-- Measured on a replay of every migration (353 applied, 0 failed), acting AS an
-- `adult` member of the family over `set role authenticated` with their own
-- `request.jwt.claim.sub` — can_manage_family = t, is_family_admin = f — the
-- adult:
--
--   1. MINTED a live ask+capture link whose token_hash was a secret of their own
--      choosing, with user_id and created_by stamped as the PARENT. That token
--      is a working bearer credential for POST /api/assistant:
--      resolveAssistantLink (lib/assistant/service.ts:54-60) matches on
--      token_hash + `revoked_at is null` and nothing else. The column-level
--      withholding of token_hash (0283:91-95) is no obstacle — it stops them
--      READING the parent's secret, not writing their own. No audit_logs row
--      explains the new key either, because logAudit only runs inside the action
--      (actions.ts:65-69).
--   2. WIDENED the parent's deliberately read-only kitchen speaker from
--      scopes['ask'] to ['ask','capture'] with one UPDATE, so a shared-room
--      speaker began creating events and shopping items.
--   3. REVOKED the parent's key (the family's Alexa goes silent) and then
--      CLEARED revoked_at again, bringing a retired key back to life.
--   4. DELETED the row, which cascaded its assistant_link_events rows away
--      (0283:48, on delete cascade) — audit_rows 1 -> 0. The page's own promise,
--      "Every use is recorded, so you can see what a speaker did"
--      (assistants/page.tsx:150), stops being true for that speaker.
--
-- A `child` in the same fixture was refused the mint outright ("new row violates
-- row-level security policy"), so the existing policy is genuinely manager-level
-- rather than blanket. The gap is exactly the one role the two gates disagree
-- about: `adult`.
--
-- RESTRICTIVE rather than a rewrite of 0283's policies, which is 0254's
-- mechanism as reaffirmed by 0306, 0310, 0322 and 0325: a restrictive policy
-- ANDs with the union of the permissive ones, so no permissive policy — present
-- or added later — can grant past it. SELECT is deliberately untouched: members
-- are meant to SEE that a speaker is connected (0283:66, page.tsx:69-94), they
-- are just not meant to hand one out.
--
-- Nothing legitimate breaks. The application's only writes to this table are the
-- two in actions.ts, both on the service-role client, and service_role is
-- BYPASSRLS. The only client-side write that exists is the one nobody was
-- supposed to be able to make.
--
-- `to authenticated, anon` covers both client roles: the Supabase default
-- privileges leave `anon` holding INSERT/UPDATE/DELETE on every new table
-- (0290's lesson), and a restrictive policy only ANDs with a request made AS a
-- role it names. anon is already refused by can_manage_family (auth.uid() is
-- null), so this is belt and braces rather than a second hole being closed.

do $$
begin
  if to_regclass('public.assistant_links') is null then
    return;
  end if;

  drop policy if exists assistant_links_admin_insert_guard on public.assistant_links;
  create policy assistant_links_admin_insert_guard on public.assistant_links
    as restrictive for insert to authenticated, anon
    with check (public.is_family_admin(family_id));

  -- Both halves. Without WITH CHECK, Postgres reuses USING for the check, which
  -- happens to be the same expression here — but stating both is what keeps the
  -- guard honest if the predicate is ever changed to one where they differ.
  drop policy if exists assistant_links_admin_update_guard on public.assistant_links;
  create policy assistant_links_admin_update_guard on public.assistant_links
    as restrictive for update to authenticated, anon
    using (public.is_family_admin(family_id))
    with check (public.is_family_admin(family_id));

  drop policy if exists assistant_links_admin_delete_guard on public.assistant_links;
  create policy assistant_links_admin_delete_guard on public.assistant_links
    as restrictive for delete to authenticated, anon
    using (public.is_family_admin(family_id));
end
$$;

-- Fail loudly if the three guards are not in force, rather than leaving a
-- migration that "applied" against a table still open to an adult.
do $$
declare
  n integer;
begin
  if to_regclass('public.assistant_links') is null then
    return;
  end if;
  select count(*) into n
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public'
     and c.relname = 'assistant_links'
     and not p.polpermissive
     and p.polname in (
       'assistant_links_admin_insert_guard',
       'assistant_links_admin_update_guard',
       'assistant_links_admin_delete_guard');
  if n <> 3 then
    raise exception 'assistant_links parent-only write guards are not in force (found % of 3)', n;
  end if;
end
$$;
