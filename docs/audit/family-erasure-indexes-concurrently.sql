-- ── S-05 (part) The same 36 indexes, for a live database ─────────────────────
--
-- `supabase/migrations/0301_family_erasure_indexes.sql` uses plain `create index`
-- because a migration file runs inside a transaction and `create index
-- concurrently` cannot. Plain creation takes ACCESS EXCLUSIVE on each table for
-- the duration of the build, which on a live `ai_messages` or
-- `sync_webhook_events` is a write outage.
--
-- So apply THIS file to production instead: one statement at a time, outside any
-- transaction, `psql -f` with ON_ERROR_STOP off so a single failure does not
-- abandon the rest. `if not exists` makes it resumable, and re-running it after
-- 0301 has been applied is a no-op.
--
-- A CONCURRENTLY build that is interrupted leaves an INVALID index behind. Find
-- them with:
--
--   select indexrelid::regclass from pg_index where not indisvalid;
--
-- and drop each one before re-running — an invalid index is ignored by the
-- planner but still maintained on write, which is the worst of both.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).

create index concurrently if not exists idx_affiliate_referrals_family_id on public.affiliate_referrals (family_id);
create index concurrently if not exists idx_ai_messages_family_id on public.ai_messages (family_id);
create index concurrently if not exists idx_announcement_reads_family_id on public.announcement_reads (family_id);
create index concurrently if not exists idx_assistant_link_events_family_id on public.assistant_link_events (family_id);
create index concurrently if not exists idx_checkout_sessions_family_id on public.checkout_sessions (family_id);
create index concurrently if not exists idx_chore_ai_validations_family_id on public.chore_ai_validations (family_id);
create index concurrently if not exists idx_chore_approval_events_family_id on public.chore_approval_events (family_id);
create index concurrently if not exists idx_demo_sessions_family_id on public.demo_sessions (family_id);
create index concurrently if not exists idx_family_poll_options_family_id on public.family_poll_options (family_id);
create index concurrently if not exists idx_family_poll_votes_family_id on public.family_poll_votes (family_id);
create index concurrently if not exists idx_feedback_ideas_family_id on public.feedback_ideas (family_id);
create index concurrently if not exists idx_guardian_screening_sessions_family_id on public.guardian_screening_sessions (family_id);
create index concurrently if not exists idx_marketplace_bids_family_id on public.marketplace_bids (family_id);
create index concurrently if not exists idx_marketplace_circles_created_by_family on public.marketplace_circles (created_by_family);
create index concurrently if not exists idx_marketplace_listing_shares_family_id on public.marketplace_listing_shares (family_id);
create index concurrently if not exists idx_marketplace_listings_highest_bidder_family_id on public.marketplace_listings (highest_bidder_family_id);
create index concurrently if not exists idx_marketplace_price_history_family_id on public.marketplace_price_history (family_id);
create index concurrently if not exists idx_marketplace_reports_family_id on public.marketplace_reports (family_id);
create index concurrently if not exists idx_member_badges_family_id on public.member_badges (family_id);
create index concurrently if not exists idx_push_devices_family_id on public.push_devices (family_id);
create index concurrently if not exists idx_resume_versions_family_id on public.resume_versions (family_id);
create index concurrently if not exists idx_reviews_family_id on public.reviews (family_id);
create index concurrently if not exists idx_social_account_tokens_family_id on public.social_account_tokens (family_id);
create index concurrently if not exists idx_social_post_assets_family_id on public.social_post_assets (family_id);
create index concurrently if not exists idx_social_provider_errors_family_id on public.social_provider_errors (family_id);
create index concurrently if not exists idx_social_publish_jobs_family_id on public.social_publish_jobs (family_id);
create index concurrently if not exists idx_social_webhook_events_family_id on public.social_webhook_events (family_id);
create index concurrently if not exists idx_support_tickets_family_id on public.support_tickets (family_id);
create index concurrently if not exists idx_survey_responses_respondent_family_id on public.survey_responses (respondent_family_id);
create index concurrently if not exists idx_sync_calendar_shares_family_id on public.sync_calendar_shares (family_id);
create index concurrently if not exists idx_sync_conflict_resolutions_family_id on public.sync_conflict_resolutions (family_id);
create index concurrently if not exists idx_sync_event_attendees_family_id on public.sync_event_attendees (family_id);
create index concurrently if not exists idx_sync_provider_errors_family_id on public.sync_provider_errors (family_id);
create index concurrently if not exists idx_sync_tokens_family_id on public.sync_tokens (family_id);
create index concurrently if not exists idx_sync_webhook_events_family_id on public.sync_webhook_events (family_id);
create index concurrently if not exists idx_user_preferences_active_family_id on public.user_preferences (active_family_id);
