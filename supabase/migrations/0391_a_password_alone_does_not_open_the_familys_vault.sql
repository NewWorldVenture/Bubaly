-- Bubaly :: 0391 - a password alone does not open the family's vault
--
-- 0382 gave the money area's step-up its counterpart in the database: a
-- RESTRICTIVE write guard on budgets, savings_goals and bills that asks
-- public.session_cleared_step_up() — "this session reached aal2, OR this user
-- has no verified authenticator". This is the DOCUMENT half of the same
-- finding (O-03).
--
-- WHAT THIS DOES NOT FIX, in one paragraph. public.documents — the table O-03
-- is named after, behind /dashboard/documents and /dashboard/files/{vault,
-- shared,cloud} — and the `documents` storage bucket stay readable and
-- writable over /rest/v1 on a password-only (aal1) session, because
-- /dashboard/home writes them with no step-up (components/modules/
-- home-module.tsx:421 inserts a warranty or manual, :453 deletes one), and
-- the medical-records and trip-memories pages upload into the same bucket
-- with none either. The four vault tables below are fixed; documents and its
-- bucket are still open, and closing them is a separate lead (a step-up entry
-- point on those pages, or a guard on the sensitive-category rows only).
-- The detail is under "deliberately NOT covered" below.
--
-- ── the rule, and why it carries a role clause 0382's did not ──────────────
--
-- session_cleared_step_up() is only the ASSURANCE half of needsStepUp
-- (lib/auth/mfa.ts:102-104). The other half is the ROLE: the page asks a
-- manager (parent or adult) for a code and nobody else — a child or teen who
-- enrolled an authenticator for their own account (Settings › Security offers
-- it to every member) is never sent to /auth/step-up, by aal2Verdict,
-- requireAal2 or the paperwork actions' paperworkScope. 0382 did not need to
-- say so: every write policy on budgets, savings_goals and bills is already
-- can_manage_family (0275), so a non-manager is refused before the guard's
-- answer matters. Three of the four tables here are different —
-- household_info (0081), tax_documents (0077) and paperwork_items (0169) are
-- is_family_member tables — and a guard built on the helper alone would
-- refuse an ENROLLED CHILD at aal1 (an empty binder and tax vault, a paperwork
-- update filtered to nothing) on pages that never offer them a code: a
-- database stricter than the application, with no way out. So every guard
-- below is
--
--   public.session_cleared_step_up() or not public.can_manage_family(family_id)
--
-- which IS the rule needsStepUp applies: a manager of the row's family must
-- have cleared step-up; anyone else is left to the table's own policies. (The
-- page reads the role in the ACTIVE family; the guard reads it in the ROW's
-- family, which is the same family for every row the pages touch, and the
-- right one for a person who is a parent in one household and a child in
-- another.) On an UPDATE the clause is in both halves, so a row cannot be
-- moved INTO a family the session manages without the code either.
--
-- Eight document pages and one capture route call requireAal2(ctx,
-- 'documents', …):
--
--   app/(app)/dashboard/{passwords,binder,tax-vault,paperwork,documents,
--                        files/vault,files/shared,files/cloud}/page.tsx
--   app/(app)/capture/link/page.tsx
--
-- and until now that page guard was the whole enforcement. Every policy on the
-- tables behind them is a MEMBERSHIP or ROLE check — family_credentials (0296)
-- can_manage_family; household_info (0081), tax_documents (0077) and
-- paperwork_items (0169) is_family_member — and a parent on an aal1 session
-- (password, no code) satisfies each of them completely. A grep of every
-- migration for `aal` / `session_cleared_step_up` finds 0382 and nothing else.
-- So the person the control is bought against — someone with the password and
-- not the authenticator — is bounced by /dashboard/passwords to the code page
-- and can, with the anon key and the same session's JWT,
--
--   GET    /rest/v1/family_credentials?family_id=eq.<id>   every stored password
--   GET    /rest/v1/household_info                          the alarm code
--   GET    /rest/v1/tax_documents                           every W-2's path
--   DELETE /rest/v1/paperwork_items?id=eq.<id>
--
-- No page renders, no server action runs, and the database says yes.
--
-- ── what this migration does ────────────────────────────────────────────────
--
-- REUSES public.session_cleared_step_up() from 0382 — one helper, one
-- definition of "cleared", so the money and document halves cannot drift — and
-- fails loudly if 0382 has not been applied first.
--
-- Write guards (insert/update/delete, RESTRICTIVE, to authenticated) on the
-- four tables that are written ONLY from behind the step-up:
--
--   family_credentials   components/modules/passwords-module.tsx, rendered only
--                        by /dashboard/passwords
--   household_info       components/modules/binder-module.tsx, rendered only by
--                        /dashboard/binder
--   tax_documents        components/modules/tax-vault-module.tsx, rendered only
--                        by /dashboard/tax-vault
--   paperwork_items      app/(app)/dashboard/paperwork/actions.ts (gated on
--                        aal2Verdict as of this change), /api/paperwork/capture
--                        and /api/paperwork/link (both already gated), and two
--                        SERVICE-ROLE writers RLS exempts — lib/contact-center/
--                        server.ts fileInboundPaperwork and lib/services/
--                        paperwork/email-attachments.ts, the inbound-email
--                        webhook, both handed createServiceClient()
--
-- Restrictive, so each ANDs with the permissive policy that decides WHO and
-- decides only WHETHER a manager's session is strong enough; a broad policy
-- added beside it cannot satisfy it. Each guard is the two-clause rule above,
-- `session_cleared_step_up() or not can_manage_family(family_id)`.
--
-- Read guards (select, RESTRICTIVE) on the three of those that hold SECRETS —
-- family_credentials, household_info, tax_documents. 0382 deliberately left
-- SELECT alone for the money tables, because the home dashboard, the daily
-- brief and search read budgets on the session client with no step-up entry
-- point to offer. That reasoning does not carry over here. The step-up on the
-- passwords, binder and tax-vault pages is a READ gate — nobody enters a code
-- to star a Wi-Fi entry, they enter it to SEE the password — so a write-only
-- guard would mirror the page's shape and not its purpose. And the readers
-- outside those pages are few and named:
--
--   • components/modules/family-module.tsx:138 counts family_credentials for
--     the "Wi-Fi & Passwords — N saved" tile on /dashboard/family. For a
--     factor-enrolled manager at aal1 that count reads 0 until they step up;
--     the tile links to /dashboard/passwords, which sends them to the code
--     page, and the count is right when they come back.
--   • app/api/ai/insights/route.ts reads household_info ('binder') and
--     tax_documents ('tax') on the session client, for the AiInsight button
--     that is rendered ONLY inside binder-module and tax-vault-module — inside
--     the guarded pages. A direct aal1 call to the route gets a prompt built
--     over zero rows: nothing leaks, and the surface the family sees is
--     behind the step-up anyway.
--   • Realtime (useRealtimeQuery) evaluates SELECT policies per subscriber
--     with the subscriber's own JWT, so it follows the same rule.
--   • lib/ai/context/policy.ts already EXCLUDES all three tables from AI
--     context; no assistant slice, no search index and no privacy export
--     reads them.
--
-- paperwork_items gets NO select guard: /dashboard/needs-you, the household
-- inbox (lib/inbox/server.ts) and the home twin (lib/twin/project-server.ts)
-- read it with no step-up entry point, and a triaged school letter is not a
-- secret in the way a stored password is. The probe pins that choice so a
-- future select guard there is a deliberate change.
--
-- ── deliberately NOT covered, and why ──────────────────────────────────────
--
-- public.documents — the table the Secure Vault (/dashboard/files/vault) and
-- /dashboard/documents show — carries NO guard here, although it is the table
-- the finding is named after. It is also written from /dashboard/home, which
-- has no step-up: components/modules/home-module.tsx:421 inserts a warranty or
-- manual under an asset and :453 deletes one. A guard would fail those writes
-- closed for every factor-enrolled parent at aal1 with "That change was not
-- saved" and no way to enter a code — the exact lock-out 0382's header refused
-- for `transactions`. Closing it needs either a step-up entry point on
-- /dashboard/home or a row-scoped guard (public.is_sensitive_document rows
-- only) — and even the latter has an edge: files-hub lists asset-linked
-- documents too and offers "move to vault", after which home-module's Remove
-- on that same row would be refused. That is the owner's product decision;
-- recorded, not made here.
--
-- storage.objects in the `documents` bucket — the BYTES behind documents and
-- tax_documents — is likewise untouched: home-module, medical-records-module
-- (insurance cards) and trip-memories-module upload into the same bucket from
-- pages with no step-up. A tax document's ROW is now unreadable at aal1, and
-- with it the storage_path a signed URL needs; the folder listing under
-- {family_id}/tax/… is still is_family_member (0007/0266/0303). Recorded.
--
-- ── what the owner should know before applying ─────────────────────────────
--
-- For a manager who HAS enrolled an authenticator and has not entered a code
-- this session:
--   1. The four pages already redirect them to the code page; the guards here
--      catch only a request that skipped the page — which is the point.
--   2. The "Wi-Fi & Passwords" tile on /dashboard/family reads "0 saved" until
--      they step up (above).
--   3. A refused browser-direct UPDATE/DELETE is FILTERED (zero rows, no
--      error). passwords-module already asks for its rows back (.select('id')
--      + wroteNoRows); binder-module (:46, :53) and tax-vault-module (:89) do
--      not — they cannot be reached at aal1 through the page, so the guard
--      cannot fire on a page-driven write, but if one ever did the module
--      would report success. Recorded for the a-refused-write rule.
-- For a family that never enrolled a factor: nothing changes. The helper
-- answers true for them, which is what keeps this opt-in.
-- For a CHILD or TEEN who enrolled an authenticator for their own account:
-- nothing changes either, by design. The pages never ask them for a code
-- (needsStepUp is for managers), so the database does not either: the role
-- clause lets them through every guard, at any assurance level, to exactly
-- what the tables' own policies allow — household_info, tax_documents and
-- paperwork_items to any member (is_family_member), family_credentials to no
-- child at all (0296 is manager-only). That those base policies let a child
-- read the binder and the tax documents is an O-01/O-02-shaped question and
-- not this migration's; it is recorded, not changed, here.
--
-- Replay-safe: `drop policy if exists` before each `create policy`; the helper
-- is not redefined here.

do $$
declare
  t text;
  -- Written only from behind the step-up (see header). The order is the order
  -- a reader meets them on the sidebar; nothing depends on it.
  vault_tables  text[] := array['family_credentials', 'household_info', 'tax_documents', 'paperwork_items'];
  -- The subset that holds secrets and whose page guard is a READ gate.
  secret_tables text[] := array['family_credentials', 'household_info', 'tax_documents'];
  -- What every guard asks: needsStepUp, both halves (header: "the rule, and
  -- why it carries a role clause 0382's did not"). A manager of the row's
  -- family must have cleared step-up; anyone else is left to the table's own
  -- policies.
  cleared constant text := 'public.session_cleared_step_up() or not public.can_manage_family(family_id)';
begin
  if to_regprocedure('public.session_cleared_step_up()') is null then
    raise exception '0391 needs public.session_cleared_step_up() from 0382 — apply 0382 first; this migration deliberately does not define a second helper';
  end if;

  foreach t in array vault_tables loop
    if to_regclass('public.' || t) is null then
      raise exception 'Required vault table missing: %', t;
    end if;
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists %1$s_step_up_insert_guard on public.%1$I', t);
    execute format(
      'create policy %1$s_step_up_insert_guard on public.%1$I as restrictive for insert to authenticated with check (%2$s)',
      t, cleared);

    execute format('drop policy if exists %1$s_step_up_update_guard on public.%1$I', t);
    execute format(
      'create policy %1$s_step_up_update_guard on public.%1$I as restrictive for update to authenticated using (%2$s) with check (%2$s)',
      t, cleared);

    execute format('drop policy if exists %1$s_step_up_delete_guard on public.%1$I', t);
    execute format(
      'create policy %1$s_step_up_delete_guard on public.%1$I as restrictive for delete to authenticated using (%2$s)',
      t, cleared);
  end loop;

  foreach t in array secret_tables loop
    execute format('drop policy if exists %1$s_step_up_select_guard on public.%1$I', t);
    execute format(
      'create policy %1$s_step_up_select_guard on public.%1$I as restrictive for select to authenticated using (%2$s)',
      t, cleared);
    execute format(
      'comment on policy %1$s_step_up_select_guard on public.%1$I is %2$L',
      t,
      'Step-up is a READ gate on this page: a manager (parent or adult) with a verified authenticator sees these rows only on an aal2 session. Mirrors needsStepUp / requireAal2 for the document area (lib/auth/mfa.ts, lib/auth/require-aal2.ts), both halves: non-managers are never asked for a code there, so they are left to this table''s own policies here. Families with no verified authenticator are unaffected.');
  end loop;
end $$;
