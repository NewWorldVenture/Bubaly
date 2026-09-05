-- Bubaly :: 0001 extensions + enums
-- Supabase ships pgcrypto/uuid; gen_random_uuid() is available by default.

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- Membership roles (drives RLS + app permissions)
do $$ begin
  create type public.member_role as enum
    ('parent','adult','teen','child','caregiver','guest');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.invite_status as enum
    ('pending','accepted','declined','expired','revoked');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.task_status as enum
    ('todo','in_progress','submitted','approved','rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.priority as enum ('low','medium','high');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.event_category as enum
    ('general','school','sports','appointment','medication','maintenance','birthday','holiday','other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.recurrence_freq as enum
    ('none','daily','weekly','monthly','yearly');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.meal_type as enum ('breakfast','lunch','dinner','snack');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.notification_type as enum
    ('chore_due','medication_due','calendar_event','school_event','sports_event',
     'maintenance_task','grocery_reminder','document_expiry','family_invite','system');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.subscription_status as enum
    ('trialing','active','past_due','canceled','incomplete','incomplete_expired','unpaid');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.theme_pref as enum ('dark','light','system');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.ai_role as enum ('user','assistant','system','tool');
exception when duplicate_object then null; end $$;
