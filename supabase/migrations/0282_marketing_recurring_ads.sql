-- Bubaly :: 0282 recurring social ads
--
-- Set a campaign once; it keeps posting on its own cadence until it is paused,
-- reaches its end date, or hits its occurrence cap.
--
-- Two tables, because "what should happen" and "what actually happened" must
-- not be the same row:
--
--   marketing_recurring_ads      the standing instruction + where it has got to
--   marketing_recurring_ad_runs  one row per (occurrence, platform) attempt,
--                                carrying the provider's real answer
--
-- The run ledger is what makes this safe to leave running unattended. Its
-- UNIQUE (ad_id, occurrence, platform) is the idempotency key: two cron ticks
-- racing on the same due ad cannot both post it, because the second insert
-- loses. Without that, a retry after a timeout is a duplicate post on a real
-- brand account — the failure mode that makes people turn automation off.
--
-- RLS: enabled with NO policies, matching every other marketing_* table
-- (0020). These are Super Admin surfaces reached only through the service-role
-- client behind an isSuperAdmin gate; no family ever reads them.

-- ---------------------------------------------------------------------------
-- The existing social board only ever knew six platforms. lib/social/
-- capabilities.ts is the honest source of truth and lists nine, so a recurring
-- ad targeting Threads had nowhere to record what it did. Widening a CHECK is
-- additive: every row that satisfied the old constraint satisfies this one.
-- ---------------------------------------------------------------------------
alter table public.marketing_social_posts drop constraint if exists marketing_social_posts_platform_check;
alter table public.marketing_social_posts add constraint marketing_social_posts_platform_check
  check (platform in ('facebook','instagram','linkedin','tiktok','x','youtube','pinterest','threads','reddit'));

create table if not exists public.marketing_recurring_ads (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid references public.marketing_campaigns(id) on delete set null,
  name            text not null,
  status          text not null default 'active' check (status in ('active','paused')),

  -- Content. body_variants is a ROTATION POOL, not a list of posts: each
  -- occurrence takes the next entry, so a campaign left running for a year does
  -- not put the same sentence in a follower's feed fifty times.
  body_variants   text[] not null default '{}',
  link            text,
  media_urls      text[] not null default '{}',
  platforms       text[] not null default '{}',

  -- Cadence. Times are LOCAL minutes-after-midnight in `timezone`; the runner
  -- converts per occurrence so a DST change moves the UTC instant and not the
  -- time the audience sees. See lib/marketing/recurring-ads.ts.
  cadence         text not null default 'weekly'
                    check (cadence in ('daily','weekdays','weekly','biweekly','monthly')),
  times_of_day    integer[] not null default '{540}',
  days_of_week    integer[] not null default '{}',
  day_of_month    integer check (day_of_month is null or (day_of_month between 1 and 31)),
  timezone        text not null default 'UTC',

  -- Stopping conditions. All three are optional; an ad with none of them set
  -- runs until someone pauses it, which is the point.
  starts_at       timestamptz not null default now(),
  ends_at         timestamptz,
  max_occurrences integer check (max_occurrences is null or max_occurrences > 0),

  -- Where it has got to.
  next_run_at     timestamptz,
  last_run_at     timestamptz,
  occurrences     integer not null default 0,
  last_error      text,

  created_by      uuid references auth.users(id) on delete set null,
  updated_by      uuid references auth.users(id) on delete set null,
  metadata        jsonb not null default '{}'::jsonb,
  deleted_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- The claim query: active, not deleted, due now. Partial so the index stays
-- small as finished campaigns accumulate.
create index if not exists idx_recurring_ads_due
  on public.marketing_recurring_ads (next_run_at)
  where status = 'active' and deleted_at is null;

create table if not exists public.marketing_recurring_ad_runs (
  id                 uuid primary key default gen_random_uuid(),
  ad_id              uuid not null references public.marketing_recurring_ads(id) on delete cascade,
  post_id            uuid references public.marketing_social_posts(id) on delete set null,
  occurrence         integer not null,
  platform           text not null,
  -- Mirrors the connector's own vocabulary (lib/social/connectors.ts). There is
  -- deliberately no value meaning "probably went out": 'published' is written
  -- only when a provider API confirmed it, and 'requires_setup' is the honest
  -- answer for a platform whose credentials are not configured.
  status             text not null
                       check (status in ('published','requires_setup','not_implemented','failed','skipped')),
  body               text not null default '',
  scheduled_for      timestamptz not null,
  ran_at             timestamptz not null default now(),
  provider_object_id text,
  permalink_url      text,
  error_code         text,
  error_message      text,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- The idempotency key. A retried tick, a duplicated dispatch, or two workers
-- racing all collide here instead of posting twice.
create unique index if not exists uq_recurring_ad_run_occurrence
  on public.marketing_recurring_ad_runs (ad_id, occurrence, platform);
create index if not exists idx_recurring_ad_runs_recent
  on public.marketing_recurring_ad_runs (ad_id, ran_at desc);

do $$
declare t text;
begin
  foreach t in array array['marketing_recurring_ads'] loop
    execute format('drop trigger if exists trg_set_updated_at on public.%I', t);
    execute format('create trigger trg_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- RLS on, no policies: service-role (admin console) only, exactly like 0020.
alter table public.marketing_recurring_ads     enable row level security;
alter table public.marketing_recurring_ad_runs enable row level security;
