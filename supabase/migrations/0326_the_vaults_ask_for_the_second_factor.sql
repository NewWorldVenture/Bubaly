-- The credential vault asks for the second factor. (F-E02, in part)
--
-- `requireAal2` protects 19 server-rendered pages by calling `redirect()`. The
-- data those pages show is not fetched by those pages: it is fetched by client
-- components straight from PostgREST with the browser's own session. An `aal1`
-- session — password only, no second factor — is a fully valid Supabase JWT.
-- The redirect is the only thing stopping it, and the redirect only happens if
-- the browser asks Next.js for the HTML page, which someone holding a stolen
-- session cookie has no reason to do.
--
-- Measured against the live catalogue before this migration:
--
--   select count(*) from pg_policies where schemaname='public'
--     and (coalesce(qual,'')||coalesce(with_check,'')) ilike '%aal%';   -> 0
--
-- Step-up was presentational. Someone with an exported session cookie for a
-- parent account — the precise threat a second factor is bought to answer —
-- read the credential vault without ever being asked for a code.
--
-- ── the rule, and why it is exactly this rule ──────────────────────────────
--
-- `session_meets_assurance()` mirrors lib/auth/mfa.ts `needsStepUp` rather than
-- inventing a second policy in SQL. That function steps up a session ONLY when
-- the account has a factor to step up with; a family that never enrolled is not
-- touched, because their `nextLevel` is `aal1`. The same must hold here, or
-- this migration locks every family without an authenticator out of their own
-- passwords. So: aal2 passes, and so does a session whose account has no
-- verified factor.
--
-- SECURITY DEFINER because `auth.mfa_factors` is not readable by the
-- `authenticated` role, and STABLE because it is read once per statement.
-- The search_path is pinned and includes `extensions` — a definer function that
-- does not is DB-FN-001, which was dead in production for a year.
--
-- ── why THIS table, and not the other eighteen pages' ──────────────────────
--
-- Because the restriction has to be measured against every surface that reads
-- the table, not just the gated one. `family_credentials` has exactly three
-- references in the tree: components/modules/passwords-module.tsx (the gated
-- page's own module), components/modules/family-module.tsx, and
-- lib/ai/context/policy.ts (a denylist, by name). The family-hub reference is a
-- `count: 'exact', head: true` — a tile reading "N passwords saved" — so the
-- only effect on an enrolled `aal1` session outside the vault is that the tile
-- reads 0 until they enter a code. A count is not a secret and 0 is not a lie
-- about one.
--
-- Two more tables meet the same test and are closed with it:
--
--   tax_documents    -> components/modules/tax-vault-module.tsx only
--   household_info   -> components/modules/binder-module.tsx only
--
-- and each of those modules is rendered by exactly one page, /dashboard/tax-vault
-- and /dashboard/binder, both already calling `requireAal2(ctx, 'documents', …)`.
-- Nothing else in app/, components/ or lib/ reads either table, so no ungated
-- surface goes quietly empty.
--
-- `bills`, `documents` and `paperwork_items` are NOT closed here, and the reason
-- is measured rather than assumed. They are read by /dashboard/readiness,
-- /dashboard/agents, /dashboard/planning, /dashboard/command-center,
-- /dashboard/needs-you, finances-module, billing-module, files-hub-module,
-- lib/inbox/server.ts, lib/contact-center/server.ts and three AI routes — none
-- of them behind `requireAal2`. A restrictive policy there would empty all of
-- those for an enrolled `aal1` session, silently, which is the silent-empty-read
-- defect this audit spends its time removing. Closing them needs those surfaces
-- to step up, or to stop reading the data, first. That is recorded in
-- finalaudit.md under F-E02 with the list, so it stays visible work rather than
-- a remembered intention.
--
-- What this does NOT do: `tax_documents` and `household_info` are governed by
-- `is_family_member`, so a CHILD can read the family's tax documents and
-- household binder. A restrictive assurance guard ANDs with that; it does not
-- repair it. That is the 0297 sensitive-table work, a different finding, and
-- naming it here is deliberate so this migration is not mistaken for having
-- scoped these tables by role.
--
-- Held by docs/audit/vaults-require-second-factor-check.sql.

create or replace function public.session_meets_assurance()
returns boolean
language sql
stable
security definer
set search_path = public, auth, extensions
as $$
  select
    coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
    or not exists (
      select 1 from auth.mfa_factors f
       where f.user_id = auth.uid()
         and f.status = 'verified'
    );
$$;

revoke all on function public.session_meets_assurance() from public;
grant execute on function public.session_meets_assurance() to authenticated, service_role;

comment on function public.session_meets_assurance() is
  'True when the session has stepped up, or when the account has no verified factor to step up with. Mirrors needsStepUp in lib/auth/mfa.ts.';

-- RESTRICTIVE, so it is ANDed with the four manager policies already on the
-- table rather than replacing or widening them. `for all` covers the read as
-- well as the writes: reading a stored password is the thing being gated.
drop policy if exists family_credentials_assurance_guard on public.family_credentials;
create policy family_credentials_assurance_guard on public.family_credentials
  as restrictive for all to authenticated
  using (public.session_meets_assurance())
  with check (public.session_meets_assurance());

-- The other two tables that pass the containment test above. Same rule, same
-- shape: restrictive, so it is ANDed with whatever governs the table rather
-- than replacing it.
drop policy if exists tax_documents_assurance_guard on public.tax_documents;
create policy tax_documents_assurance_guard on public.tax_documents
  as restrictive for all to authenticated
  using (public.session_meets_assurance())
  with check (public.session_meets_assurance());

drop policy if exists household_info_assurance_guard on public.household_info;
create policy household_info_assurance_guard on public.household_info
  as restrictive for all to authenticated
  using (public.session_meets_assurance())
  with check (public.session_meets_assurance());
