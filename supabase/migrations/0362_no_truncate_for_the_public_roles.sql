-- ============================================================
-- Migration 0319: TRUNCATE is not part of the public surface
--
-- RLS is authorization; table privilege is a separate layer, and 0237 already
-- says so in its own comment ("RLS is authorization, not table privilege. Keep
-- the public surface narrow"). But RLS does not constrain TRUNCATE at all: a
-- policy of `using (false)` does not stop `truncate public.sync_tokens`, because
-- TRUNCATE is checked against the GRANT and never against the policy.
--
-- Supabase's default privileges hand `anon` and `authenticated` the full set on
-- new tables, and most migrations here revoke nothing, so both roles hold
-- TRUNCATE on the marketing spine (audit C3-S3-02) and on BOTH credential
-- stores — `sync_tokens`, the table this audit otherwise holds up as the model,
-- and `social_account_tokens` (audit C3-S5-09).
--
-- Worth stating precisely rather than overread: PostgREST does not expose
-- TRUNCATE, so this is not reachable over the REST API. It is reachable by
-- anything that executes SQL as those roles — a `security invoker` function, a
-- future RPC, a direct connection with a leaked anon key. Nothing in the
-- product needs it, which is what makes the revoke free.
-- ============================================================

revoke truncate on all tables in schema public from anon, authenticated;

-- Tables created after this migration by the same owner. This covers the
-- default-privilege path, not a table created by a different role — which is
-- why the check below runs on every replay rather than being trusted once.
alter default privileges in schema public revoke truncate on tables from anon, authenticated;

-- The assertion that this held lives in docs/audit/no-truncate-for-public-roles-check.sql,
-- which CI replays on every pull request. It is NOT written here on purpose:
-- tests/migrations-are-additive.test.ts scans migrations for the bare word
-- TRUNCATE outside a grant/revoke privilege list, and it is right to — a
-- ratchet against destructive DDL should not be loosened so that a migration
-- can quote the word in a diagnostic.
