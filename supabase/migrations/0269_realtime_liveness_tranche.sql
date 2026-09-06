-- ============================================================
-- 0269_realtime_liveness_tranche.sql
--
-- Make liveness honest for the ten surfaces where two people in one household
-- plausibly act on the same row at the same second.
--
-- Before this, ~170 tables were subscribed by the client and 51 were in
-- `supabase_realtime`. The rest opened a websocket that could never fire.
-- The client half of the fix (lib/realtime/published-tables.ts) stops opening
-- those channels; this half gives the ten below something real to deliver.
--
-- REPLICA IDENTITY: Postgres logs only the primary key in a DELETE's old tuple
-- under the default replica identity, and Realtime evaluates a subscription's
-- filter against those old columns. Every filter in this app is
-- `family_id=eq.<uuid>`, and family_id is never part of the primary key, so a
-- DELETE can never match and is dropped server-side. The five tables the client
-- can hard-delete from therefore get REPLICA IDENTITY FULL; the other five have
-- no delete path (family_messages soft-deletes via deleted_at, marketplace_bids
-- is append-only) and would only pay extra WAL for nothing.
--
-- The alternative — an unfiltered DELETE listener — was rejected: Realtime does
-- not apply RLS to DELETE, so an unfiltered listener receives the primary key of
-- every delete on that table in every household, and every open client refetches
-- on every other family's write.
--
-- Idempotent and additive: each ADD TABLE is guarded on pg_publication_tables,
-- the whole block no-ops if the publication does not exist, and REPLICA IDENTITY
-- FULL is a no-op when already set. Safe to replay. Nothing is dropped.
-- ============================================================

begin;

-- ── Publication membership ──────────────────────────────────────────────────
do $$
declare t text;
declare tbls text[] := array[
  'calendar_events',      -- two parents scheduling into the same slot
  'chore_assignments',    -- a child completes, a parent approves
  'family_conversations', -- the thread list and its last-message ordering
  'family_messages',      -- the sender's own message has no other render path
  'grocery_items',        -- one parent in the store, one at home
  'grocery_lists',        -- the list the shopper opened
  'marketplace_bids',     -- a live, timed, real-money auction
  'notifications',        -- the header bell on every screen
  'todo_items',           -- a shared list where completion must propagate
  'todo_lists'
];
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then return; end if;
  foreach t in array tbls loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = t and c.relkind = 'r') then
      continue;
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ── Replica identity, so a DELETE can match a family_id filter ──────────────
-- Only the five with a client delete path. RLS still trims the delivered DELETE
-- payload to the primary key; this changes what the SERVER can filter on, not
-- what a subscriber can read.
do $$
declare t text;
declare tbls text[] := array[
  'calendar_events',   -- routines-panel undo, trip-intel cleanup, relationship module
  'chore_assignments', -- chores-module unassign
  'grocery_items',     -- shopping-module remove / clear-checked, moment actions
  'notifications',     -- notifications-module dismiss
  'todo_items'         -- todos-module delete
];
begin
  foreach t in array tbls loop
    if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relname = t and c.relkind = 'r'
                  and c.relreplident <> 'f') then
      execute format('alter table public.%I replica identity full', t);
    end if;
  end loop;
end $$;

commit;
