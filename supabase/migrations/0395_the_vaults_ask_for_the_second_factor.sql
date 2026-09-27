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
-- Measured against the live catalogue before 0382 (which has since guarded
-- WRITES to budgets, savings_goals and bills, but no read anywhere):
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
-- `session_cleared_step_up()` (0382) mirrors lib/auth/mfa.ts `needsStepUp`
-- rather than inventing a second policy in SQL. That function steps up a session ONLY when
-- the account has a factor to step up with; a family that never enrolled is not
-- touched, because their `nextLevel` is `aal1`. The same must hold here, or
-- this migration locks every family without an authenticator out of their own
-- passwords. So: aal2 passes, and so does a session whose account has no
-- verified factor.
--
-- 0382 made it SECURITY DEFINER because `auth.mfa_factors` is not readable by
-- the `authenticated` role, STABLE, with a pinned search_path.
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
-- One more reader exists and was missed when this was first measured:
-- app/api/ai/insights/route.ts loads `household_info` for the 'binder' panel
-- and `tax_documents` for the 'tax' panel, on the session client. Those panels
-- render only on /dashboard/binder and /dashboard/tax-vault, so an enrolled
-- `aal1` session is redirected before the panel exists; a request made
-- straight to the API gets no rows, which is the refusal working. No ungated
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

-- The rule is main's `public.session_cleared_step_up()` (0382), which already
-- encodes exactly this: aal2 passes, and so does a session whose account has
-- no verified factor. It is reused rather than restated, so the money tables
-- and the vaults cannot drift onto two different definitions of "stepped up".
comment on function public.session_cleared_step_up() is
  'True when this session has cleared step-up: either the user has no verified authenticator (two-step is off for them) or the session reached aal2. Guards writes to the money tables (0382) and every access to the credential, tax and binder vaults (0395). Mirrors needsStepUp in lib/auth/mfa.ts.';

drop policy if exists family_credentials_assurance_guard on public.family_credentials;
create policy family_credentials_assurance_guard on public.family_credentials
  as restrictive for all to authenticated
  using (public.session_cleared_step_up())
  with check (public.session_cleared_step_up());

-- The other two tables that pass the containment test above. Same rule, same
-- shape: restrictive, so it is ANDed with whatever governs the table rather
-- than replacing it.
drop policy if exists tax_documents_assurance_guard on public.tax_documents;
create policy tax_documents_assurance_guard on public.tax_documents
  as restrictive for all to authenticated
  using (public.session_cleared_step_up())
  with check (public.session_cleared_step_up());

drop policy if exists household_info_assurance_guard on public.household_info;
create policy household_info_assurance_guard on public.household_info
  as restrictive for all to authenticated
  using (public.session_cleared_step_up())
  with check (public.session_cleared_step_up());
