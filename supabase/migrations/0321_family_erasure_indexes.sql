-- ── S-05 (part) The erasure path scans a table per dependent, 36 times over ──
--
-- A `delete from families where id = $1` fires one referential-integrity check
-- per dependent constraint, and each one issues exactly:
--
--     select 1 from <child> x where x.<fkcol> = $1 for key share
--
-- With no index LEADING on that column there is no plan but a sequential scan of
-- the whole table — every other household's rows included — inside the same
-- transaction, taking row locks as it goes.
--
-- Measured here, on `ai_messages` at 200,050 rows with 50 belonging to the family
-- being closed:
--
--     as shipped   LockRows → Seq Scan   4,990 buffers   21.4 ms   (200,008 rows removed by filter)
--     with index   LockRows → Index Scan     55 buffers    0.064 ms
--
-- Claude-3 measured the identical shape on `sync_webhook_events` at 400,050 rows:
-- 5,765 buffers / 52.9 ms → 54 / 0.18 ms, and the whole family delete at 189 ms.
--
-- `ai_messages` is deliberately the example, because
-- `docs/audit/family-scoped-index-check.sql` names it as one of four tables
-- "checked and left alone" — on the correct grounds that its PAGE query carries
-- another selective column (`conversation_id`), so a family_id index buys that
-- query nothing. The RI trigger has no other column. The earlier exclusion was
-- right about the read and silent about the delete, which is why all four of
-- those tables are in this list.
--
-- SCOPE. This covers the 36 CASCADE/SET NULL constraints that reference
-- `public.families` and lack a leading index — 32 on `family_id` plus
-- `active_family_id`, `created_by_family`, `highest_bidder_family_id` and
-- `respondent_family_id`. They are the low-regret set: `family_id` is the column
-- every RLS policy on these tables already filters on, so each index pays for
-- itself on ordinary reads as well as on erasure.
--
-- Measured and NOT included, because it is a real tradeoff rather than a
-- correction: 158 unindexed constraints reference `family_members` (41 CASCADE +
-- 117 SET NULL), 11 reference `child_wallets` and 22 reference `vacations`. Those
-- are member-reference columns — `member_id`, `assignee_id`, `created_by` — not
-- the RLS predicate, so they accelerate member removal and nothing else, at 191
-- indexes' worth of write amplification. Recorded in finalaudit.md for the owner
-- rather than decided here.
--
-- APPLY NOTE. These are plain `create index`, which takes ACCESS EXCLUSIVE on
-- each table for the duration. That is right for a replay and for a small
-- database; on production, run the CONCURRENTLY variant in
-- docs/audit/family-erasure-indexes-concurrently.sql instead, one statement at a
-- time and OUTSIDE a transaction — `create index concurrently` cannot run inside
-- one, which is why this file cannot use it.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).

create index if not exists idx_affiliate_referrals_family_id on public.affiliate_referrals (family_id);
create index if not exists idx_ai_messages_family_id on public.ai_messages (family_id);
create index if not exists idx_announcement_reads_family_id on public.announcement_reads (family_id);
create index if not exists idx_assistant_link_events_family_id on public.assistant_link_events (family_id);
create index if not exists idx_checkout_sessions_family_id on public.checkout_sessions (family_id);
create index if not exists idx_chore_ai_validations_family_id on public.chore_ai_validations (family_id);
create index if not exists idx_chore_approval_events_family_id on public.chore_approval_events (family_id);
create index if not exists idx_demo_sessions_family_id on public.demo_sessions (family_id);
create index if not exists idx_family_poll_options_family_id on public.family_poll_options (family_id);
create index if not exists idx_family_poll_votes_family_id on public.family_poll_votes (family_id);
create index if not exists idx_feedback_ideas_family_id on public.feedback_ideas (family_id);
create index if not exists idx_guardian_screening_sessions_family_id on public.guardian_screening_sessions (family_id);
create index if not exists idx_marketplace_bids_family_id on public.marketplace_bids (family_id);
create index if not exists idx_marketplace_circles_created_by_family on public.marketplace_circles (created_by_family);
create index if not exists idx_marketplace_listing_shares_family_id on public.marketplace_listing_shares (family_id);
create index if not exists idx_marketplace_listings_highest_bidder_family_id on public.marketplace_listings (highest_bidder_family_id);
create index if not exists idx_marketplace_price_history_family_id on public.marketplace_price_history (family_id);
create index if not exists idx_marketplace_reports_family_id on public.marketplace_reports (family_id);
create index if not exists idx_member_badges_family_id on public.member_badges (family_id);
create index if not exists idx_push_devices_family_id on public.push_devices (family_id);
create index if not exists idx_resume_versions_family_id on public.resume_versions (family_id);
create index if not exists idx_reviews_family_id on public.reviews (family_id);
create index if not exists idx_social_account_tokens_family_id on public.social_account_tokens (family_id);
create index if not exists idx_social_post_assets_family_id on public.social_post_assets (family_id);
create index if not exists idx_social_provider_errors_family_id on public.social_provider_errors (family_id);
create index if not exists idx_social_publish_jobs_family_id on public.social_publish_jobs (family_id);
create index if not exists idx_social_webhook_events_family_id on public.social_webhook_events (family_id);
create index if not exists idx_support_tickets_family_id on public.support_tickets (family_id);
create index if not exists idx_survey_responses_respondent_family_id on public.survey_responses (respondent_family_id);
create index if not exists idx_sync_calendar_shares_family_id on public.sync_calendar_shares (family_id);
create index if not exists idx_sync_conflict_resolutions_family_id on public.sync_conflict_resolutions (family_id);
create index if not exists idx_sync_event_attendees_family_id on public.sync_event_attendees (family_id);
create index if not exists idx_sync_provider_errors_family_id on public.sync_provider_errors (family_id);
create index if not exists idx_sync_tokens_family_id on public.sync_tokens (family_id);
create index if not exists idx_sync_webhook_events_family_id on public.sync_webhook_events (family_id);
create index if not exists idx_user_preferences_active_family_id on public.user_preferences (active_family_id);
