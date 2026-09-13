-- Bubaly :: 0285 every ON CONFLICT target is inferable
--
-- Five upserts in this codebase could never have run. Postgres resolves an
-- `ON CONFLICT (a, b)` column list by INDEX INFERENCE, and inference matches
-- only a unique index that is
--
--   • over exactly those columns,
--   • not an expression index, and
--   • not partial (a partial index is inferable only when the statement also
--     repeats the index predicate — which PostgREST, and therefore
--     `supabase.upsert({ onConflict })`, has no way to emit).
--
-- When no index matches, the statement fails at PLANNING time with
-- `42P10: there is no unique or exclusion constraint matching the ON CONFLICT
-- specification`. Planning, not execution — so it fails on the very first row,
-- with an empty table, every single time. There is no "works until there is a
-- conflict" grace period, which is why these were invisible: nothing about a
-- partial or expression index looks wrong when you read the migration that
-- created it, and the application code reads correctly too. Only the pair is
-- wrong, and no test in the suite ever put the pair together.
--
-- Each was verified by replaying all 300 migrations into a Postgres 16 and
-- issuing the exact statement PostgREST emits. All five raised 42P10; a control
-- upsert (library_feeds, which has a plain index) succeeded.
--
--   calendar_events           every ICS/Google feed sync — `lib/server/calendar-feeds.ts`
--   marketing_automation_runs automation run de-duplication — `lib/marketing/automation-events.ts`
--   family_inbox_messages     inbox de-duplication — `lib/contact-center/server.ts`
--   library_items             every podcast feed ingest — `app/(app)/dashboard/library/actions.ts`
--   subscriptions             every Stripe subscription webhook — `app/api/webhooks/stripe/route.ts`
--
-- Additive and idempotent: new indexes are created BEFORE the old ones are
-- dropped, so uniqueness is never unenforced for even an instant.

-- ── calendar_events ─────────────────────────────────────────────────────────
-- The predicate `feed_id IS NOT NULL AND external_uid IS NOT NULL` was already
-- redundant: a default unique index treats NULLs as DISTINCT, so a row with
-- either column null can never collide with anything. Dropping the predicate
-- therefore changes nothing about which rows conflict — it only makes the index
-- inferable. Every event Bubaly imports has both columns set.
create unique index if not exists uq_calendar_events_feed_uid
  on public.calendar_events (feed_id, external_uid);
drop index if exists public.uniq_calendar_events_feed_uid;

-- ── marketing_automation_runs ───────────────────────────────────────────────
-- Same reasoning: `WHERE subject_key IS NOT NULL` is what NULL-distinctness
-- already gives. This index is the automation spine's de-duplication — without
-- it, `recordAutomationRun` throws instead of skipping a subject it has served.
create unique index if not exists uq_mkt_runs_workflow_subject
  on public.marketing_automation_runs (workflow_id, subject_key);
drop index if exists public.uniq_mkt_runs_workflow_subject;

-- ── family_inbox_messages ───────────────────────────────────────────────────
-- Same again for `WHERE provider_ref IS NOT NULL`. A message with no provider
-- reference (one composed inside Bubaly) never deduped against anything before
-- and does not now.
create unique index if not exists uq_inbox_channel_provider_ref
  on public.family_inbox_messages (channel, provider_ref);
drop index if exists public.uq_inbox_provider_ref;

-- ── library_items ───────────────────────────────────────────────────────────
-- This one cannot be fixed by dropping a predicate, because the expression is
-- load-bearing. `feed_id` is null for a book somebody typed in, and NULLs being
-- distinct is exactly the WRONG behaviour there: two manual books with the same
-- guid must collide. 0284 solved that with `coalesce(feed_id::text, 'manual')`,
-- which is correct and not inferable.
--
-- A STORED generated column keeps the semantics and restores inference: it is a
-- real column, so a plain unique index over it is a plain unique index. The
-- column is derived, never written by the application, and PostgREST will not
-- accept a value for it.
alter table public.library_items
  add column if not exists feed_key text
  generated always as (coalesce(feed_id::text, 'manual')) stored;

create unique index if not exists uq_library_items_feed_key_guid
  on public.library_items (family_id, feed_key, guid);
drop index if exists public.uq_library_item_guid;

-- ── subscriptions ───────────────────────────────────────────────────────────
-- Not a partial or expression index — there was no unique index on `family_id`
-- AT ALL, so `onConflict: 'family_id'` never had anything to infer and every
-- `customer.subscription.*` webhook raised "Subscription persistence failed".
--
-- One row per family is an invariant the application ALREADY depends on:
-- `lib/hooks/use-billing-subscription.ts` reads it with `.maybeSingle()`, which
-- errors outright on a second row. Declaring it in the schema is overdue.
--
-- Creating it is attempted, not forced. A migration must never delete rows from
-- a billing table to make an index fit, and this one is applied to production by
-- a person who cannot see the duplicates before they run it. So: if a family
-- somehow holds two subscription rows, the index is skipped and the migration
-- says so, loudly, with the count. The application does not depend on the index
-- either way — the webhook now updates-then-inserts rather than upserting — so a
-- skip degrades the invariant, not the feature.
do $$
declare
  dupes bigint;
begin
  select count(*) into dupes from (
    select family_id from public.subscriptions group by family_id having count(*) > 1
  ) d;

  if dupes > 0 then
    raise warning
      '0285: skipped uq_subscriptions_family — % family/families hold more than one subscriptions row. '
      'Resolve them (keep the row carrying provider_ref, or the most recently updated) and then run: '
      'create unique index concurrently uq_subscriptions_family on public.subscriptions (family_id);',
      dupes;
  else
    create unique index if not exists uq_subscriptions_family
      on public.subscriptions (family_id);
  end if;
end $$;
