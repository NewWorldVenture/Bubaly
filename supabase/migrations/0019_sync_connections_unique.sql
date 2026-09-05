-- Bubaly :: 0019 sync_connections one-per-account
-- connectAccount() upserts a single connection row per provider account, so the
-- account_id needs a unique constraint to back the ON CONFLICT target.

create unique index if not exists sync_connections_account_ukey
  on public.sync_connections(account_id);
