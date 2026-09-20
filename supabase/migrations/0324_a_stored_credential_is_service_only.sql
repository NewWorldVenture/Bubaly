-- A stored credential is service-only. (F-E04)
--
-- Two tables hold third-party OAuth credentials in identically named columns —
-- access_token_enc, refresh_token_enc, scope, expires_at — and were protected
-- differently:
--
--   sync_tokens            | tokens service only          | ALL    | qual=false  check=false
--   social_account_tokens  | social_account_tokens_select | SELECT | qual=can_manage_family(family_id)
--   social_account_tokens  | social_account_tokens_update | UPDATE | qual=can_manage_family(family_id)
--   social_account_tokens  | social_account_tokens_delete | DELETE | qual=can_manage_family(family_id)
--   social_account_tokens  | social_account_tokens_insert | INSERT | check=can_manage_family(family_id)
--
-- `qual=false` is the right answer for a credential table: the service role
-- bypasses RLS, so a policy that admits nobody still leaves the feature
-- working while leaving the anon key with nothing to ask for.
--
-- Nothing loses access here. Every path that touches this table already runs as
-- the service role — lib/social/account-tokens.ts types its client as
-- `ReturnType<typeof createServiceClient>`, and it is the only module in app/
-- or lib/ that reads the table at all (lib/ai/context/policy.ts merely
-- denylists it from AI context, by name, for this same reason). The four client
-- policies granted access no feature ever used.
--
-- What they did grant, to any manager holding the anon key:
--
--   * SELECT of the stored credential columns. They are ciphertext from
--     lib/sync/crypto, so this was not by itself a usable credential — it is
--     removed because a table of credentials should not be answering client
--     reads at all, and because that ciphertext is one key disclosure away from
--     being the credential.
--   * UPDATE of `metadata`, which is NOT ciphertext. It carries the
--     x_state / x_revision claim machine account-tokens.ts uses to make the
--     OAuth exchange idempotent, so a direct write could replay or strand a
--     connection flow.
--   * UPDATE of `provider_account_id`, repointing a family's connection at
--     another account.
--   * INSERT and DELETE of credential rows outright.
--
-- The upstream note that recorded this (F-E04) described the policies as
-- `is_family_member`, which would have meant a child could read them. They read
-- `can_manage_family` today — someone tightened them in between — so the child
-- case was already closed and is asserted here so it stays that way.
-- docs/audit/social-token-is-service-only-check.sql reproduces all five
-- breaches against the pre-migration schema and passes after it.
--
-- Connection STATUS stays where it belongs: social_accounts keeps its
-- family-facing policies, so the UI can still show what is connected without
-- anybody's client role touching a token.

drop policy if exists social_account_tokens_select on public.social_account_tokens;
drop policy if exists social_account_tokens_insert on public.social_account_tokens;
drop policy if exists social_account_tokens_update on public.social_account_tokens;
drop policy if exists social_account_tokens_delete on public.social_account_tokens;

alter table public.social_account_tokens enable row level security;

-- Named to match sync_tokens' policy exactly, because it is the same rule and
-- the next person comparing the two tables should find them identical.
drop policy if exists "social tokens service only" on public.social_account_tokens;
create policy "social tokens service only" on public.social_account_tokens
  for all using (false) with check (false);
