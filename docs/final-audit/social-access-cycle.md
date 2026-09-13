# Social required-read authorization cycle

2026-09-12. Master finding AUTHZ-002 was recorded Critical / IN PROGRESS before application edits. Owned implementation: `lib/social/access.ts`; execution coverage: `tests/social-access-execution.test.ts`. No SQL, live credentials, provider requests, dependency changes or release operations were performed.

## Reproduction and repair

The actual access/roles/settle modules granted `admin` publish/connect access to a parent when the explicit social-permission read returned a database error or rejected. The same parent with a successful `read_only` override was correctly denied. A successful explicit `owner`/`admin` row also authorized callers with a missing or unreadable active membership. The defect matters at the new X token boundary because its service-role client bypasses RLS.

The new regression suite runs the production resolver and installed Supabase/PostgREST query client against synthetic HTTP responses. Before the repair, 17 of 34 cases failed in 46 ms, including returned database failures, aborted transport, rejected query promises, missing membership, mismatched user/family/status, duplicate rows and auth errors. Positive controls covered all eight explicit roles and all six household-role defaults.

The resolver now requires successful auth, active-membership and explicit-permission reads. A clean absent explicit permission permits the existing household-role fallback; a required read failure raises a sanitized `SocialAccessUnavailableError`. A clean absent membership denies access even with an explicit role. Selected row identities, active/status flags and explicit role validity are checked before permission construction. An ordinary missing session remains signed out, and errors containing a user cannot supply authority. Underlying provider/database diagnostics are not included in the error message.

The existing social guard and `public.social_has_permission` have no site-wide super-admin bypass. This change preserves that contract and leaves `lib/supabase/auth.ts` super-admin/feature-preview policy untouched. Auth metadata cannot replace active household membership. It also leaves the role matrix unchanged: for example, JavaScript `admin` still excludes `manage_access`.

## Validation

`npx vitest run tests/social-access-execution.test.ts tests/social-roles.test.ts tests/social-settings-read-boundary.test.ts tests/social-action-persistence.test.ts` — **4 files / 49 tests PASS**, including **34 actual resolver/query-client cases**.

`npx eslint lib/social/access.ts tests/social-access-execution.test.ts` — PASS. Scoped `git diff --check` — PASS. Root owns combined types/build/full-suite verification. Synthetic query execution proves repository behavior, not live RLS or an end-to-end provider connection.

## AUTHZ-003 proposal: open database restriction bypass

`supabase/migrations/0034_social_command_center.sql` creates generic family-member DELETE policies for tables in `social_tables`, including `social_access_permissions` (lines 712–739). The later granular policy block tightens that table's INSERT and UPDATE only (lines 765–771). `social_role_for` falls back to household membership when no active explicit role exists (lines 611–627). Consequently the repository migration permits an authenticated household member to delete their own restrictive explicit role directly and regain their household default; the new error fence does not prevent a successful permitted DELETE. A parent/admin SQL permission matrix also differs from JavaScript on `manage_access`. These are separate existing database authorization contracts, not repaired in this no-SQL cycle. No live database policy claim was made.

Proposed master severity: **Critical; OPEN database hardening / release blocker before enabling live restricted-role publishing**. Exact case: an active `adult` starts with an explicit `read_only` social role, so connect/publish are denied. Their authenticated client directly deletes their own `social_access_permissions` row, which the generic family-member DELETE policy permits. A subsequent successful required read observes clean absence; both the intended default and the repaired JavaScript resolver grant `marketing_manager`, which includes `connect_accounts` and `publish_posts`. The client does not need service credentials or a failed query. The SQL policy must preserve the intended authority to change/remove explicit restrictions before this can be claimed closed; app-only error handling cannot repair it. Root owns the permanent master record. No SQL was authored or executed, and whether deployed policies match repository SQL remains an external verification dependency.

The migration's `social_has_permission` additionally requires `is_family_member`, whose active-membership predicate is defined in `supabase/migrations/0003_functions_triggers.sql`. The resolver now enforces that membership prerequisite before privileged provider operations. Required-read errors remain distinguishable from clean absence.
