// lib/database.types.ts
// Hand-authored to exactly match supabase/migrations. This is the typed source of
// truth for every Supabase query in the web + mobile apps. To regenerate against a
// live project instead: `npm run db:types` (supabase gen types typescript).

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type MemberRole = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';
export type InviteStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'revoked';
export type TaskStatus = 'todo' | 'in_progress' | 'submitted' | 'done' | 'approved' | 'rejected';
export type Priority = 'low' | 'medium' | 'high';
export type EventCategory =
  | 'general' | 'school' | 'sports' | 'appointment' | 'medication'
  | 'maintenance' | 'birthday' | 'holiday' | 'other';
export type RecurrenceFreq = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
export type PetSpecies = 'dog' | 'cat' | 'bird' | 'fish' | 'reptile' | 'small_mammal' | 'horse' | 'other';
export type PetCareKind = 'vaccination' | 'vet_visit' | 'medication' | 'grooming' | 'weight' | 'other';
export type WardrobeCategory = 'top' | 'bottom' | 'dress' | 'outerwear' | 'shoes' | 'accessory' | 'uniform' | 'sleepwear' | 'activewear' | 'swim';
export type WardrobeStatus = 'active' | 'laundry' | 'storage' | 'outgrown' | 'donated' | 'lost';
export type OutfitOccasion = 'everyday' | 'school' | 'work' | 'sport' | 'dressy' | 'party' | 'outdoor' | 'sleep';
export type WatchKind = 'movie' | 'show' | 'documentary' | 'kids' | 'special';
export type WatchService = 'netflix' | 'disney' | 'prime' | 'hulu' | 'max' | 'apple' | 'peacock' | 'paramount' | 'youtube' | 'library' | 'theater' | 'other';
export type WatchStatus = 'want' | 'watching' | 'watched' | 'skipped';
export type WatchVote = 'love' | 'up' | 'down';
export type HomeLocationKind = 'room' | 'closet' | 'garage' | 'attic' | 'basement' | 'shed' | 'storage_unit' | 'box' | 'shelf' | 'drawer' | 'cabinet' | 'vehicle' | 'other';
export type InventoryCategory = 'electronics' | 'tools' | 'sports' | 'toys' | 'documents' | 'kitchen' | 'furniture' | 'seasonal' | 'clothing' | 'outdoor' | 'medical' | 'keys' | 'jewelry' | 'other';
export type InventoryStatus = 'in_place' | 'lent' | 'lost' | 'disposed' | 'in_repair';
export type SleepSource = 'manual' | 'wearable' | 'estimate';
export type DeclutterZoneKind = 'surface' | 'closet' | 'drawer' | 'floor' | 'shelf' | 'fridge' | 'garage' | 'entryway' | 'desk' | 'toys' | 'digital' | 'other';
export type DeclutterMissionStatus = 'planned' | 'done' | 'skipped';
export type MoveStatus = 'planning' | 'packing' | 'moving_day' | 'settling' | 'done' | 'cancelled';
export type MoveKind = 'local' | 'long_distance' | 'international' | 'within_building';
export type MoveTaskCategory = 'admin' | 'address' | 'utilities' | 'movers' | 'packing' | 'school' | 'medical' | 'pets' | 'finance' | 'cleaning' | 'settling' | 'other';
export type MoveTaskStatus = 'todo' | 'doing' | 'done' | 'skipped';
export type MoveBoxStatus = 'empty' | 'packed' | 'loaded' | 'delivered' | 'unpacked';
export type HomeProjectKind = 'repair' | 'renovation' | 'upgrade' | 'outdoor' | 'decor' | 'safety' | 'organization' | 'other';
export type HomeProjectStatus = 'idea' | 'planning' | 'quoting' | 'scheduled' | 'in_progress' | 'on_hold' | 'done' | 'cancelled';
export type HomeProjectPriority = 'low' | 'medium' | 'high';
export type ProjectQuoteStatus = 'requested' | 'received' | 'accepted' | 'declined' | 'expired';
export type CareerWorkMode = 'remote' | 'hybrid' | 'onsite' | 'any';
export type CareerEmploymentType = 'full_time' | 'part_time' | 'contract' | 'internship' | 'first_job' | 'any';
export type CareerStatus = 'exploring' | 'active_search' | 'interviewing' | 'offer' | 'employed' | 'paused';
export type JobStage = 'saved' | 'applied' | 'screening' | 'interview' | 'offer' | 'accepted' | 'rejected' | 'withdrawn';
export type CefrLevel = 'A0' | 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
export type LanguageSessionKind = 'conversation' | 'vocab' | 'listening' | 'reading' | 'writing' | 'grammar' | 'lesson' | 'tutor' | 'immersion';
export type InsurancePolicyType = 'health' | 'dental' | 'vision' | 'auto' | 'home' | 'renters' | 'life' | 'disability' | 'umbrella' | 'pet' | 'travel' | 'other';
export type PremiumFrequency = 'monthly' | 'quarterly' | 'semiannual' | 'annual';
export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type PantryLocation = 'pantry' | 'fridge' | 'freezer' | 'counter' | 'garage' | 'other';
export type NutritionSubject = 'recipe' | 'meal' | 'week';
export type NotificationType =
  | 'chore_due' | 'medication_due' | 'calendar_event' | 'school_event' | 'sports_event'
  | 'maintenance_task' | 'grocery_reminder' | 'document_expiry' | 'family_invite' | 'system';
export type WalletTxnType =
  | 'gift_received' | 'parent_top_up' | 'allowance' | 'chore_reward' | 'babysitter_payment'
  | 'card_spend' | 'card_refund' | 'goal_transfer' | 'bucket_transfer' | 'transfer' | 'withdrawal' | 'fee' | 'adjustment' | 'reversal';
export type WalletTxnStatus =
  | 'pending' | 'requires_parent_approval' | 'processing' | 'completed' | 'failed' | 'reversed' | 'cancelled';
export type StripeAccountStatus = 'pending' | 'restricted' | 'enabled' | 'disabled';
export type InvestOrderSide = 'buy' | 'sell';
export type InvestOrderStatus = 'pending' | 'filled' | 'rejected' | 'cancelled';
export type SocialItemKind = 'post' | 'video' | 'photo' | 'link';
export type SocialCategory = 'family' | 'friends' | 'groups' | 'other';
export type EconomyDirection = 'credit' | 'debit';
export type EconomyRedemptionStatus = 'pending' | 'approved' | 'fulfilled' | 'rejected' | 'cancelled';
export type SubscriptionStatus =
  | 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'unpaid';
export type AccountType = 'checking' | 'savings' | 'credit' | 'investment' | 'retirement';
export type TransactionType = 'income' | 'expense' | 'transfer';
export type BudgetPeriod = 'weekly' | 'monthly' | 'yearly';
export type BillStatus = 'upcoming' | 'paid' | 'overdue';
export type MetricType = 'steps' | 'sleep_hours' | 'heart_rate' | 'calories' | 'active_minutes' | 'distance' | 'weight' | 'water_cups';
export type GameResult = 'win' | 'loss' | 'tie';
export type GradeType = 'test' | 'quiz' | 'homework' | 'project' | 'final' | 'participation' | 'other';
export type ThemePref = 'dark' | 'light' | 'system';
export type DashboardView = 'personal' | 'family';
export type AiRole = 'user' | 'assistant' | 'system' | 'tool';
// AI runtime (0250/0251). `AiRunState` is the §10 lifecycle shared by
// ai_requests.status and family_automation_runs.state; the legacy free-text
// `family_automation_runs.status` keeps its own 0022 vocabulary and stays `string`.
export type AiRunState =
  | 'queued' | 'planning' | 'awaiting_context' | 'awaiting_approval' | 'ready' | 'executing'
  | 'verifying' | 'scheduled_followup' | 'completed' | 'partially_completed' | 'blocked'
  | 'failed' | 'cancelled';
export type AiRunLifecycleState = AiRunState | 'paused';
export type AiStepState = AiRunState | 'skipped';
export type AiRequestKind = 'concierge' | 'feature' | 'routine' | 'trigger' | 'handle_it';
/** `family_automation_rules.schedule_kind` (0259). */
export type RoutineScheduleKind = 'cron' | 'relative';
/** `routine_runs.status` (0259): one row per fired occurrence. */
export type RoutineRunStatus = 'filed' | 'skipped' | 'failed';
/** `home_briefs.kind` (0258): the morning brief and the evening recap. */
export type HomeBriefKind = 'daily' | 'evening';
/** `family_ai_settings.behavior` (0257): §11's three autonomy levels. */
export type AutonomyBehaviorValue = 'recommend' | 'prepare' | 'execute';
export type AiRunType = 'concierge' | 'routine' | 'trigger' | 'handle_it' | 'concierge_plan';
export type AiPlanStatus =
  | 'draft' | 'approved' | 'executing' | 'completed' | 'partially_completed' | 'failed' | 'cancelled' | 'superseded';
export type AiStepType = 'retrieve' | 'act' | 'verify' | 'notify' | 'approval' | 'followup' | 'replan';
export type AiRiskLevel = 'low' | 'medium' | 'high';
export type AiActorKind = 'ai' | 'member' | 'system';
export type AiToolCallState = 'reserved' | 'succeeded' | 'failed';
export type AiConversationState = 'open' | 'archived';
export type AiApprovalPayloadKind = 'tool' | 'plan_steps' | 'concierge_plan';
export type AiRunEventType =
  | 'run_started' | 'planned' | 'step_started' | 'step_completed' | 'step_failed' | 'step_retried'
  | 'step_skipped' | 'approval_requested' | 'approval_decided' | 'clarification_asked'
  | 'clarification_answered' | 'verified' | 'verification_failed' | 'model_call' | 'notified'
  | 'paused' | 'resumed' | 'blocked' | 'cancelled' | 'run_completed' | 'run_failed' | 'followup_scheduled';
export type RecordKind = 'medical' | 'dental';
export type RideStatus = 'planned' | 'confirmed' | 'completed' | 'cancelled';
export type HomeworkStatus = 'assigned' | 'in_progress' | 'done' | 'submitted';
export type RenewalStatus = 'active' | 'renewed' | 'expired' | 'cancelled';
export type CareLogType = 'check_in' | 'visit' | 'call' | 'meal' | 'medication' | 'appointment' | 'incident' | 'note';
export type OpportunityStatus = 'interested' | 'registered' | 'waitlisted' | 'passed' | 'missed';
export type LocationEventType = 'arrived' | 'left' | 'ping';
export type WishPriority = 'low' | 'medium' | 'high';
export type RelationshipDateKind = 'anniversary' | 'birthday' | 'first_date' | 'date_night' | 'milestone' | 'custom';
export type RelationshipDateStatus = 'idea' | 'planned' | 'booked' | 'upcoming' | 'completed' | 'cancelled';
export type RelationshipGiftSource = 'manual' | 'ai' | 'wishlist';
export type RelationshipGiftStatus = 'idea' | 'saved' | 'ordered' | 'purchased' | 'given';
export type DoseStatus = 'taken' | 'skipped' | 'missed';
export type WeekPattern = 'all' | 'a' | 'b';
export type TripStatus = 'planning' | 'booked' | 'active' | 'completed' | 'cancelled';
export type TripItemKind = 'packing' | 'todo' | 'reservation' | 'document';
export type RedemptionStatus = 'requested' | 'approved' | 'fulfilled' | 'rejected';

// Vacation Planner enums (migration 0070)
export type VacationStatus = 'planning' | 'booked' | 'active' | 'completed' | 'cancelled';
export type VacationKind = 'road_trip' | 'flight' | 'cruise' | 'theme_park' | 'international' | 'domestic' | 'staycation' | 'camping' | 'other';
export type VacItemKind = 'activity' | 'reservation' | 'meal' | 'travel' | 'reminder' | 'note' | 'free_time';
export type VacDayPart = 'morning' | 'afternoon' | 'evening' | 'all_day';
export type VacTransportKind = 'car' | 'train' | 'bus' | 'ferry' | 'rideshare' | 'shuttle' | 'subway' | 'walk' | 'bike' | 'other';
export type VacLodgingKind = 'hotel' | 'airbnb' | 'resort' | 'cabin' | 'campground' | 'cruise_cabin' | 'hostel' | 'family' | 'rental' | 'other';
export type VacBudgetCategory = 'flights' | 'lodging' | 'transportation' | 'activities' | 'food' | 'shopping' | 'insurance' | 'fees' | 'misc';
export type VacPackCategory = 'clothes' | 'toiletries' | 'electronics' | 'medications' | 'documents' | 'sports' | 'beach' | 'ski' | 'camping' | 'baby' | 'snacks' | 'other';
export type VacDocKind = 'passport' | 'id' | 'visa' | 'ticket' | 'boarding_pass' | 'hotel_confirmation' | 'rental_confirmation' | 'insurance' | 'itinerary' | 'medical' | 'other';
export type VacRecoKind = 'missing_reservation' | 'packing' | 'budget_warning' | 'weather_warning' | 'travel_conflict' | 'activity_suggestion' | 'restaurant' | 'document_missing' | 'suggestion';
export type VacRecoStatus = 'open' | 'accepted' | 'dismissed' | 'done';

// Weekend Planner enums (migration 0071, 0072)
export type WeekendPlanStatus = 'interested' | 'going' | 'maybe' | 'passed';
export type WeekendFeedKind = 'ics' | 'rss';

// Sync platform enums (migration 0018)
export type SyncProviderEnum = 'google' | 'microsoft' | 'apple' | 'amazon' | 'internal';
export type SyncDirection = 'import' | 'export' | 'two_way' | 'manual' | 'disabled';
export type SyncStatusEnum =
  | 'pending' | 'syncing' | 'synced' | 'error' | 'conflict' | 'disabled' | 'unsupported';
export type SyncItemType = 'calendar' | 'event' | 'reminder_list' | 'reminder' | 'note' | 'note_folder';
export type SyncConflictStatus = 'open' | 'resolved' | 'ignored';
export type SyncConflictResolutionEnum =
  | 'keep_local' | 'keep_remote' | 'merge' | 'duplicate' | 'manual';
export type SyncJobStatus =
  | 'queued' | 'running' | 'succeeded' | 'failed' | 'dead_letter' | 'cancelled';

// Social command center enums (migration 0034)
export type SocialPlatformEnum =
  | 'x' | 'facebook' | 'instagram' | 'linkedin' | 'tiktok'
  | 'youtube' | 'pinterest' | 'threads' | 'reddit';
export type SocialAccountStatus =
  | 'pending' | 'connected' | 'error' | 'expired' | 'disconnected' | 'revoked' | 'requires_setup';
export type SocialPostKind =
  | 'text' | 'image' | 'video' | 'audio' | 'short'
  | 'carousel' | 'thread' | 'poll' | 'link' | 'announcement';
export type SocialPostStatusEnum =
  | 'draft' | 'scheduled' | 'publishing' | 'published'
  | 'partially_published' | 'failed' | 'canceled';
export type SocialTargetStatus =
  | 'pending' | 'publishing' | 'published' | 'failed' | 'skipped' | 'canceled';
export type SocialJobStatus =
  | 'queued' | 'running' | 'succeeded' | 'failed' | 'dead_letter' | 'canceled';
export type SocialApprovalStatus =
  | 'not_required' | 'pending' | 'approved' | 'rejected' | 'changes_requested';
export type SocialInboxStatus = 'open' | 'resolved' | 'ignored' | 'snoozed';
export type SocialAssetKind = 'image' | 'video' | 'audio' | 'document' | 'thumbnail';
export type SocialRoleEnum =
  | 'owner' | 'admin' | 'marketing_manager' | 'social_manager'
  | 'content_creator' | 'approver' | 'analyst' | 'read_only';

type Stamps = { created_at: string; updated_at: string };

/** Helper to assemble a Tables entry from its Row + the insertable/updatable shapes.
 *  `Relationships: []` satisfies postgrest-js's GenericTable constraint (we don't rely
 *  on typed embedded joins; queries select columns explicitly). */
type T<Row, Insert, Update> = { Row: Row; Insert: Insert; Update: Update; Relationships: [] };

export interface Database {
  public: {
    Tables: {
      finance_transaction_operation_receipts: T<
        { family_id: string; operation_key: string; original_tool_call_id: string; actor_user_id: string | null; actor_member_id: string | null; actor_kind: AiActorKind; intent_version: 1; intent: Json; transaction_id: string; transaction_snapshot: Json; created_at: string },
        never,
        never
      >;
      child_logins: T<
        { id: string; family_id: string; member_id: string; user_id: string; username: string; created_by: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; member_id: string; user_id: string; username: string; created_by?: string | null },
        Partial<{ username: string; user_id: string; member_id: string }>
      >;
      child_login_throttle: T<
        { username: string; fails: number; window_start: string; locked_until: string | null; updated_at: string },
        { username: string; fails?: number; window_start?: string; locked_until?: string | null },
        Partial<{ fails: number; window_start: string; locked_until: string | null }>
      >;
      dining_out: T<
        { id: string; family_id: string; name: string; kind: string; cuisine: string | null; category: string | null; price_level: number | null; rating: number | null; address: string | null; distance_km: number | null; amount_cents: number | null; item_count: number | null; notes: string | null; is_favorite: boolean; visited_at: string | null; metadata: Json; created_by: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; name: string; kind?: string; cuisine?: string | null; category?: string | null; price_level?: number | null; rating?: number | null; address?: string | null; distance_km?: number | null; amount_cents?: number | null; item_count?: number | null; notes?: string | null; is_favorite?: boolean; visited_at?: string | null; metadata?: Json; created_by?: string | null },
        Partial<{ name: string; kind: string; cuisine: string | null; category: string | null; price_level: number | null; rating: number | null; address: string | null; distance_km: number | null; amount_cents: number | null; item_count: number | null; notes: string | null; is_favorite: boolean; visited_at: string | null; metadata: Json }>
      >;
      profiles: T<
        { id: string; email: string | null; full_name: string | null; display_name: string | null; avatar_url: string | null; date_of_birth: string | null; phone: string | null } & Stamps,
        { id: string; email?: string | null; full_name?: string | null; display_name?: string | null; avatar_url?: string | null; date_of_birth?: string | null; phone?: string | null },
        Partial<{ email: string | null; full_name: string | null; display_name: string | null; avatar_url: string | null; date_of_birth: string | null; phone: string | null }>
      >;
      families: T<
        { id: string; name: string; avatar_url: string | null; cover_url: string | null; address: string | null; family_code: string | null; timezone: string; trial_ends_at: string | null; closed_at: string | null; created_by: string | null } & Stamps,
        { id?: string; name: string; avatar_url?: string | null; cover_url?: string | null; address?: string | null; family_code?: string | null; timezone?: string; trial_ends_at?: string | null; closed_at?: string | null; created_by?: string | null },
        Partial<{ name: string; avatar_url: string | null; cover_url: string | null; address: string | null; family_code: string | null; timezone: string; trial_ends_at: string | null; closed_at: string | null }>
      >;
      family_members: T<
        { id: string; family_id: string; user_id: string | null; role: MemberRole; display_name: string; color: string | null; birthday: string | null; email: string | null; phone: string | null; avatar_url: string | null; is_active: boolean; onboarding_key: string | null } & Stamps,
        { id?: string; family_id: string; user_id?: string | null; role?: MemberRole; display_name: string; color?: string | null; birthday?: string | null; email?: string | null; phone?: string | null; avatar_url?: string | null; is_active?: boolean; onboarding_key?: string | null },
        Partial<{ user_id: string | null; role: MemberRole; display_name: string; color: string | null; birthday: string | null; email: string | null; phone: string | null; avatar_url: string | null; is_active: boolean; onboarding_key: string | null }>
      >;
      roles: T<
        { role: MemberRole; label: string; description: string | null },
        { role: MemberRole; label: string; description?: string | null },
        Partial<{ label: string; description: string | null }>
      >;
      permissions: T<
        { id: string; role: MemberRole; resource: string; can_create: boolean; can_read: boolean; can_update: boolean; can_delete: boolean },
        { id?: string; role: MemberRole; resource: string; can_create?: boolean; can_read?: boolean; can_update?: boolean; can_delete?: boolean },
        Partial<{ can_create: boolean; can_read: boolean; can_update: boolean; can_delete: boolean }>
      >;
      invites: T<
        { id: string; family_id: string; email: string; role: MemberRole; token: string; status: InviteStatus; invited_by: string | null; expires_at: string; accepted_by: string | null; onboarding_key: string | null } & Stamps,
        { id?: string; family_id: string; email: string; role?: MemberRole; token?: string; status?: InviteStatus; invited_by?: string | null; expires_at?: string; onboarding_key?: string | null },
        Partial<{ status: InviteStatus; role: MemberRole; accepted_by: string | null; onboarding_key: string | null }>
      >;
      calendar_events: T<
        { id: string; family_id: string; title: string; description: string | null; location: string | null; category: EventCategory; starts_at: string; ends_at: string | null; all_day: boolean; recurrence: RecurrenceFreq; recurrence_until: string | null; assignee_id: string | null; feed_id: string | null; external_uid: string | null; created_by: string | null; onboarding_key: string | null; idempotency_key: string | null } & Stamps,
        { id?: string; family_id: string; title: string; description?: string | null; location?: string | null; category?: EventCategory; starts_at: string; ends_at?: string | null; all_day?: boolean; recurrence?: RecurrenceFreq; recurrence_until?: string | null; assignee_id?: string | null; feed_id?: string | null; external_uid?: string | null; created_by?: string | null; onboarding_key?: string | null; idempotency_key?: string | null },
        Partial<{ title: string; description: string | null; location: string | null; category: EventCategory; starts_at: string; ends_at: string | null; all_day: boolean; recurrence: RecurrenceFreq; recurrence_until: string | null; assignee_id: string | null; feed_id: string | null; external_uid: string | null; onboarding_key: string | null }>
      >;
      routine_templates: T<
        { id: string; family_id: string; name: string; icon: string | null; color: string | null; weekday_mask: number; is_active: boolean; source: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; icon?: string | null; color?: string | null; weekday_mask?: number; is_active?: boolean; source?: string; created_by?: string | null },
        Partial<{ name: string; icon: string | null; color: string | null; weekday_mask: number; is_active: boolean; source: string }>
      >;
      routine_template_items: T<
        { id: string; template_id: string; family_id: string; title: string; category: EventCategory; start_minutes: number; duration_minutes: number; assignee_id: string | null; sort_order: number } & Stamps,
        { id?: string; template_id: string; family_id: string; title: string; category?: EventCategory; start_minutes?: number; duration_minutes?: number; assignee_id?: string | null; sort_order?: number },
        Partial<{ title: string; category: EventCategory; start_minutes: number; duration_minutes: number; assignee_id: string | null; sort_order: number }>
      >;
      calendar_feeds: T<
        { id: string; family_id: string; name: string; url: string; color: string; last_status: string; last_error: string | null; last_synced_at: string | null; event_count: number; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; url: string; color?: string; last_status?: string; last_error?: string | null; last_synced_at?: string | null; event_count?: number; created_by?: string | null },
        Partial<{ name: string; url: string; color: string; last_status: string; last_error: string | null; last_synced_at: string | null; event_count: number }>
      >;
      school_events: T<
        { id: string; family_id: string; member_id: string | null; school_name: string | null; title: string; event_type: string | null; starts_at: string; ends_at: string | null; notes: string | null; source: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; school_name?: string | null; title: string; event_type?: string | null; starts_at: string; ends_at?: string | null; notes?: string | null; source?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; school_name: string | null; title: string; event_type: string | null; starts_at: string; ends_at: string | null; notes: string | null }>
      >;
      sports_events: T<
        { id: string; family_id: string; member_id: string | null; sport: string | null; team: string | null; title: string; event_type: string | null; location: string | null; starts_at: string; ends_at: string | null; recurrence: RecurrenceFreq; recurrence_until: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; sport?: string | null; team?: string | null; title: string; event_type?: string | null; location?: string | null; starts_at: string; ends_at?: string | null; recurrence?: RecurrenceFreq; recurrence_until?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; sport: string | null; team: string | null; title: string; event_type: string | null; location: string | null; starts_at: string; ends_at: string | null; recurrence: RecurrenceFreq }>
      >;
      appointments: T<
        { id: string; family_id: string; member_id: string | null; title: string; provider: string | null; location: string | null; starts_at: string; ends_at: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; title: string; provider?: string | null; location?: string | null; starts_at: string; ends_at?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; title: string; provider: string | null; location: string | null; starts_at: string; ends_at: string | null; notes: string | null }>
      >;
      chores: T<
        { id: string; family_id: string; title: string; description: string | null; points: number; priority: Priority; recurrence: RecurrenceFreq; due_at: string | null; requires_approval: boolean; created_by: string | null; category: string | null; difficulty: string; est_minutes: number | null; proof_required: string; reward_mode: string; cash_cents: number | null; cash_min_cents: number | null; cash_max_cents: number | null; points_min: number | null; points_max: number | null; auto_approve_score: number | null; safety_level: string; instructions: string | null; example_image_url: string | null; icon: string | null; is_active: boolean } & Stamps,
        { id?: string; family_id: string; title: string; description?: string | null; points?: number; priority?: Priority; recurrence?: RecurrenceFreq; due_at?: string | null; requires_approval?: boolean; created_by?: string | null; category?: string | null; difficulty?: string; est_minutes?: number | null; proof_required?: string; reward_mode?: string; cash_cents?: number | null; cash_min_cents?: number | null; cash_max_cents?: number | null; points_min?: number | null; points_max?: number | null; auto_approve_score?: number | null; safety_level?: string; instructions?: string | null; example_image_url?: string | null; icon?: string | null; is_active?: boolean },
        Partial<{ title: string; description: string | null; points: number; priority: Priority; recurrence: RecurrenceFreq; due_at: string | null; requires_approval: boolean; category: string | null; difficulty: string; est_minutes: number | null; proof_required: string; reward_mode: string; cash_cents: number | null; cash_min_cents: number | null; cash_max_cents: number | null; points_min: number | null; points_max: number | null; auto_approve_score: number | null; safety_level: string; instructions: string | null; example_image_url: string | null; icon: string | null; is_active: boolean }>
      >;
      chore_assignments: T<
        { id: string; family_id: string; chore_id: string; member_id: string; status: TaskStatus; due_at: string | null; submitted_at: string | null; approved_at: string | null; approved_by: string | null; points_awarded: number | null; ai_score: number | null; cash_awarded_cents: number | null; idempotency_key: string | null; disputed: boolean } & Stamps,
        { id?: string; family_id: string; chore_id: string; member_id: string; status?: TaskStatus; idempotency_key?: string | null; due_at?: string | null },
        Partial<{ member_id: string; status: TaskStatus; due_at: string | null; submitted_at: string | null; approved_at: string | null; approved_by: string | null; points_awarded: number | null; ai_score: number | null; cash_awarded_cents: number | null; disputed: boolean }>
      >;
      rewards: T<
        { id: string; family_id: string; title: string; description: string | null; cost_points: number; redeemed_by: string | null; redeemed_at: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title: string; description?: string | null; cost_points?: number; created_by?: string | null },
        Partial<{ title: string; description: string | null; cost_points: number; redeemed_by: string | null; redeemed_at: string | null }>
      >;
      reward_redemptions: T<
        { id: string; family_id: string; reward_id: string | null; member_id: string; reward_title: string; cost_points: number; status: RedemptionStatus; note: string | null; decided_by: string | null; decided_at: string | null } & Stamps,
        { id?: string; family_id: string; reward_id?: string | null; member_id: string; reward_title: string; cost_points?: number; status?: RedemptionStatus; note?: string | null; decided_by?: string | null; decided_at?: string | null },
        Partial<{ reward_id: string | null; reward_title: string; cost_points: number; status: RedemptionStatus; note: string | null; decided_by: string | null; decided_at: string | null }>
      >;
      meals: T<
        { id: string; family_id: string; name: string; meal_type: MealType; recipe_url: string | null; image_url: string | null; ingredients: Json; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; meal_type?: MealType; recipe_url?: string | null; image_url?: string | null; ingredients?: Json; notes?: string | null; created_by?: string | null },
        Partial<{ name: string; meal_type: MealType; recipe_url: string | null; image_url: string | null; ingredients: Json; notes: string | null }>
      >;
      meal_plans: T<
        { id: string; family_id: string; meal_id: string | null; plan_date: string; meal_type: MealType; idempotency_key: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; meal_id?: string | null; plan_date: string; meal_type?: MealType; idempotency_key?: string | null; created_by?: string | null },
        Partial<{ meal_id: string | null; plan_date: string; meal_type: MealType }>
      >;
      meal_votes: T<
        { id: string; family_id: string; created_by: string | null; title: string; meal_date: string | null; meal_type: string | null; status: string; deadline: string | null; allow_maybe: boolean; winner_option_id: string | null } & Stamps,
        { id?: string; family_id: string; created_by?: string | null; title: string; meal_date?: string | null; meal_type?: string | null; status?: string; deadline?: string | null; allow_maybe?: boolean; winner_option_id?: string | null },
        Partial<{ title: string; meal_date: string | null; meal_type: string | null; status: string; deadline: string | null; allow_maybe: boolean; winner_option_id: string | null }>
      >;
      meal_vote_options: T<
        { id: string; vote_id: string; family_id: string; recipe_id: string | null; label: string; photo_url: string | null; created_at: string },
        { id?: string; vote_id: string; family_id: string; recipe_id?: string | null; label: string; photo_url?: string | null },
        Partial<{ label: string; photo_url: string | null; recipe_id: string | null }>
      >;
      meal_vote_ballots: T<
        { id: string; vote_id: string; option_id: string; family_id: string; member_id: string; choice: string } & Stamps,
        { id?: string; vote_id: string; option_id: string; family_id: string; member_id: string; choice?: string },
        Partial<{ choice: string }>
      >;
      // 0014 added store / list_icon / list_color / sort_order / archived_at when the
      // table grew multi-store lists; this entry never caught up, which is why the
      // shopping module carries `as never` on every write that names one of them and
      // why nothing could read `archived_at` without a cast.
      grocery_lists: T<
        { id: string; family_id: string; name: string; is_archived: boolean; store: string | null; list_icon: string | null; list_color: string | null; sort_order: number | null; archived_at: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name?: string; is_archived?: boolean; store?: string | null; list_icon?: string | null; list_color?: string | null; sort_order?: number | null; archived_at?: string | null; created_by?: string | null },
        Partial<{ name: string; is_archived: boolean; store: string | null; list_icon: string | null; list_color: string | null; sort_order: number | null; archived_at: string | null }>
      >;
      grocery_items: T<
        { id: string; family_id: string; list_id: string; name: string; quantity: string | null; category: string | null; is_checked: boolean; source_meal_id: string | null; idempotency_key: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; list_id: string; name: string; quantity?: string | null; category?: string | null; is_checked?: boolean; source_meal_id?: string | null; idempotency_key?: string | null; created_by?: string | null },
        Partial<{ name: string; quantity: string | null; category: string | null; is_checked: boolean }>
      >;
      pantry_items: T<
        { id: string; family_id: string; name: string; category: string | null; location: PantryLocation; quantity: number; unit: string | null; low_threshold: number | null; expires_at: string | null; barcode: string | null; is_staple: boolean; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; category?: string | null; location?: PantryLocation; quantity?: number; unit?: string | null; low_threshold?: number | null; expires_at?: string | null; barcode?: string | null; is_staple?: boolean; notes?: string | null; created_by?: string | null },
        Partial<{ name: string; category: string | null; location: PantryLocation; quantity: number; unit: string | null; low_threshold: number | null; expires_at: string | null; barcode: string | null; is_staple: boolean; notes: string | null }>
      >;
      meal_nutrition: T<
        { id: string; family_id: string; subject_type: NutritionSubject; subject_id: string; servings: number | null; calories: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null; fiber_g: number | null; sugar_g: number | null; sodium_mg: number | null; summary: string | null; details: Json | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; subject_type: NutritionSubject; subject_id: string; servings?: number | null; calories?: number | null; protein_g?: number | null; carbs_g?: number | null; fat_g?: number | null; fiber_g?: number | null; sugar_g?: number | null; sodium_mg?: number | null; summary?: string | null; details?: Json | null; created_by?: string | null },
        Partial<{ subject_type: NutritionSubject; subject_id: string; servings: number | null; calories: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null; fiber_g: number | null; sugar_g: number | null; sodium_mg: number | null; summary: string | null; details: Json | null }>
      >;
      family_favorites: T<
        { id: string; family_id: string; member_id: string | null; kind: string; name: string; notes: string | null; rating: number | null; ref_url: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; kind?: string; name: string; notes?: string | null; rating?: number | null; ref_url?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; kind: string; name: string; notes: string | null; rating: number | null; ref_url: string | null }>
      >;
      nutrition_logs: T<
        { id: string; family_id: string; member_id: string | null; logged_on: string; meal: string; item: string; calories: number; protein_g: number; carbs_g: number; fat_g: number; water_ml: number; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; logged_on?: string; meal?: string; item: string; calories?: number; protein_g?: number; carbs_g?: number; fat_g?: number; water_ml?: number; notes?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; logged_on: string; meal: string; item: string; calories: number; protein_g: number; carbs_g: number; fat_g: number; water_ml: number; notes: string | null }>
      >;
      leftover_inventory: T<
        { id: string; family_id: string; name: string; source_meal: string | null; quantity: string | null; stored_on: string; use_by: string | null; location: string; status: string; notes: string | null; metadata: Json; created_by: string | null; updated_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; source_meal?: string | null; quantity?: string | null; stored_on?: string; use_by?: string | null; location?: string; status?: string; notes?: string | null; metadata?: Json; created_by?: string | null; updated_by?: string | null },
        Partial<{ name: string; source_meal: string | null; quantity: string | null; stored_on: string; use_by: string | null; location: string; status: string; notes: string | null; metadata: Json; updated_by: string | null }>
      >;
      family_food_scores: T<
        { id: string; family_id: string; snapshot_date: string; overall: number; grade: string; sub_scores: Json; coaching: Json; metadata: Json; created_by: string | null; updated_by: string | null } & Stamps,
        { id?: string; family_id: string; snapshot_date?: string; overall: number; grade: string; sub_scores?: Json; coaching?: Json; metadata?: Json; created_by?: string | null; updated_by?: string | null },
        Partial<{ snapshot_date: string; overall: number; grade: string; sub_scores: Json; coaching: Json; metadata: Json; updated_by: string | null }>
      >;
      medications: T<
        { id: string; family_id: string; member_id: string | null; name: string; dosage: string | null; instructions: string | null; is_active: boolean; refill_on: string | null; refill_reminder_days: number; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; name: string; dosage?: string | null; instructions?: string | null; is_active?: boolean; refill_on?: string | null; refill_reminder_days?: number; created_by?: string | null },
        Partial<{ member_id: string | null; name: string; dosage: string | null; instructions: string | null; is_active: boolean; refill_on: string | null; refill_reminder_days: number }>
      >;
      medication_schedules: T<
        { id: string; family_id: string; medication_id: string; time_of_day: string; days_of_week: number[]; starts_on: string; ends_on: string | null; last_taken_at: string | null } & Stamps,
        { id?: string; family_id: string; medication_id: string; time_of_day: string; days_of_week?: number[]; starts_on?: string; ends_on?: string | null },
        Partial<{ time_of_day: string; days_of_week: number[]; starts_on: string; ends_on: string | null; last_taken_at: string | null }>
      >;
      trips: T<
        { id: string; family_id: string; name: string; destination: string | null; start_date: string | null; end_date: string | null; status: TripStatus; traveler_ids: string[]; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; destination?: string | null; start_date?: string | null; end_date?: string | null; status?: TripStatus; traveler_ids?: string[]; notes?: string | null; created_by?: string | null },
        Partial<{ name: string; destination: string | null; start_date: string | null; end_date: string | null; status: TripStatus; traveler_ids: string[]; notes: string | null }>
      >;
      trip_items: T<
        { id: string; family_id: string; trip_id: string; kind: TripItemKind; label: string; details: string | null; assignee_id: string | null; is_done: boolean; due_at: string | null; sort_order: number; created_by: string | null } & Stamps,
        { id?: string; family_id: string; trip_id: string; kind?: TripItemKind; label: string; details?: string | null; assignee_id?: string | null; is_done?: boolean; due_at?: string | null; sort_order?: number; created_by?: string | null },
        Partial<{ kind: TripItemKind; label: string; details: string | null; assignee_id: string | null; is_done: boolean; due_at: string | null; sort_order: number }>
      >;
      medication_doses: T<
        { id: string; family_id: string; medication_id: string; schedule_id: string | null; member_id: string | null; scheduled_for: string; status: DoseStatus; taken_at: string | null; notes: string | null; logged_by: string | null } & Stamps,
        { id?: string; family_id: string; medication_id: string; schedule_id?: string | null; member_id?: string | null; scheduled_for: string; status?: DoseStatus; taken_at?: string | null; notes?: string | null; logged_by?: string | null },
        Partial<{ schedule_id: string | null; member_id: string | null; scheduled_for: string; status: DoseStatus; taken_at: string | null; notes: string | null }>
      >;
      rides: T<
        { id: string; family_id: string; title: string; ride_date: string; pickup_time: string | null; dropoff_time: string | null; pickup_location: string | null; dropoff_location: string | null; driver_id: string | null; rider_ids: string[]; status: RideStatus; notes: string | null; event_id: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title: string; ride_date: string; pickup_time?: string | null; dropoff_time?: string | null; pickup_location?: string | null; dropoff_location?: string | null; driver_id?: string | null; rider_ids?: string[]; status?: RideStatus; notes?: string | null; event_id?: string | null; created_by?: string | null },
        Partial<{ title: string; ride_date: string; pickup_time: string | null; dropoff_time: string | null; pickup_location: string | null; dropoff_location: string | null; driver_id: string | null; rider_ids: string[]; status: RideStatus; notes: string | null; event_id: string | null }>
      >;
      homework_assignments: T<
        { id: string; family_id: string; member_id: string | null; subject: string | null; title: string; details: string | null; due_at: string | null; status: HomeworkStatus; completed_at: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; subject?: string | null; title: string; details?: string | null; due_at?: string | null; status?: HomeworkStatus; completed_at?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; subject: string | null; title: string; details: string | null; due_at: string | null; status: HomeworkStatus; completed_at: string | null }>
      >;
      renewals: T<
        { id: string; family_id: string; member_id: string | null; title: string; category: string | null; expires_at: string; reminder_days: number; cost: number | null; url: string | null; status: RenewalStatus; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; title: string; category?: string | null; expires_at: string; reminder_days?: number; cost?: number | null; url?: string | null; status?: RenewalStatus; notes?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; title: string; category: string | null; expires_at: string; reminder_days: number; cost: number | null; url: string | null; status: RenewalStatus; notes: string | null }>
      >;
      care_log: T<
        { id: string; family_id: string; member_id: string; log_type: CareLogType; occurred_at: string; wellbeing: number | null; note: string | null; logged_by: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; log_type?: CareLogType; occurred_at?: string; wellbeing?: number | null; note?: string | null; logged_by?: string | null; created_by?: string | null },
        Partial<{ member_id: string; log_type: CareLogType; occurred_at: string; wellbeing: number | null; note: string | null; logged_by: string | null }>
      >;
      family_places: T<
        { id: string; family_id: string; name: string; icon: string | null; address: string | null; latitude: number; longitude: number; radius_m: number; geofence_enabled: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; icon?: string | null; address?: string | null; latitude: number; longitude: number; radius_m?: number; geofence_enabled?: boolean; created_by?: string | null },
        Partial<{ name: string; icon: string | null; address: string | null; latitude: number; longitude: number; radius_m: number; geofence_enabled: boolean }>
      >;
      member_locations: T<
        { id: string; family_id: string; member_id: string; latitude: number | null; longitude: number | null; accuracy_m: number | null; battery: number | null; place_id: string | null; address: string | null; is_sharing: boolean } & Stamps,
        { id?: string; family_id: string; member_id: string; latitude?: number | null; longitude?: number | null; accuracy_m?: number | null; battery?: number | null; place_id?: string | null; address?: string | null; is_sharing?: boolean },
        Partial<{ latitude: number | null; longitude: number | null; accuracy_m: number | null; battery: number | null; place_id: string | null; address: string | null; is_sharing: boolean }>
      >;
      safety_check_ins: T<
        { id: string; family_id: string; member_id: string | null; status: string; place_id: string | null; place_label: string | null; note: string | null; latitude: number | null; longitude: number | null; created_by: string | null; created_at: string },
        { id?: string; family_id: string; member_id?: string | null; status?: string; place_id?: string | null; place_label?: string | null; note?: string | null; latitude?: number | null; longitude?: number | null; created_by?: string | null },
        Partial<{ member_id: string | null; status: string; place_id: string | null; place_label: string | null; note: string | null; latitude: number | null; longitude: number | null }>
      >;
      driving_trips: T<
        { id: string; family_id: string; member_id: string | null; label: string | null; started_at: string; ended_at: string | null; distance_miles: number; max_mph: number; hard_brakes: number; rapid_accels: number; phone_use_seconds: number; score: number; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; label?: string | null; started_at?: string; ended_at?: string | null; distance_miles?: number; max_mph?: number; hard_brakes?: number; rapid_accels?: number; phone_use_seconds?: number; score?: number; notes?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; label: string | null; started_at: string; ended_at: string | null; distance_miles: number; max_mph: number; hard_brakes: number; rapid_accels: number; phone_use_seconds: number; score: number; notes: string | null }>
      >;
      play_dates: T<
        { id: string; family_id: string; member_id: string | null; title: string; with_kids: string | null; location: string | null; place_id: string | null; starts_at: string; ends_at: string | null; status: string; contact_name: string | null; contact_phone: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; title: string; with_kids?: string | null; location?: string | null; place_id?: string | null; starts_at: string; ends_at?: string | null; status?: string; contact_name?: string | null; contact_phone?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; title: string; with_kids: string | null; location: string | null; place_id: string | null; starts_at: string; ends_at: string | null; status: string; contact_name: string | null; contact_phone: string | null; notes: string | null }>
      >;
      marketplace_listings: T<
        { id: string; family_id: string; member_id: string | null; title: string; description: string | null; kind: string; category: string; condition: string | null; price_cents: number; rent_period: string | null; photo_url: string | null; location: string | null; status: string; claimed_by: string | null; claimed_at: string | null; created_by: string | null; sale_format: string; auction_starts_at: string | null; auction_ends_at: string | null; starting_bid_cents: number; reserve_cents: number | null; buy_now_cents: number | null; current_bid_cents: number; bid_count: number; highest_bidder_member_id: string | null; highest_bidder_family_id: string | null; highest_max_cents: number; anti_snipe_minutes: number; auction_closed_at: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; title: string; description?: string | null; kind?: string; category?: string; condition?: string | null; price_cents?: number; rent_period?: string | null; photo_url?: string | null; location?: string | null; status?: string; claimed_by?: string | null; claimed_at?: string | null; created_by?: string | null; sale_format?: string; auction_starts_at?: string | null; auction_ends_at?: string | null; starting_bid_cents?: number; reserve_cents?: number | null; buy_now_cents?: number | null; anti_snipe_minutes?: number },
        Partial<{ member_id: string | null; title: string; description: string | null; kind: string; category: string; condition: string | null; price_cents: number; rent_period: string | null; photo_url: string | null; location: string | null; status: string; claimed_by: string | null; claimed_at: string | null; sale_format: string; auction_starts_at: string | null; auction_ends_at: string | null; starting_bid_cents: number; reserve_cents: number | null; buy_now_cents: number | null; current_bid_cents: number; bid_count: number; highest_bidder_member_id: string | null; highest_bidder_family_id: string | null; highest_max_cents: number; anti_snipe_minutes: number; auction_closed_at: string | null }>
      >;
      marketplace_bids: T<
        { id: string; listing_id: string; family_id: string; bidder_member_id: string; bidder_family_id: string; amount_cents: number; max_cents: number; status: string; is_auto: boolean; created_at: string },
        { id?: string; listing_id: string; family_id: string; bidder_member_id: string; bidder_family_id: string; amount_cents: number; max_cents: number; status?: string; is_auto?: boolean },
        Partial<{ status: string }>
      >;
      marketplace_offers: T<
        { id: string; family_id: string; listing_id: string; member_id: string | null; kind: string; amount_cents: number | null; message: string | null; status: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; listing_id: string; member_id?: string | null; kind?: string; amount_cents?: number | null; message?: string | null; status?: string; created_by?: string | null },
        Partial<{ member_id: string | null; kind: string; amount_cents: number | null; message: string | null; status: string }>
      >;
      marketplace_negotiations: T<
        { id: string; family_id: string; listing_id: string; buyer_member_id: string; buyer_family_id: string; status: string; current_amount_cents: number; last_actor: string; rounds_count: number; agreed_amount_cents: number | null; order_id: string | null } & Stamps,
        { id?: string; family_id: string; listing_id: string; buyer_member_id: string; buyer_family_id: string; status?: string; current_amount_cents: number; last_actor: string; rounds_count?: number; agreed_amount_cents?: number | null; order_id?: string | null },
        Partial<{ status: string; current_amount_cents: number; last_actor: string; rounds_count: number; agreed_amount_cents: number | null; order_id: string | null }>
      >;
      marketplace_negotiation_rounds: T<
        { id: string; negotiation_id: string; listing_id: string; actor_member_id: string | null; actor_role: string; kind: string; amount_cents: number | null; message: string | null; created_at: string },
        { id?: string; negotiation_id: string; listing_id: string; actor_member_id?: string | null; actor_role: string; kind: string; amount_cents?: number | null; message?: string | null },
        Partial<{ actor_role: string; kind: string; amount_cents: number | null; message: string | null }>
      >;
      marketplace_matches: T<
        { id: string; family_id: string; wanted_id: string; supply_id: string; score: number; reason: string | null; status: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; wanted_id: string; supply_id: string; score?: number; reason?: string | null; status?: string; created_by?: string | null },
        Partial<{ score: number; reason: string | null; status: string }>
      >;
      marketplace_stores: T<
        { id: string; family_id: string; member_id: string; name: string; tagline: string | null; description: string | null; emoji: string | null; is_active: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; name: string; tagline?: string | null; description?: string | null; emoji?: string | null; is_active?: boolean; created_by?: string | null },
        Partial<{ name: string; tagline: string | null; description: string | null; emoji: string | null; is_active: boolean }>
      >;
      marketplace_follows: T<
        { id: string; family_id: string; store_id: string; member_id: string; created_at: string },
        { id?: string; family_id: string; store_id: string; member_id: string },
        Partial<{ store_id: string; member_id: string }>
      >;
      marketplace_saves: T<
        { id: string; family_id: string; listing_id: string; member_id: string; created_at: string },
        { id?: string; family_id: string; listing_id: string; member_id: string },
        Partial<{ listing_id: string; member_id: string }>
      >;
      marketplace_price_history: T<
        { id: string; listing_id: string; family_id: string; old_cents: number; new_cents: number; changed_at: string },
        { id?: string; listing_id: string; family_id: string; old_cents: number; new_cents: number; changed_at?: string },
        Partial<{ old_cents: number; new_cents: number }>
      >;
      marketplace_reports: T<
        { id: string; family_id: string; listing_id: string; reporter_member: string | null; reason: string; details: string | null; status: string; resolution: string | null; reviewed_by: string | null; reviewed_at: string | null } & Stamps,
        { id?: string; family_id: string; listing_id: string; reporter_member?: string | null; reason?: string; details?: string | null; status?: string; resolution?: string | null; reviewed_by?: string | null; reviewed_at?: string | null },
        Partial<{ reason: string; details: string | null; status: string; resolution: string | null; reviewed_by: string | null; reviewed_at: string | null }>
      >;
      marketplace_saved_searches: T<
        { id: string; family_id: string; member_id: string; label: string | null; query: string | null; kind: string | null; category: string | null; max_price_cents: number | null; is_active: boolean; last_seen_at: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; label?: string | null; query?: string | null; kind?: string | null; category?: string | null; max_price_cents?: number | null; is_active?: boolean; last_seen_at?: string; created_by?: string | null },
        Partial<{ label: string | null; query: string | null; kind: string | null; category: string | null; max_price_cents: number | null; is_active: boolean; last_seen_at: string }>
      >;
      marketplace_questions: T<
        { id: string; family_id: string; listing_id: string; asker_member: string | null; question: string; answer: string | null; answered_at: string | null; answered_by: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; listing_id: string; asker_member?: string | null; question: string; answer?: string | null; answered_at?: string | null; answered_by?: string | null; created_by?: string | null },
        Partial<{ asker_member: string | null; question: string; answer: string | null; answered_at: string | null; answered_by: string | null }>
      >;
      marketplace_collections: T<
        { id: string; family_id: string; name: string; description: string | null; emoji: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; description?: string | null; emoji?: string | null; created_by?: string | null },
        Partial<{ name: string; description: string | null; emoji: string | null }>
      >;
      marketplace_collection_items: T<
        { id: string; family_id: string; collection_id: string; listing_id: string; created_at: string },
        { id?: string; family_id: string; collection_id: string; listing_id: string },
        Partial<{ collection_id: string; listing_id: string }>
      >;
      marketplace_orders: T<
        { id: string; family_id: string; listing_id: string; buyer_member: string | null; seller_member: string | null; kind: string; status: string; amount_cents: number; starts_on: string | null; ends_on: string | null; notes: string | null; due_reminder_sent_at: string | null; overdue_notified_at: string | null; returned_at: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; listing_id: string; buyer_member?: string | null; seller_member?: string | null; kind?: string; status?: string; amount_cents?: number; starts_on?: string | null; ends_on?: string | null; notes?: string | null; due_reminder_sent_at?: string | null; overdue_notified_at?: string | null; returned_at?: string | null; created_by?: string | null },
        Partial<{ buyer_member: string | null; seller_member: string | null; kind: string; status: string; amount_cents: number; starts_on: string | null; ends_on: string | null; notes: string | null; due_reminder_sent_at: string | null; overdue_notified_at: string | null; returned_at: string | null }>
      >;
      marketplace_handoffs: T<
        { id: string; order_id: string; family_id: string; listing_id: string | null; proposed_by: string | null; proposer_role: string; meet_at: string | null; location_label: string | null; location_kind: string; status: string; confirm_code: string | null; confirmed_at: string | null; completed_at: string | null; calendar_event_id: string | null; notes: string | null } & Stamps,
        { id?: string; order_id: string; family_id: string; listing_id?: string | null; proposed_by?: string | null; proposer_role?: string; meet_at?: string | null; location_label?: string | null; location_kind?: string; status?: string; confirm_code?: string | null; confirmed_at?: string | null; completed_at?: string | null; calendar_event_id?: string | null; notes?: string | null },
        Partial<{ proposed_by: string | null; proposer_role: string; meet_at: string | null; location_label: string | null; location_kind: string; status: string; confirm_code: string | null; confirmed_at: string | null; completed_at: string | null; calendar_event_id: string | null; notes: string | null }>
      >;
      marketplace_reviews: T<
        { id: string; family_id: string; order_id: string | null; listing_id: string | null; reviewer_member: string | null; reviewee_member: string | null; role: string; rating: number; comment: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; order_id?: string | null; listing_id?: string | null; reviewer_member?: string | null; reviewee_member?: string | null; role?: string; rating?: number; comment?: string | null; created_by?: string | null },
        Partial<{ role: string; rating: number; comment: string | null }>
      >;
      feedback_ideas: T<
        { id: string; author_id: string | null; author_name: string; family_id: string | null; title: string; problem: string | null; body: string | null; category: string; impact: string; audience: string; kind: string; image_url: string | null; status: string; admin_note: string | null; vote_count: number; comment_count: number; pinned: boolean; github_issue_number: number | null; github_issue_url: string | null; github_state: string | null; github_synced_at: string | null } & Stamps,
        { id?: string; author_id?: string | null; author_name?: string; family_id?: string | null; title: string; problem?: string | null; body?: string | null; category?: string; impact?: string; audience?: string; kind?: string; image_url?: string | null; status?: string; admin_note?: string | null; vote_count?: number; comment_count?: number; pinned?: boolean; github_issue_number?: number | null; github_issue_url?: string | null; github_state?: string | null; github_synced_at?: string | null },
        Partial<{ title: string; problem: string | null; body: string | null; category: string; impact: string; audience: string; kind: string; image_url: string | null; status: string; admin_note: string | null; pinned: boolean; github_issue_number: number | null; github_issue_url: string | null; github_state: string | null; github_synced_at: string | null }>
      >;
      admin_notifications: T<
        { id: string; kind: string; title: string; body: string | null; url: string | null; related_type: string | null; related_id: string | null; meta: Json; is_read: boolean; created_at: string },
        { id?: string; kind?: string; title: string; body?: string | null; url?: string | null; related_type?: string | null; related_id?: string | null; meta?: Json; is_read?: boolean },
        Partial<{ kind: string; title: string; body: string | null; url: string | null; is_read: boolean }>
      >;
      family_contact_channels: T<
        { family_id: string; email_local: string | null; phone_number: string | null; phone_number_sid: string | null; provisioning_status: string; ai_concierge_enabled: boolean; ai_greeting: string | null; forward_to_phone: string | null } & Stamps,
        { family_id: string; email_local?: string | null; phone_number?: string | null; phone_number_sid?: string | null; provisioning_status?: string; ai_concierge_enabled?: boolean; ai_greeting?: string | null; forward_to_phone?: string | null },
        Partial<{ email_local: string | null; phone_number: string | null; phone_number_sid: string | null; provisioning_status: string; ai_concierge_enabled: boolean; ai_greeting: string | null; forward_to_phone: string | null }>
      >;
      family_inbox_messages: T<
        { id: string; family_id: string; channel: string; direction: string; from_addr: string | null; to_addr: string | null; subject: string | null; body: string | null; ai_summary: string | null; ai_intent: string | null; ai_handled: boolean; status: string; provider_ref: string | null; occurred_at: string; created_at: string },
        { id?: string; family_id: string; channel: string; direction?: string; from_addr?: string | null; to_addr?: string | null; subject?: string | null; body?: string | null; ai_summary?: string | null; ai_intent?: string | null; ai_handled?: boolean; status?: string; provider_ref?: string | null; occurred_at?: string },
        Partial<{ channel: string; direction: string; from_addr: string | null; to_addr: string | null; subject: string | null; body: string | null; ai_summary: string | null; ai_intent: string | null; ai_handled: boolean; status: string }>
      >;
      feedback_votes: T<
        { id: string; idea_id: string; user_id: string; created_at: string },
        { id?: string; idea_id: string; user_id: string },
        Partial<{ idea_id: string; user_id: string }>
      >;
      feedback_comments: T<
        { id: string; idea_id: string; author_id: string | null; author_name: string; is_team: boolean; body: string } & Stamps,
        { id?: string; idea_id: string; author_id?: string | null; author_name?: string; is_team?: boolean; body: string },
        Partial<{ author_name: string; is_team: boolean; body: string }>
      >;
      voice_commands: T<
        { id: string; family_id: string; member_id: string | null; transcript: string; resolved_kind: string | null; action_table: string | null; action_count: number; status: string; created_by: string | null; created_at: string },
        { id?: string; family_id: string; member_id?: string | null; transcript: string; resolved_kind?: string | null; action_table?: string | null; action_count?: number; status?: string; created_by?: string | null },
        Partial<{ member_id: string | null; transcript: string; resolved_kind: string | null; action_table: string | null; action_count: number; status: string }>
      >;
      // `source`/`confidence`/`expires_at` are 0265. `source` is intentionally
      // absent from the Update shape: provenance is set once, at the write
      // that created the row, and an edit must not be able to change it.
      family_facts: T<
        { id: string; family_id: string; member_id: string | null; category: string; label: string; value: string; notes: string | null; is_pinned: boolean; source: string; confidence: number | null; expires_at: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; category?: string; label: string; value: string; notes?: string | null; is_pinned?: boolean; source?: string; confidence?: number | null; expires_at?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; category: string; label: string; value: string; notes: string | null; is_pinned: boolean; confidence: number | null; expires_at: string | null }>
      >;
      // `expires_at` is 0268: a suggestion offered with a deadline keeps it
      // through acceptance, rather than becoming a permanent fact.
      family_playbook_suggestions: T<
        { id: string; family_id: string; member_id: string | null; category: string; label: string; value: string; evidence: string | null; confidence: number; expires_at: string | null; signature: string; status: string; fact_id: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; category?: string; label: string; value: string; evidence?: string | null; confidence?: number; expires_at?: string | null; signature: string; status?: string; fact_id?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; category: string; label: string; value: string; evidence: string | null; confidence: number; expires_at: string | null; status: string; fact_id: string | null }>
      >;
      family_model_dirty: T<
        { family_id: string; dirty: boolean; reason: string | null; marked_at: string; refreshed_at: string | null },
        { family_id: string; dirty?: boolean; reason?: string | null; marked_at?: string; refreshed_at?: string | null },
        Partial<{ dirty: boolean; reason: string | null; marked_at: string; refreshed_at: string | null }>
      >;
      onboarding_events: T<
        { id: string; user_id: string | null; session_id: string; step: string; phase: string; duration_ms: number | null; meta: Json; created_at: string },
        { id?: string; user_id?: string | null; session_id: string; step: string; phase?: string; duration_ms?: number | null; meta?: Json },
        Partial<{ user_id: string | null; session_id: string; step: string; phase: string; duration_ms: number | null; meta: Json }>
      >;
      onboarding_imports: T<
        { id: string; family_id: string; source: string; event_count: number; today_count: number; conflict_count: number; action_count: number; time_saved_minutes: number; brief: Json; created_by: string | null; created_at: string; onboarding_key: string | null },
        { id?: string; family_id: string; source?: string; event_count?: number; today_count?: number; conflict_count?: number; action_count?: number; time_saved_minutes?: number; brief?: Json; created_by?: string | null; onboarding_key?: string | null },
        Partial<{ source: string; event_count: number; today_count: number; conflict_count: number; action_count: number; time_saved_minutes: number; brief: Json; onboarding_key: string | null }>
      >;
      meal_ideas: T<
        { id: string; title: string; cuisine: string; effort: string; prep_minutes: number; tags: string[]; description: string | null; is_active: boolean; created_at: string },
        { id?: string; title: string; cuisine?: string; effort?: string; prep_minutes?: number; tags?: string[]; description?: string | null; is_active?: boolean },
        Partial<{ title: string; cuisine: string; effort: string; prep_minutes: number; tags: string[]; description: string | null; is_active: boolean }>
      >;
      home_briefs: T<
        { id: string; family_id: string; as_of_date: string; is_sparse: boolean; readiness_pct: number; week_count: number; conflict_count: number; dinner_count: number; time_saved_minutes: number; headline: string | null; brief: Json; kind: HomeBriefKind; handled: Json; delivered_at: string | null; created_by: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; as_of_date?: string; is_sparse?: boolean; readiness_pct?: number; week_count?: number; conflict_count?: number; dinner_count?: number; time_saved_minutes?: number; headline?: string | null; brief?: Json; kind?: HomeBriefKind; handled?: Json; delivered_at?: string | null; created_by?: string | null },
        Partial<{ as_of_date: string; is_sparse: boolean; readiness_pct: number; week_count: number; conflict_count: number; dinner_count: number; time_saved_minutes: number; headline: string | null; brief: Json; kind: HomeBriefKind; handled: Json; delivered_at: string | null }>
      >;
      daily_insights: T<
        { id: string; family_id: string; as_of_date: string; kind: string; title: string; detail: string | null; href: string | null; impact: number; status: string; member_id: string | null; created_by: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; as_of_date?: string; kind: string; title: string; detail?: string | null; href?: string | null; impact?: number; status?: string; member_id?: string | null; created_by?: string | null },
        Partial<{ kind: string; title: string; detail: string | null; href: string | null; impact: number; status: string; member_id: string | null }>
      >;
      activation_events: T<
        { id: string; user_id: string | null; family_id: string | null; session_id: string; milestone: string; session_index: number; ms_since_signup: number | null; meta: Record<string, unknown>; created_at: string },
        { id?: string; user_id?: string | null; family_id?: string | null; session_id: string; milestone: string; session_index?: number; ms_since_signup?: number | null; meta?: Record<string, unknown> },
        Partial<{ user_id: string | null; family_id: string | null; session_id: string; milestone: string; session_index: number; ms_since_signup: number | null; meta: Record<string, unknown> }>
      >;
      life_event_plans: T<
        { id: string; family_id: string; template_key: string; title: string; event_date: string | null; status: string; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; template_key: string; title: string; event_date?: string | null; status?: string; notes?: string | null; created_by?: string | null },
        Partial<{ template_key: string; title: string; event_date: string | null; status: string; notes: string | null }>
      >;
      life_event_plan_items: T<
        { id: string; family_id: string; plan_id: string; title: string; category: string; due_on: string | null; is_done: boolean; sort: number; note: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; plan_id: string; title: string; category?: string; due_on?: string | null; is_done?: boolean; sort?: number; note?: string | null; created_by?: string | null },
        Partial<{ title: string; category: string; due_on: string | null; is_done: boolean; sort: number; note: string | null }>
      >;
      experience_audits: T<
        { id: string; family_id: string; surface_key: string; surface_label: string; category: string; audited_on: string; empty_state: number | null; error_recovery: number | null; transitions: number | null; performance: number | null; accessibility: number | null; consistency: number | null; score: number | null; grade: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; surface_key: string; surface_label: string; category?: string; audited_on?: string; empty_state?: number | null; error_recovery?: number | null; transitions?: number | null; performance?: number | null; accessibility?: number | null; consistency?: number | null; score?: number | null; grade?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ surface_key: string; surface_label: string; category: string; audited_on: string; empty_state: number | null; error_recovery: number | null; transitions: number | null; performance: number | null; accessibility: number | null; consistency: number | null; score: number | null; grade: string | null; notes: string | null }>
      >;
      ai_feedback: T<
        { id: string; family_id: string; member_id: string | null; surface: string; ref_kind: string | null; ref_id: string | null; signal: string; reason: string | null; note: string | null; created_by: string | null; created_at: string },
        { id?: string; family_id: string; member_id?: string | null; surface: string; ref_kind?: string | null; ref_id?: string | null; signal: string; reason?: string | null; note?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; surface: string; ref_kind: string | null; ref_id: string | null; signal: string; reason: string | null; note: string | null }>
      >;
      family_signals: T<
        { id: string; family_id: string; kind: string; subject_key: string; title: string; detail: string | null; score: number; evidence: Json; status: string; member_id: string | null; first_seen_at: string; last_seen_at: string; created_by: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; kind: string; subject_key: string; title: string; detail?: string | null; score?: number; evidence?: Json; status?: string; member_id?: string | null; first_seen_at?: string; last_seen_at?: string; created_by?: string | null },
        Partial<{ kind: string; subject_key: string; title: string; detail: string | null; score: number; evidence: Json; status: string; member_id: string | null; last_seen_at: string }>
      >;
      twin_simulations: T<
        { id: string; family_id: string; member_id: string | null; activity_name: string; verdict: string; weekly_hours: number; input: Json; dimensions: Json; created_by: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; member_id?: string | null; activity_name: string; verdict?: string; weekly_hours?: number; input?: Json; dimensions?: Json; created_by?: string | null },
        Partial<{ member_id: string | null; activity_name: string; verdict: string; weekly_hours: number; input: Json; dimensions: Json }>
      >;
      moment_activations: T<
        { id: string; family_id: string; moment_key: string; as_of_date: string; status: string; reason: string | null; priority: number; created_by: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; moment_key: string; as_of_date?: string; status?: string; reason?: string | null; priority?: number; created_by?: string | null },
        Partial<{ moment_key: string; status: string; reason: string | null; priority: number }>
      >;
      reasoning_snapshots: T<
        { id: string; family_id: string; as_of_date: string; all_clear: boolean; attention_count: number; report: Json; created_by: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; as_of_date?: string; all_clear?: boolean; attention_count?: number; report?: Json; created_by?: string | null },
        Partial<{ as_of_date: string; all_clear: boolean; attention_count: number; report: Json }>
      >;
      journey_events: T<
        { id: string; family_id: string; member_id: string | null; journey: string; phase: string; step: number; session_id: string; duration_ms: number | null; created_at: string },
        { id?: string; family_id: string; member_id?: string | null; journey: string; phase?: string; step?: number; session_id: string; duration_ms?: number | null },
        Partial<{ member_id: string | null; phase: string; step: number; duration_ms: number | null }>
      >;
      agent_activity: T<
        { id: string; family_id: string; member_id: string | null; agent: string; kind: string; title: string; detail: string | null; href: string | null; severity: string; status: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; agent: string; kind?: string; title: string; detail?: string | null; href?: string | null; severity?: string; status?: string; created_by?: string | null },
        Partial<{ member_id: string | null; agent: string; kind: string; title: string; detail: string | null; href: string | null; severity: string; status: string }>
      >;
      family_connections: T<
        { id: string; family_id: string; provider: string; category: string; status: string; account_label: string | null; external_account_id: string | null; last_synced_at: string | null; error_message: string | null; metadata: Json; created_by: string | null } & Stamps,
        { id?: string; family_id: string; provider: string; category?: string; status?: string; account_label?: string | null; external_account_id?: string | null; last_synced_at?: string | null; error_message?: string | null; metadata?: Json; created_by?: string | null },
        Partial<{ provider: string; category: string; status: string; account_label: string | null; external_account_id: string | null; last_synced_at: string | null; error_message: string | null; metadata: Json }>
      >;
      graph_entities: T<
        { id: string; family_id: string; kind: string; name: string; ref_table: string | null; ref_id: string | null; attributes: Json; created_by: string | null } & Stamps,
        { id?: string; family_id: string; kind?: string; name: string; ref_table?: string | null; ref_id?: string | null; attributes?: Json; created_by?: string | null },
        Partial<{ kind: string; name: string; ref_table: string | null; ref_id: string | null; attributes: Json }>
      >;
      graph_edges: T<
        { id: string; family_id: string; source_id: string; target_id: string; relation: string; weight: number; attributes: Json; created_by: string | null } & Stamps,
        { id?: string; family_id: string; source_id: string; target_id: string; relation: string; weight?: number; attributes?: Json; created_by?: string | null },
        Partial<{ source_id: string; target_id: string; relation: string; weight: number; attributes: Json }>
      >;
      network_contributions: T<
        { family_id: string; cohort_key: string; features: Json; metrics: Json; scopes: Json; updated_at: string },
        { family_id: string; cohort_key: string; features?: Json; metrics?: Json; scopes?: Json },
        Partial<{ cohort_key: string; features: Json; metrics: Json; scopes: Json }>
      >;
      network_aggregates: T<
        { id: string; scope: string; cohort_key: string; metric: string; value: string; count: number; cohort_size: number; computed_at: string },
        { id?: string; scope: string; cohort_key: string; metric: string; value: string; count: number; cohort_size: number; computed_at?: string },
        Partial<{ scope: string; cohort_key: string; metric: string; value: string; count: number; cohort_size: number }>
      >;
      network_consent: T<
        { family_id: string; enabled: boolean; scopes: Json; consented_by: string | null; consented_at: string | null } & Stamps,
        { family_id: string; enabled?: boolean; scopes?: Json; consented_by?: string | null; consented_at?: string | null },
        Partial<{ enabled: boolean; scopes: Json; consented_by: string | null; consented_at: string | null }>
      >;
      prep_plans: T<
        { id: string; family_id: string; signal_kind: string; signal_id: string; title: string; target_date: string; urgency: string; status: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; signal_kind: string; signal_id: string; title: string; target_date: string; urgency?: string; status?: string; created_by?: string | null },
        Partial<{ signal_kind: string; signal_id: string; title: string; target_date: string; urgency: string; status: string }>
      >;
      prep_plan_steps: T<
        { id: string; family_id: string; plan_id: string; label: string; href: string | null; due_date: string | null; lead_days: number; is_done: boolean; sort_order: number } & Stamps,
        { id?: string; family_id: string; plan_id: string; label: string; href?: string | null; due_date?: string | null; lead_days?: number; is_done?: boolean; sort_order?: number },
        Partial<{ label: string; href: string | null; due_date: string | null; lead_days: number; is_done: boolean; sort_order: number }>
      >;
      family_decisions: T<
        { id: string; family_id: string; question: string; detail: string | null; status: string; budget_cents: number | null; max_travel_minutes: number | null; weights: Json; decided_option_id: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; question: string; detail?: string | null; status?: string; budget_cents?: number | null; max_travel_minutes?: number | null; weights?: Json; decided_option_id?: string | null; created_by?: string | null },
        Partial<{ question: string; detail: string | null; status: string; budget_cents: number | null; max_travel_minutes: number | null; weights: Json; decided_option_id: string | null }>
      >;
      decision_options: T<
        { id: string; family_id: string; decision_id: string; label: string; cost_cents: number | null; time_minutes: number | null; travel_minutes: number | null; load_delta: number | null; benefit: number | null; score: number | null; rationale: string | null; feasible: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; decision_id: string; label: string; cost_cents?: number | null; time_minutes?: number | null; travel_minutes?: number | null; load_delta?: number | null; benefit?: number | null; score?: number | null; rationale?: string | null; feasible?: boolean; created_by?: string | null },
        Partial<{ label: string; cost_cents: number | null; time_minutes: number | null; travel_minutes: number | null; load_delta: number | null; benefit: number | null; score: number | null; rationale: string | null; feasible: boolean }>
      >;
      family_operating_index: T<
        { id: string; family_id: string; as_of_date: string; composite: number; band: string; dimensions: Json; suggestions: Json; created_at: string; updated_at: string },
        { id?: string; family_id: string; as_of_date?: string; composite: number; band?: string; dimensions?: Json; suggestions?: Json },
        Partial<{ as_of_date: string; composite: number; band: string; dimensions: Json; suggestions: Json }>
      >;
      location_events: T<
        { id: string; family_id: string; member_id: string; place_id: string | null; place_name: string | null; event_type: LocationEventType; latitude: number | null; longitude: number | null; occurred_at: string; created_at: string },
        { id?: string; family_id: string; member_id: string; place_id?: string | null; place_name?: string | null; event_type?: LocationEventType; latitude?: number | null; longitude?: number | null; occurred_at?: string },
        Partial<{ place_id: string | null; place_name: string | null; event_type: LocationEventType }>
      >;
      wishlist_items: T<
        { id: string; family_id: string; member_id: string; title: string; url: string | null; price: number | null; priority: WishPriority; notes: string | null; claimed_by: string | null; claimed_at: string | null; is_purchased: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; title: string; url?: string | null; price?: number | null; priority?: WishPriority; notes?: string | null; claimed_by?: string | null; claimed_at?: string | null; is_purchased?: boolean; created_by?: string | null },
        Partial<{ member_id: string; title: string; url: string | null; price: number | null; priority: WishPriority; notes: string | null; claimed_by: string | null; claimed_at: string | null; is_purchased: boolean }>
      >;
      relationship_profile: T<
        { id: string; family_id: string; created_by: string | null; partner_name: string | null; partner_member_id: string | null; interests: string[]; love_languages: string[]; gift_budget_cents: number | null; notes: string | null } & Stamps,
        { id?: string; family_id: string; created_by?: string | null; partner_name?: string | null; partner_member_id?: string | null; interests?: string[]; love_languages?: string[]; gift_budget_cents?: number | null; notes?: string | null },
        Partial<{ partner_name: string | null; partner_member_id: string | null; interests: string[]; love_languages: string[]; gift_budget_cents: number | null; notes: string | null }>
      >;
      relationship_dates: T<
        { id: string; family_id: string; created_by: string | null; kind: RelationshipDateKind; title: string; event_date: string; recurs_annually: boolean; reminder_days_before: number; member_id: string | null; partner_name: string | null; location: string | null; notes: string | null; calendar_event_id: string | null; status: RelationshipDateStatus } & Stamps,
        { id?: string; family_id: string; created_by?: string | null; kind?: RelationshipDateKind; title: string; event_date: string; recurs_annually?: boolean; reminder_days_before?: number; member_id?: string | null; partner_name?: string | null; location?: string | null; notes?: string | null; calendar_event_id?: string | null; status?: RelationshipDateStatus },
        Partial<{ kind: RelationshipDateKind; title: string; event_date: string; recurs_annually: boolean; reminder_days_before: number; member_id: string | null; partner_name: string | null; location: string | null; notes: string | null; calendar_event_id: string | null; status: RelationshipDateStatus }>
      >;
      relationship_gift_ideas: T<
        { id: string; family_id: string; created_by: string | null; for_member_id: string | null; for_name: string | null; title: string; url: string | null; price_cents: number | null; occasion: string | null; reason: string | null; source: RelationshipGiftSource; wishlist_item_id: string | null; status: RelationshipGiftStatus } & Stamps,
        { id?: string; family_id: string; created_by?: string | null; for_member_id?: string | null; for_name?: string | null; title: string; url?: string | null; price_cents?: number | null; occasion?: string | null; reason?: string | null; source?: RelationshipGiftSource; wishlist_item_id?: string | null; status?: RelationshipGiftStatus },
        Partial<{ for_member_id: string | null; for_name: string | null; title: string; url: string | null; price_cents: number | null; occasion: string | null; reason: string | null; source: RelationshipGiftSource; wishlist_item_id: string | null; status: RelationshipGiftStatus }>
      >;
      stripe_settings: T<
        { id: string; enabled: boolean; publishable_key: string | null; secret_key: string | null; webhook_secret: string | null; connect_account_id: string | null; service_fee_cents: number; service_fee_price_id: string | null; updated_by: string | null } & Stamps,
        { id?: string; enabled?: boolean; publishable_key?: string | null; secret_key?: string | null; webhook_secret?: string | null; connect_account_id?: string | null; service_fee_cents?: number; service_fee_price_id?: string | null; updated_by?: string | null },
        Partial<{ enabled: boolean; publishable_key: string | null; secret_key: string | null; webhook_secret: string | null; connect_account_id: string | null; service_fee_cents: number; service_fee_price_id: string | null; updated_by: string | null }>
      >;
      family_announcements: T<
        { id: string; family_id: string; author_id: string | null; author_member_id: string | null; title: string; body: string | null; is_pinned: boolean } & Stamps,
        { id?: string; family_id: string; author_id?: string | null; author_member_id?: string | null; title: string; body?: string | null; is_pinned?: boolean },
        Partial<{ title: string; body: string | null; is_pinned: boolean; author_member_id: string | null }>
      >;
      announcement_reads: T<
        { id: string; announcement_id: string; family_id: string; member_id: string; read_at: string },
        { id?: string; announcement_id: string; family_id: string; member_id: string; read_at?: string },
        Partial<{ read_at: string }>
      >;
      event_rsvps: T<
        { id: string; event_id: string; family_id: string; member_id: string; status: string } & Stamps,
        { id?: string; event_id: string; family_id: string; member_id: string; status?: string },
        Partial<{ status: string }>
      >;
      family_dates: T<
        { id: string; family_id: string; member_id: string | null; title: string; kind: string; event_date: string; notes: string | null; remind_days: number; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; title: string; kind?: string; event_date: string; notes?: string | null; remind_days?: number; created_by?: string | null },
        Partial<{ member_id: string | null; title: string; kind: string; event_date: string; notes: string | null; remind_days: number }>
      >;
      ab_experiments: T<
        { id: string; key: string; name: string; hypothesis: string | null; status: string; variants: Json; metric: string; winner: string | null; created_by: string | null; updated_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; key: string; name: string; hypothesis?: string | null; status?: string; variants?: Json; metric?: string; winner?: string | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null },
        Partial<{ name: string; hypothesis: string | null; status: string; variants: Json; metric: string; winner: string | null; updated_by: string | null; deleted_at: string | null }>
      >;
      ab_events: T<
        { id: string; experiment_key: string; variant_key: string; kind: string; visitor_id: string | null; created_at: string },
        { id?: string; experiment_key: string; variant_key: string; kind: string; visitor_id?: string | null; created_at?: string },
        Partial<{ kind: string }>
      >;
      opportunities: T<
        { id: string; family_id: string; member_id: string | null; title: string; category: string | null; url: string | null; cost: number | null; opens_at: string | null; deadline: string | null; status: OpportunityStatus; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; title: string; category?: string | null; url?: string | null; cost?: number | null; opens_at?: string | null; deadline?: string | null; status?: OpportunityStatus; notes?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; title: string; category: string | null; url: string | null; cost: number | null; opens_at: string | null; deadline: string | null; status: OpportunityStatus; notes: string | null }>
      >;
      health_providers: T<
        { id: string; family_id: string; member_id: string | null; kind: RecordKind; name: string; specialty: string | null; practice_name: string | null; phone: string | null; fax: string | null; email: string | null; address: string | null; is_primary: boolean; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; kind?: RecordKind; name: string; specialty?: string | null; practice_name?: string | null; phone?: string | null; fax?: string | null; email?: string | null; address?: string | null; is_primary?: boolean; notes?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; kind: RecordKind; name: string; specialty: string | null; practice_name: string | null; phone: string | null; fax: string | null; email: string | null; address: string | null; is_primary: boolean; notes: string | null }>
      >;
      insurance_policies: T<
        { id: string; family_id: string; member_id: string | null; kind: RecordKind; insurer: string; plan_name: string | null; plan_type: string | null; policy_number: string | null; group_number: string | null; rx_bin: string | null; rx_pcn: string | null; rx_group: string | null; customer_service_phone: string | null; front_image_path: string | null; back_image_path: string | null; effective_date: string | null; is_primary: boolean; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; kind?: RecordKind; insurer: string; plan_name?: string | null; plan_type?: string | null; policy_number?: string | null; group_number?: string | null; rx_bin?: string | null; rx_pcn?: string | null; rx_group?: string | null; customer_service_phone?: string | null; front_image_path?: string | null; back_image_path?: string | null; effective_date?: string | null; is_primary?: boolean; notes?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; kind: RecordKind; insurer: string; plan_name: string | null; plan_type: string | null; policy_number: string | null; group_number: string | null; rx_bin: string | null; rx_pcn: string | null; rx_group: string | null; customer_service_phone: string | null; front_image_path: string | null; back_image_path: string | null; effective_date: string | null; is_primary: boolean; notes: string | null }>
      >;
      medical_profiles: T<
        { id: string; family_id: string; member_id: string; blood_type: string | null; allergies: string | null; conditions: string | null; current_medications: string | null; primary_physician: string | null; preferred_pharmacy: string | null; pharmacy_phone: string | null; emergency_contact_name: string | null; emergency_contact_phone: string | null; emergency_contact_relation: string | null; immunizations: string | null; dental_notes: string | null; notes: string | null; updated_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; blood_type?: string | null; allergies?: string | null; conditions?: string | null; current_medications?: string | null; primary_physician?: string | null; preferred_pharmacy?: string | null; pharmacy_phone?: string | null; emergency_contact_name?: string | null; emergency_contact_phone?: string | null; emergency_contact_relation?: string | null; immunizations?: string | null; dental_notes?: string | null; notes?: string | null; updated_by?: string | null },
        Partial<{ blood_type: string | null; allergies: string | null; conditions: string | null; current_medications: string | null; primary_physician: string | null; preferred_pharmacy: string | null; pharmacy_phone: string | null; emergency_contact_name: string | null; emergency_contact_phone: string | null; emergency_contact_relation: string | null; immunizations: string | null; dental_notes: string | null; notes: string | null; updated_by: string | null }>
      >;
      home_assets: T<
        { id: string; family_id: string; name: string; category: string | null; location: string | null; brand: string | null; model: string | null; purchased_on: string | null; warranty_until: string | null; notes: string | null; home_id: string | null; serial_number: string | null; installed_on: string | null; filter_size: string | null; purchase_price: number | null; expected_life_years: number | null; condition: string | null; last_serviced_on: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; category?: string | null; location?: string | null; brand?: string | null; model?: string | null; purchased_on?: string | null; warranty_until?: string | null; notes?: string | null; home_id?: string | null; serial_number?: string | null; installed_on?: string | null; filter_size?: string | null; purchase_price?: number | null; expected_life_years?: number | null; condition?: string | null; last_serviced_on?: string | null; created_by?: string | null },
        Partial<{ name: string; category: string | null; location: string | null; brand: string | null; model: string | null; purchased_on: string | null; warranty_until: string | null; notes: string | null; home_id: string | null; serial_number: string | null; installed_on: string | null; filter_size: string | null; purchase_price: number | null; expected_life_years: number | null; condition: string | null; last_serviced_on: string | null }>
      >;
      maintenance_tasks: T<
        { id: string; family_id: string; asset_id: string | null; title: string; description: string | null; status: TaskStatus; priority: Priority; recurrence: RecurrenceFreq; interval_days: number | null; due_at: string | null; completed_at: string | null; assignee_id: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; asset_id?: string | null; title: string; description?: string | null; status?: TaskStatus; priority?: Priority; recurrence?: RecurrenceFreq; interval_days?: number | null; due_at?: string | null; assignee_id?: string | null; created_by?: string | null },
        Partial<{ asset_id: string | null; title: string; description: string | null; status: TaskStatus; priority: Priority; recurrence: RecurrenceFreq; interval_days: number | null; due_at: string | null; completed_at: string | null; assignee_id: string | null }>
      >;
      documents: T<
        { id: string; family_id: string; title: string; category: string | null; storage_path: string; mime_type: string | null; size_bytes: number | null; expires_at: string | null; member_id: string | null; asset_id: string | null; is_favorite: boolean; is_secure: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title: string; category?: string | null; storage_path: string; mime_type?: string | null; size_bytes?: number | null; expires_at?: string | null; member_id?: string | null; asset_id?: string | null; is_favorite?: boolean; is_secure?: boolean; created_by?: string | null },
        Partial<{ title: string; category: string | null; expires_at: string | null; member_id: string | null; asset_id: string | null; is_favorite: boolean; is_secure: boolean }>
      >;
      notes: T<
        { id: string; family_id: string; title: string | null; body: string; is_pinned: boolean; checklist: Json | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title?: string | null; body?: string; is_pinned?: boolean; checklist?: Json | null; created_by?: string | null },
        Partial<{ title: string | null; body: string; is_pinned: boolean; checklist: Json | null }>
      >;
      journal_entries: T<
        { id: string; family_id: string; member_id: string | null; entry_date: string; mood: 'great' | 'good' | 'okay' | 'low' | 'stressed' | null; title: string | null; body: string; prompt: string | null; tags: string[]; is_private: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; entry_date?: string; mood?: 'great' | 'good' | 'okay' | 'low' | 'stressed' | null; title?: string | null; body?: string; prompt?: string | null; tags?: string[]; is_private?: boolean; created_by?: string | null },
        Partial<{ member_id: string | null; entry_date: string; mood: 'great' | 'good' | 'okay' | 'low' | 'stressed' | null; title: string | null; body: string; prompt: string | null; tags: string[]; is_private: boolean }>
      >;
      family_wallets: T<
        { id: string; family_id: string; currency: string; mode: 'ledger' | 'treasury'; is_active: boolean; disclosures_accepted_at: string | null; disclosures_accepted_by: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; currency?: string; mode?: 'ledger' | 'treasury'; is_active?: boolean; disclosures_accepted_at?: string | null; disclosures_accepted_by?: string | null; created_by?: string | null },
        Partial<{ currency: string; mode: 'ledger' | 'treasury'; is_active: boolean; disclosures_accepted_at: string | null; disclosures_accepted_by: string | null }>
      >;
      child_wallets: T<
        { id: string; family_id: string; member_id: string; is_active: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; is_active?: boolean; created_by?: string | null },
        Partial<{ is_active: boolean }>
      >;
      wallet_buckets: T<
        { id: string; family_id: string; child_wallet_id: string; kind: 'spend' | 'save' | 'give' | 'invest' | 'goal'; label: string; sort_order: number } & Stamps,
        { id?: string; family_id: string; child_wallet_id: string; kind: 'spend' | 'save' | 'give' | 'invest' | 'goal'; label: string; sort_order?: number },
        Partial<{ label: string; sort_order: number }>
      >;
      wallet_transactions: T<
        { id: string; family_id: string; child_wallet_id: string | null; bucket_id: string | null; type: WalletTxnType; status: WalletTxnStatus; direction: 'credit' | 'debit'; amount_cents: number; currency: string; description: string | null; related_type: string | null; related_id: string | null; reverses_id: string | null; stripe_ref: string | null; metadata: Json; created_by: string | null; approved_by: string | null } & Stamps,
        { id?: string; family_id: string; child_wallet_id?: string | null; bucket_id?: string | null; type: WalletTxnType; status?: WalletTxnStatus; direction: 'credit' | 'debit'; amount_cents: number; currency?: string; description?: string | null; related_type?: string | null; related_id?: string | null; reverses_id?: string | null; stripe_ref?: string | null; metadata?: Json; created_by?: string | null; approved_by?: string | null },
        Partial<{ status: WalletTxnStatus; description: string | null; approved_by: string | null; metadata: Json }>
      >;
      wallet_rules: T<
        { id: string; family_id: string; child_wallet_id: string | null; split: Json; auto_accept_gifts: boolean; require_approval_over_cents: number; created_by: string | null } & Stamps,
        { id?: string; family_id: string; child_wallet_id?: string | null; split?: Json; auto_accept_gifts?: boolean; require_approval_over_cents?: number; created_by?: string | null },
        Partial<{ split: Json; auto_accept_gifts: boolean; require_approval_over_cents: number }>
      >;
      wallet_goals: T<
        { id: string; family_id: string; child_wallet_id: string | null; title: string; kind: string; target_cents: number; saved_cents: number; target_date: string | null; status: string; image_url: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; child_wallet_id?: string | null; title: string; kind?: string; target_cents: number; saved_cents?: number; target_date?: string | null; status?: string; image_url?: string | null; created_by?: string | null },
        Partial<{ title: string; kind: string; target_cents: number; saved_cents: number; target_date: string | null; status: string; image_url: string | null }>
      >;
      pay_handles: T<
        { id: string; family_id: string; child_wallet_id: string | null; handle: string; is_active: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; child_wallet_id?: string | null; handle: string; is_active?: boolean; created_by?: string | null },
        Partial<{ child_wallet_id: string | null; handle: string; is_active: boolean }>
      >;
      gift_links: T<
        { id: string; family_id: string; child_wallet_id: string | null; token: string; occasion: string | null; message: string | null; suggested_cents: number[]; is_active: boolean; expires_at: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; child_wallet_id?: string | null; token: string; occasion?: string | null; message?: string | null; suggested_cents?: number[]; is_active?: boolean; expires_at?: string | null; created_by?: string | null },
        Partial<{ occasion: string | null; message: string | null; suggested_cents: number[]; is_active: boolean; expires_at: string | null }>
      >;
      gift_payments: T<
        { id: string; family_id: string; gift_link_id: string | null; child_wallet_id: string | null; giver_name: string | null; giver_email: string | null; amount_cents: number; message: string | null; occasion: string | null; status: WalletTxnStatus; stripe_ref: string | null; applied_txn_id: string | null } & Stamps,
        { id?: string; family_id: string; gift_link_id?: string | null; child_wallet_id?: string | null; giver_name?: string | null; giver_email?: string | null; amount_cents: number; message?: string | null; occasion?: string | null; status?: WalletTxnStatus; stripe_ref?: string | null; applied_txn_id?: string | null },
        Partial<{ status: WalletTxnStatus; applied_txn_id: string | null; stripe_ref: string | null }>
      >;
      allowance_rules: T<
        { id: string; family_id: string; child_wallet_id: string; amount_cents: number; cadence: 'weekly' | 'biweekly' | 'monthly'; split: Json | null; is_active: boolean; next_run_on: string | null; last_run_on: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; child_wallet_id: string; amount_cents: number; cadence?: 'weekly' | 'biweekly' | 'monthly'; split?: Json | null; is_active?: boolean; next_run_on?: string | null; last_run_on?: string | null; created_by?: string | null },
        Partial<{ amount_cents: number; cadence: 'weekly' | 'biweekly' | 'monthly'; split: Json | null; is_active: boolean; next_run_on: string | null; last_run_on: string | null }>
      >;
      babysitter_profiles: T<
        { id: string; family_id: string; name: string; phone: string | null; email: string | null; rate_cents: number | null; notes: string | null; is_active: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; phone?: string | null; email?: string | null; rate_cents?: number | null; notes?: string | null; is_active?: boolean; created_by?: string | null },
        Partial<{ name: string; phone: string | null; email: string | null; rate_cents: number | null; notes: string | null; is_active: boolean }>
      >;
      babysitter_payments: T<
        { id: string; family_id: string; babysitter_id: string | null; event_id: string | null; hours: number | null; rate_cents: number | null; tip_cents: number; amount_cents: number; status: WalletTxnStatus; stripe_ref: string | null; receipt_url: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; babysitter_id?: string | null; event_id?: string | null; hours?: number | null; rate_cents?: number | null; tip_cents?: number; amount_cents: number; status?: WalletTxnStatus; stripe_ref?: string | null; receipt_url?: string | null; created_by?: string | null },
        Partial<{ status: WalletTxnStatus; tip_cents: number; receipt_url: string | null }>
      >;
      parent_approvals: T<
        { id: string; family_id: string; kind: string; ref_type: string | null; ref_id: string | null; amount_cents: number | null; status: 'pending' | 'approved' | 'rejected'; requested_by: string | null; decided_by: string | null; decided_at: string | null; note: string | null } & Stamps,
        { id?: string; family_id: string; kind: string; ref_type?: string | null; ref_id?: string | null; amount_cents?: number | null; status?: 'pending' | 'approved' | 'rejected'; requested_by?: string | null; decided_by?: string | null; decided_at?: string | null; note?: string | null },
        Partial<{ status: 'pending' | 'approved' | 'rejected'; decided_by: string | null; decided_at: string | null; note: string | null }>
      >;
      wallet_audit_logs: T<
        { id: string; family_id: string; actor_user_id: string | null; action: string; entity_type: string | null; entity_id: string | null; detail: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; actor_user_id?: string | null; action: string; entity_type?: string | null; entity_id?: string | null; detail?: string | null; metadata?: Json },
        Partial<{ detail: string | null; metadata: Json }>
      >;
      compliance_disclosures: T<
        { id: string; family_id: string; kind: string; version: string; accepted_by: string | null; accepted_at: string; ip_address: string | null } & Stamps,
        { id?: string; family_id: string; kind: string; version: string; accepted_by?: string | null; accepted_at?: string; ip_address?: string | null },
        Partial<{ kind: string; version: string }>
      >;
      feature_flags: T<
        { key: string; enabled: boolean; description: string | null; updated_at: string },
        { key: string; enabled?: boolean; description?: string | null },
        Partial<{ enabled: boolean; description: string | null }>
      >;
      social_reader_sources: T<
        { id: string; family_id: string; platform: string; display_name: string; handle: string | null; account_count: number; category: SocialCategory; is_active: boolean; sort_order: number; created_by: string | null } & Stamps,
        { id?: string; family_id: string; platform: string; display_name: string; handle?: string | null; account_count?: number; category?: SocialCategory; is_active?: boolean; sort_order?: number; created_by?: string | null },
        Partial<{ display_name: string; handle: string | null; account_count: number; category: SocialCategory; is_active: boolean; sort_order: number }>
      >;
      social_reader_items: T<
        { id: string; family_id: string; source_id: string | null; platform: string; author_name: string; author_handle: string | null; avatar_url: string | null; content: string | null; media_urls: string[]; thumbnail_url: string | null; permalink: string | null; kind: SocialItemKind; duration_label: string | null; category: SocialCategory; verified: boolean; is_favorite: boolean; is_read: boolean; external_id: string | null; posted_at: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; source_id?: string | null; platform: string; author_name: string; author_handle?: string | null; avatar_url?: string | null; content?: string | null; media_urls?: string[]; thumbnail_url?: string | null; permalink?: string | null; kind?: SocialItemKind; duration_label?: string | null; category?: SocialCategory; verified?: boolean; is_favorite?: boolean; is_read?: boolean; external_id?: string | null; posted_at?: string; created_by?: string | null },
        Partial<{ content: string | null; media_urls: string[]; thumbnail_url: string | null; permalink: string | null; kind: SocialItemKind; duration_label: string | null; category: SocialCategory; verified: boolean; is_favorite: boolean; is_read: boolean }>
      >;
      invest_assets: T<
        { id: string; symbol: string; name: string; kind: string; emoji: string; description: string | null; price_cents: number; risk_level: string; is_active: boolean; sort_order: number } & Stamps,
        { id?: string; symbol: string; name: string; kind?: string; emoji?: string; description?: string | null; price_cents: number; risk_level?: string; is_active?: boolean; sort_order?: number },
        Partial<{ name: string; kind: string; emoji: string; description: string | null; price_cents: number; risk_level: string; is_active: boolean; sort_order: number }>
      >;
      invest_holdings: T<
        { id: string; family_id: string; child_wallet_id: string; asset_id: string; shares: number; avg_cost_cents: number } & Stamps,
        { id?: string; family_id: string; child_wallet_id: string; asset_id: string; shares?: number; avg_cost_cents?: number },
        Partial<{ shares: number; avg_cost_cents: number }>
      >;
      invest_orders: T<
        { id: string; family_id: string; child_wallet_id: string; asset_id: string; side: InvestOrderSide; shares: number; price_cents: number; amount_cents: number; status: InvestOrderStatus; txn_id: string | null; requested_by: string | null; decided_by: string | null; decided_at: string | null } & Stamps,
        { id?: string; family_id: string; child_wallet_id: string; asset_id: string; side: InvestOrderSide; shares: number; price_cents: number; amount_cents: number; status?: InvestOrderStatus; txn_id?: string | null; requested_by?: string | null; decided_by?: string | null; decided_at?: string | null },
        Partial<{ status: InvestOrderStatus; txn_id: string | null; decided_by: string | null; decided_at: string | null }>
      >;
      family_currencies: T<
        { id: string; family_id: string; name: string; emoji: string; unit_label: string | null; is_active: boolean; sort_order: number; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; emoji?: string; unit_label?: string | null; is_active?: boolean; sort_order?: number; created_by?: string | null },
        Partial<{ name: string; emoji: string; unit_label: string | null; is_active: boolean; sort_order: number }>
      >;
      currency_transactions: T<
        { id: string; family_id: string; currency_id: string; member_id: string; direction: EconomyDirection; amount: number; reason: string | null; related_type: string | null; related_id: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; currency_id: string; member_id: string; direction: EconomyDirection; amount: number; reason?: string | null; related_type?: string | null; related_id?: string | null; created_by?: string | null },
        Partial<{ reason: string | null }>
      >;
      economy_rewards: T<
        { id: string; family_id: string; currency_id: string; title: string; emoji: string; cost: number; stock: number | null; is_active: boolean; sort_order: number; created_by: string | null } & Stamps,
        { id?: string; family_id: string; currency_id: string; title: string; emoji?: string; cost: number; stock?: number | null; is_active?: boolean; sort_order?: number; created_by?: string | null },
        Partial<{ title: string; emoji: string; cost: number; stock: number | null; is_active: boolean; sort_order: number }>
      >;
      economy_redemptions: T<
        { id: string; family_id: string; reward_id: string | null; currency_id: string; member_id: string; title: string; cost: number; status: EconomyRedemptionStatus; txn_id: string | null; requested_by: string | null; decided_by: string | null; decided_at: string | null; note: string | null } & Stamps,
        { id?: string; family_id: string; reward_id?: string | null; currency_id: string; member_id: string; title: string; cost: number; status?: EconomyRedemptionStatus; txn_id?: string | null; requested_by?: string | null; decided_by?: string | null; decided_at?: string | null; note?: string | null },
        Partial<{ status: EconomyRedemptionStatus; txn_id: string | null; decided_by: string | null; decided_at: string | null; note: string | null }>
      >;
      stripe_connected_accounts: T<
        { id: string; family_id: string; stripe_account_id: string; status: StripeAccountStatus; charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean; treasury_enabled: boolean; card_issuing_enabled: boolean; requirements_due: Json; onboarded_by: string | null } & Stamps,
        { id?: string; family_id: string; stripe_account_id: string; status?: StripeAccountStatus; charges_enabled?: boolean; payouts_enabled?: boolean; details_submitted?: boolean; treasury_enabled?: boolean; card_issuing_enabled?: boolean; requirements_due?: Json; onboarded_by?: string | null },
        Partial<{ status: StripeAccountStatus; charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean; treasury_enabled: boolean; card_issuing_enabled: boolean; requirements_due: Json }>
      >;
      stripe_financial_accounts: T<
        { id: string; family_id: string; connected_account_id: string; stripe_financial_account_id: string; status: string; cached_balance_cents: number; cached_at: string | null } & Stamps,
        { id?: string; family_id: string; connected_account_id: string; stripe_financial_account_id: string; status?: string; cached_balance_cents?: number; cached_at?: string | null },
        Partial<{ status: string; cached_balance_cents: number; cached_at: string | null }>
      >;
      stripe_cardholders: T<
        { id: string; family_id: string; member_id: string; child_wallet_id: string | null; stripe_cardholder_id: string; status: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; child_wallet_id?: string | null; stripe_cardholder_id: string; status?: string; created_by?: string | null },
        Partial<{ status: string }>
      >;
      stripe_issuing_cards: T<
        { id: string; family_id: string; child_wallet_id: string; cardholder_id: string; stripe_card_id: string; type: 'virtual' | 'physical'; status: 'pending' | 'active' | 'inactive' | 'canceled'; last4: string | null; brand: string | null; exp_month: number | null; exp_year: number | null; design_id: string | null; spend_limit_cents: number | null; spend_window: string; blocked_categories: string[]; is_frozen: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; child_wallet_id: string; cardholder_id: string; stripe_card_id: string; type?: 'virtual' | 'physical'; status?: 'pending' | 'active' | 'inactive' | 'canceled'; last4?: string | null; brand?: string | null; exp_month?: number | null; exp_year?: number | null; design_id?: string | null; spend_limit_cents?: number | null; spend_window?: string; blocked_categories?: string[]; is_frozen?: boolean; created_by?: string | null },
        Partial<{ status: 'pending' | 'active' | 'inactive' | 'canceled'; last4: string | null; brand: string | null; exp_month: number | null; exp_year: number | null; design_id: string | null; spend_limit_cents: number | null; spend_window: string; blocked_categories: string[]; is_frozen: boolean }>
      >;
      stripe_authorizations: T<
        { id: string; family_id: string; card_id: string | null; child_wallet_id: string | null; stripe_authorization_id: string; amount_cents: number; merchant_name: string | null; merchant_category: string | null; outcome: 'approved' | 'declined'; decline_reason: string | null; txn_id: string | null } & Stamps,
        { id?: string; family_id: string; card_id?: string | null; child_wallet_id?: string | null; stripe_authorization_id: string; amount_cents?: number; merchant_name?: string | null; merchant_category?: string | null; outcome: 'approved' | 'declined'; decline_reason?: string | null; txn_id?: string | null },
        Partial<{ outcome: 'approved' | 'declined'; decline_reason: string | null; txn_id: string | null }>
      >;
      stripe_card_designs: T<
        { id: string; name: string; description: string | null; preview_url: string | null; stripe_personalization_design_id: string | null; status: string; is_active: boolean; sort_order: number } & Stamps,
        { id?: string; name: string; description?: string | null; preview_url?: string | null; stripe_personalization_design_id?: string | null; status?: string; is_active?: boolean; sort_order?: number },
        Partial<{ name: string; description: string | null; preview_url: string | null; stripe_personalization_design_id: string | null; status: string; is_active: boolean; sort_order: number }>
      >;
      stripe_webhook_events: T<
        { id: string; stripe_event_id: string; type: string; status: string; error: string | null; payload_summary: Json; processing_started_at: string | null; claim_token: string | null; created_at: string },
        { id?: string; stripe_event_id: string; type: string; status?: string; error?: string | null; payload_summary?: Json; processing_started_at?: string | null; claim_token?: string | null },
        Partial<{ status: string; error: string | null; processing_started_at: string | null; claim_token: string | null }>
      >;
      dashboard_layouts: T<
        { id: string; family_id: string; user_id: string | null; scope: 'user' | 'family'; device_context: 'all' | 'mobile' | 'tablet' | 'desktop'; feature_keys: string[]; is_active: boolean; created_by: string | null; updated_by: string | null; metadata: Json; deleted_at: string | null } & Stamps,
        { id?: string; family_id: string; user_id?: string | null; scope?: 'user' | 'family'; device_context?: 'all' | 'mobile' | 'tablet' | 'desktop'; feature_keys?: string[]; is_active?: boolean; created_by?: string | null; updated_by?: string | null; metadata?: Json; deleted_at?: string | null },
        Partial<{ user_id: string | null; scope: 'user' | 'family'; device_context: 'all' | 'mobile' | 'tablet' | 'desktop'; feature_keys: string[]; is_active: boolean; updated_by: string | null; metadata: Json; deleted_at: string | null }>
      >;
      dashboard_layout_events: T<
        { id: string; family_id: string; user_id: string | null; action: string; feature_key: string | null; metadata: Json; created_at: string },
        { id?: string; family_id: string; user_id?: string | null; action: string; feature_key?: string | null; metadata?: Json },
        Partial<{ metadata: Json }>
      >;
      family_dashboard_settings: T<
        { family_id: string; allow_child_customization: boolean; lock_to_family_default: boolean; updated_by: string | null } & Stamps,
        { family_id: string; allow_child_customization?: boolean; lock_to_family_default?: boolean; updated_by?: string | null },
        Partial<{ allow_child_customization: boolean; lock_to_family_default: boolean; updated_by: string | null }>
      >;
      family_tree_nodes: T<
        { id: string; family_id: string; parent_node_id: string | null; member_id: string | null; name: string; relationship: string; birth_year: number | null; death_year: number | null; birth_place: string | null; photo_url: string | null; bio: string | null; metadata: Json; created_by: string | null } & Stamps,
        { id?: string; family_id: string; parent_node_id?: string | null; member_id?: string | null; name: string; relationship?: string; birth_year?: number | null; death_year?: number | null; birth_place?: string | null; photo_url?: string | null; bio?: string | null; metadata?: Json; created_by?: string | null },
        Partial<{ parent_node_id: string | null; member_id: string | null; name: string; relationship: string; birth_year: number | null; death_year: number | null; birth_place: string | null; photo_url: string | null; bio: string | null; metadata: Json }>
      >;
      family_insurance_policies: T<
        { id: string; family_id: string; policy_type: InsurancePolicyType; insurer: string; policy_number: string | null; member_id: string | null; premium_amount: number | null; premium_frequency: PremiumFrequency; coverage_amount: number | null; deductible: number | null; effective_date: string | null; renewal_date: string | null; agent_name: string | null; agent_phone: string | null; claim_phone: string | null; document_path: string | null; notes: string | null; is_active: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; policy_type?: InsurancePolicyType; insurer: string; policy_number?: string | null; member_id?: string | null; premium_amount?: number | null; premium_frequency?: PremiumFrequency; coverage_amount?: number | null; deductible?: number | null; effective_date?: string | null; renewal_date?: string | null; agent_name?: string | null; agent_phone?: string | null; claim_phone?: string | null; document_path?: string | null; notes?: string | null; is_active?: boolean; created_by?: string | null },
        Partial<{ policy_type: InsurancePolicyType; insurer: string; policy_number: string | null; member_id: string | null; premium_amount: number | null; premium_frequency: PremiumFrequency; coverage_amount: number | null; deductible: number | null; effective_date: string | null; renewal_date: string | null; agent_name: string | null; agent_phone: string | null; claim_phone: string | null; document_path: string | null; notes: string | null; is_active: boolean }>
      >;
      pets: T<
        { id: string; family_id: string; name: string; species: PetSpecies; breed: string | null; birthday: string | null; adoption_date: string | null; weight_kg: number | null; color: string | null; microchip_id: string | null; photo_path: string | null; vet_name: string | null; vet_phone: string | null; notes: string | null; is_active: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; species?: PetSpecies; breed?: string | null; birthday?: string | null; adoption_date?: string | null; weight_kg?: number | null; color?: string | null; microchip_id?: string | null; photo_path?: string | null; vet_name?: string | null; vet_phone?: string | null; notes?: string | null; is_active?: boolean; created_by?: string | null },
        Partial<{ name: string; species: PetSpecies; breed: string | null; birthday: string | null; adoption_date: string | null; weight_kg: number | null; color: string | null; microchip_id: string | null; photo_path: string | null; vet_name: string | null; vet_phone: string | null; notes: string | null; is_active: boolean }>
      >;
      pet_care_records: T<
        { id: string; family_id: string; pet_id: string; kind: PetCareKind; title: string; record_date: string; next_due: string | null; dose: string | null; weight_kg: number | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; pet_id: string; kind?: PetCareKind; title: string; record_date?: string; next_due?: string | null; dose?: string | null; weight_kg?: number | null; notes?: string | null; created_by?: string | null },
        Partial<{ pet_id: string; kind: PetCareKind; title: string; record_date: string; next_due: string | null; dose: string | null; weight_kg: number | null; notes: string | null }>
      >;
      family_polls: T<
        { id: string; family_id: string; vacation_id: string | null; question: string; description: string | null; kind: string; status: string; closes_at: string | null; decision_category: string; budget_cents: number | null; required_tags: string[]; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id?: string | null; question: string; description?: string | null; kind?: string; status?: string; closes_at?: string | null; decision_category?: string; budget_cents?: number | null; required_tags?: string[]; created_by?: string | null },
        Partial<{ vacation_id: string | null; question: string; description: string | null; kind: string; status: string; closes_at: string | null; decision_category: string; budget_cents: number | null; required_tags: string[] }>
      >;
      family_poll_options: T<
        { id: string; family_id: string; poll_id: string; label: string; sort: number; cost_cents: number | null; travel_minutes: number | null; tags: string[]; created_at: string },
        { id?: string; family_id: string; poll_id: string; label: string; sort?: number; cost_cents?: number | null; travel_minutes?: number | null; tags?: string[] },
        Partial<{ label: string; sort: number; cost_cents: number | null; travel_minutes: number | null; tags: string[] }>
      >;
      family_poll_votes: T<
        { id: string; family_id: string; poll_id: string; option_id: string; member_id: string; created_at: string },
        { id?: string; family_id: string; poll_id: string; option_id: string; member_id: string },
        Partial<{ option_id: string; member_id: string }>
      >;
      trip_memories: T<
        { id: string; family_id: string; vacation_id: string | null; title: string; memory_date: string; note: string | null; location: string | null; photo_path: string | null; member_id: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id?: string | null; title: string; memory_date?: string; note?: string | null; location?: string | null; photo_path?: string | null; member_id?: string | null; created_by?: string | null },
        Partial<{ vacation_id: string | null; title: string; memory_date: string; note: string | null; location: string | null; photo_path: string | null; member_id: string | null }>
      >;
      behavior_logs: T<
        { id: string; family_id: string; member_id: string | null; kind: string; category: string; note: string | null; points: number; occurred_at: string; logged_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; kind?: string; category?: string; note?: string | null; points?: number; occurred_at?: string; logged_by?: string | null },
        Partial<{ member_id: string | null; kind: string; category: string; note: string | null; points: number; occurred_at: string }>
      >;
      screen_time_entries: T<
        { id: string; family_id: string; member_id: string | null; entry_date: string; minutes: number; category: string; device: string | null; note: string | null; logged_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; entry_date?: string; minutes: number; category?: string; device?: string | null; note?: string | null; logged_by?: string | null },
        Partial<{ member_id: string | null; entry_date: string; minutes: number; category: string; device: string | null; note: string | null }>
      >;
      screen_time_limits: T<
        { id: string; family_id: string; member_id: string; daily_minutes: number; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; daily_minutes: number; created_by?: string | null },
        Partial<{ daily_minutes: number }>
      >;
      expense_splits: T<
        { id: string; family_id: string; description: string; total_cents: number; category: string | null; paid_by: string | null; spent_on: string; note: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; description: string; total_cents: number; category?: string | null; paid_by?: string | null; spent_on?: string; note?: string | null; created_by?: string | null },
        Partial<{ description: string; total_cents: number; category: string | null; paid_by: string | null; spent_on: string; note: string | null }>
      >;
      expense_split_shares: T<
        { id: string; family_id: string; split_id: string; member_id: string; share_cents: number; settled: boolean; settled_at: string | null } & Stamps,
        { id?: string; family_id: string; split_id: string; member_id: string; share_cents: number; settled?: boolean; settled_at?: string | null },
        Partial<{ share_cents: number; settled: boolean; settled_at: string | null }>
      >;
      subscriptions_tracked: T<
        { id: string; family_id: string; name: string; cost_cents: number; cadence: string; category: string | null; status: string; next_charge: string | null; last_used: string | null; note: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; cost_cents: number; cadence?: string; category?: string | null; status?: string; next_charge?: string | null; last_used?: string | null; note?: string | null; created_by?: string | null },
        Partial<{ name: string; cost_cents: number; cadence: string; category: string | null; status: string; next_charge: string | null; last_used: string | null; note: string | null }>
      >;
      tax_documents: T<
        { id: string; family_id: string; tax_year: number; category: string; name: string; storage_path: string | null; amount_cents: number | null; member_id: string | null; note: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; tax_year: number; category?: string; name: string; storage_path?: string | null; amount_cents?: number | null; member_id?: string | null; note?: string | null; created_by?: string | null },
        Partial<{ tax_year: number; category: string; name: string; storage_path: string | null; amount_cents: number | null; member_id: string | null; note: string | null }>
      >;
      utility_bills: T<
        { id: string; family_id: string; kind: string; provider: string | null; period_month: string; amount_cents: number; usage: number | null; unit: string | null; note: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; kind?: string; provider?: string | null; period_month?: string; amount_cents?: number; usage?: number | null; unit?: string | null; note?: string | null; created_by?: string | null },
        Partial<{ kind: string; provider: string | null; period_month: string; amount_cents: number; usage: number | null; unit: string | null; note: string | null }>
      >;
      household_info: T<
        { id: string; family_id: string; category: string; label: string; value: string | null; note: string | null; is_sensitive: boolean; sort: number; created_by: string | null } & Stamps,
        { id?: string; family_id: string; category?: string; label: string; value?: string | null; note?: string | null; is_sensitive?: boolean; sort?: number; created_by?: string | null },
        Partial<{ category: string; label: string; value: string | null; note: string | null; is_sensitive: boolean; sort: number }>
      >;
      home_security_events: T<
        { id: string; family_id: string; kind: string; severity: string; title: string; detail: string | null; occurred_at: string; resolved: boolean; resolved_at: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; kind?: string; severity?: string; title: string; detail?: string | null; occurred_at?: string; resolved?: boolean; resolved_at?: string | null; created_by?: string | null },
        Partial<{ kind: string; severity: string; title: string; detail: string | null; occurred_at: string; resolved: boolean; resolved_at: string | null }>
      >;
      smart_devices: T<
        { id: string; family_id: string; name: string; type: string; room: string | null; brand: string | null; integration: string; status: string; last_state: string | null; note: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; type?: string; room?: string | null; brand?: string | null; integration?: string; status?: string; last_state?: string | null; note?: string | null; created_by?: string | null },
        Partial<{ name: string; type: string; room: string | null; brand: string | null; integration: string; status: string; last_state: string | null; note: string | null }>
      >;
      goals: T<
        { id: string; family_id: string; title: string; description: string | null; target_date: string | null; progress: number; is_complete: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title: string; description?: string | null; target_date?: string | null; progress?: number; is_complete?: boolean; created_by?: string | null },
        Partial<{ title: string; description: string | null; target_date: string | null; progress: number; is_complete: boolean }>
      >;
      habits: T<
        { id: string; family_id: string; member_id: string | null; title: string; description: string | null; icon: string; color: string; cadence: 'daily' | 'weekly'; target_per_period: number; reminder_time: string | null; weekdays: number[]; is_active: boolean; archived_at: string | null; sort_order: number; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; title: string; description?: string | null; icon?: string; color?: string; cadence?: 'daily' | 'weekly'; target_per_period?: number; reminder_time?: string | null; weekdays?: number[]; is_active?: boolean; archived_at?: string | null; sort_order?: number; created_by?: string | null },
        Partial<{ member_id: string | null; title: string; description: string | null; icon: string; color: string; cadence: 'daily' | 'weekly'; target_per_period: number; reminder_time: string | null; weekdays: number[]; is_active: boolean; archived_at: string | null; sort_order: number }>
      >;
      habit_logs: T<
        { id: string; family_id: string; habit_id: string; member_id: string | null; log_date: string; count: number; note: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; habit_id: string; member_id?: string | null; log_date?: string; count?: number; note?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; log_date: string; count: number; note: string | null }>
      >;
      autopilot_suggestions: T<
        { id: string; family_id: string; member_id: string | null; kind: string; title: string; detail: string | null; confidence: number; urgency: number; status: 'open' | 'approved' | 'executed' | 'auto_executed' | 'dismissed' | 'snoozed'; action_type: string | null; action_label: string | null; payload: Json; source_kind: string | null; source_id: string | null; dedupe_key: string; expires_at: string | null; resolved_at: string | null; resolved_by: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; kind: string; title: string; detail?: string | null; confidence?: number; urgency?: number; status?: 'open' | 'approved' | 'executed' | 'auto_executed' | 'dismissed' | 'snoozed'; action_type?: string | null; action_label?: string | null; payload?: Json; source_kind?: string | null; source_id?: string | null; dedupe_key: string; expires_at?: string | null; resolved_at?: string | null; resolved_by?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; kind: string; title: string; detail: string | null; confidence: number; urgency: number; status: 'open' | 'approved' | 'executed' | 'auto_executed' | 'dismissed' | 'snoozed'; action_type: string | null; action_label: string | null; payload: Json; source_kind: string | null; source_id: string | null; dedupe_key: string; expires_at: string | null; resolved_at: string | null; resolved_by: string | null }>
      >;
      reminders: T<
        { id: string; family_id: string; title: string; notes: string | null; remind_at: string; recurrence: RecurrenceFreq; is_done: boolean; member_id: string | null; related_type: string | null; related_id: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title: string; notes?: string | null; remind_at: string; recurrence?: RecurrenceFreq; is_done?: boolean; member_id?: string | null; related_type?: string | null; related_id?: string | null; created_by?: string | null },
        Partial<{ title: string; notes: string | null; remind_at: string; recurrence: RecurrenceFreq; is_done: boolean }>
      >;
      notifications: T<
        { id: string; family_id: string; user_id: string | null; type: NotificationType; title: string; body: string | null; related_type: string | null; related_id: string | null; is_read: boolean; send_at: string; sent_at: string | null; pushed_at: string | null; created_at: string },
        { id?: string; family_id: string; user_id?: string | null; type: NotificationType; title: string; body?: string | null; related_type?: string | null; related_id?: string | null; is_read?: boolean; send_at?: string; sent_at?: string | null; pushed_at?: string | null },
        Partial<{ is_read: boolean; sent_at: string | null; pushed_at: string | null }>
      >;
      ai_conversations: T<
        { id: string; family_id: string; user_id: string | null; title: string; provider: string; model: string | null; state: AiConversationState; prompt_version: string | null } & Stamps,
        { id?: string; family_id: string; user_id?: string | null; title?: string; provider?: string; model?: string | null; state?: AiConversationState; prompt_version?: string | null },
        Partial<{ title: string; model: string | null; state: AiConversationState; prompt_version: string | null }>
      >;
      ai_messages: T<
        { id: string; family_id: string; conversation_id: string; role: AiRole; content: string; tool_calls: Json | null; tool_results: Json | null; structured_content: Json | null; model: string | null; usage: Json | null; request_id: string | null; sender_member_id: string | null; created_at: string },
        { id?: string; family_id: string; conversation_id: string; role: AiRole; content?: string; tool_calls?: Json | null; tool_results?: Json | null; structured_content?: Json | null; model?: string | null; usage?: Json | null; request_id?: string | null; sender_member_id?: string | null },
        Partial<{ content: string; tool_calls: Json | null; tool_results: Json | null; structured_content: Json | null; model: string | null; usage: Json | null; request_id: string | null }>
      >;
      // ── AI runtime core (0250): request → plan → steps → run → events/tool calls.
      // The ledgers below are written exclusively by the service client; the
      // Insert/Update shapes exist for that server code, not for browser writes
      // (RLS grants members SELECT only — see 0250's header).
      ai_requests: T<
        { id: string; family_id: string; conversation_id: string | null; client_request_id: string | null; requested_by: string | null; requested_by_member_id: string | null; kind: AiRequestKind; feature: string | null; request_text: string; interpreted_intent: string | null; intent_confidence: number | null; status: AiRunState; priority: number; context_stats: Json; clarifications: Json; model: string | null; prompt_tokens: number | null; completion_tokens: number | null; latency_ms: number | null; error: string | null; source_rule_id: string | null; started_at: string | null; completed_at: string | null } & Stamps,
        { id?: string; family_id: string; conversation_id?: string | null; client_request_id?: string | null; requested_by?: string | null; requested_by_member_id?: string | null; kind?: AiRequestKind; feature?: string | null; request_text?: string; interpreted_intent?: string | null; intent_confidence?: number | null; status?: AiRunState; priority?: number; context_stats?: Json; clarifications?: Json; model?: string | null; prompt_tokens?: number | null; completion_tokens?: number | null; latency_ms?: number | null; error?: string | null; source_rule_id?: string | null; started_at?: string | null; completed_at?: string | null },
        Partial<{ status: AiRunState; interpreted_intent: string | null; intent_confidence: number | null; context_stats: Json; clarifications: Json; model: string | null; prompt_tokens: number | null; completion_tokens: number | null; latency_ms: number | null; error: string | null; started_at: string | null; completed_at: string | null }>
      >;
      ai_request_context: T<
        { request_id: string; family_id: string; snapshot: Json; sensitive_omitted: string[] } & Stamps,
        { request_id: string; family_id: string; snapshot?: Json; sensitive_omitted?: string[] },
        Partial<{ snapshot: Json; sensitive_omitted: string[] }>
      >;
      ai_plans: T<
        { id: string; family_id: string; request_id: string | null; version: number; objective: string | null; reasoning_summary: string | null; status: AiPlanStatus; risk_level: AiRiskLevel; estimated_actions: number; requires_approval: boolean; planner_model: string | null; planner_prompt_version: string | null } & Stamps,
        { id?: string; family_id: string; request_id?: string | null; version?: number; objective?: string | null; reasoning_summary?: string | null; status?: AiPlanStatus; risk_level?: AiRiskLevel; estimated_actions?: number; requires_approval?: boolean; planner_model?: string | null; planner_prompt_version?: string | null },
        Partial<{ status: AiPlanStatus; risk_level: AiRiskLevel; objective: string | null; reasoning_summary: string | null; estimated_actions: number; requires_approval: boolean }>
      >;
      ai_plan_steps: T<
        { id: string; family_id: string; plan_id: string; parent_step_id: string | null; sequence: number; step_type: AiStepType; tool_name: string | null; description: string | null; input_json: Json; dependency_ids: string[]; condition: Json | null; status: AiStepState; approval_required: boolean; approval_id: string | null; risk_level: AiRiskLevel; retry_count: number; max_retries: number; result_json: Json | null; error: string | null; started_at: string | null; completed_at: string | null } & Stamps,
        { id?: string; family_id: string; plan_id: string; parent_step_id?: string | null; sequence?: number; step_type?: AiStepType; tool_name?: string | null; description?: string | null; input_json?: Json; dependency_ids?: string[]; condition?: Json | null; status?: AiStepState; approval_required?: boolean; approval_id?: string | null; risk_level?: AiRiskLevel; retry_count?: number; max_retries?: number; result_json?: Json | null; error?: string | null; started_at?: string | null; completed_at?: string | null },
        Partial<{ status: AiStepState; approval_required: boolean; approval_id: string | null; retry_count: number; result_json: Json | null; error: string | null; started_at: string | null; completed_at: string | null; input_json: Json; description: string | null }>
      >;
      ai_run_events: T<
        { id: string; family_id: string; run_id: string; request_id: string | null; step_id: string | null; event_type: AiRunEventType; tool_name: string | null; message: string; payload: Json; actor_kind: AiActorKind; actor_member_id: string | null } & Stamps,
        { id?: string; family_id: string; run_id: string; request_id?: string | null; step_id?: string | null; event_type: AiRunEventType; tool_name?: string | null; message?: string; payload?: Json; actor_kind?: AiActorKind; actor_member_id?: string | null },
        Partial<{ message: string; payload: Json }>
      >;
      ai_tool_calls: T<
        { id: string; family_id: string; run_id: string | null; plan_step_id: string | null; request_id: string | null; conversation_id: string | null; message_id: string | null; tool_name: string; requested_by: string | null; requested_by_member_id: string | null; actor_kind: AiActorKind; inputs: Json; outputs: Json | null; state: AiToolCallState; attempt: number; locked_at: string | null; duration_ms: number | null; error: string | null; idempotency_key: string; resource_table: string | null; resource_id: string | null; finished_at: string | null } & Stamps,
        { id?: string; family_id: string; run_id?: string | null; plan_step_id?: string | null; request_id?: string | null; conversation_id?: string | null; message_id?: string | null; tool_name: string; requested_by?: string | null; requested_by_member_id?: string | null; actor_kind?: AiActorKind; inputs?: Json; outputs?: Json | null; state?: AiToolCallState; attempt?: number; locked_at?: string | null; duration_ms?: number | null; error?: string | null; idempotency_key: string; resource_table?: string | null; resource_id?: string | null; finished_at?: string | null },
        Partial<{ state: AiToolCallState; outputs: Json | null; attempt: number; locked_at: string | null; duration_ms: number | null; error: string | null; resource_table: string | null; resource_id: string | null; finished_at: string | null }>
      >;
      audit_logs: T<
        { id: string; family_id: string | null; actor_id: string | null; action: string; resource: string; resource_id: string | null; metadata: Json | null; created_at: string },
        { id?: string; family_id?: string | null; actor_id?: string | null; action: string; resource: string; resource_id?: string | null; metadata?: Json | null },
        Partial<{ metadata: Json | null }>
      >;
      billing_customers: T<
        { id: string; family_id: string; provider: string; customer_ref: string | null } & Stamps,
        { id?: string; family_id: string; provider?: string; customer_ref?: string | null },
        Partial<{ provider: string; customer_ref: string | null }>
      >;
      checkout_sessions: T<
        { id: string; session_id: string; family_id: string | null; email: string | null; name: string | null; plan: string | null; status: string; created_at: string; completed_at: string | null; abandoned_at: string | null },
        { id?: string; session_id: string; family_id?: string | null; email?: string | null; name?: string | null; plan?: string | null; status?: string; created_at?: string; completed_at?: string | null; abandoned_at?: string | null },
        Partial<{ status: string; completed_at: string | null; abandoned_at: string | null }>
      >;
      subscriptions: T<
        { id: string; family_id: string; billing_customer_id: string | null; plan: string; status: SubscriptionStatus; provider_ref: string | null; current_period_end: string | null; cancel_at_period_end: boolean; seats: number } & Stamps,
        { id?: string; family_id: string; billing_customer_id?: string | null; plan?: string; status?: SubscriptionStatus; provider_ref?: string | null; current_period_end?: string | null; cancel_at_period_end?: boolean; seats?: number },
        Partial<{ plan: string; status: SubscriptionStatus; provider_ref: string | null; current_period_end: string | null; cancel_at_period_end: boolean; seats: number }>
      >;
      // ── Financial ──────────────────────────────────────────
      financial_accounts: T<
        { id: string; family_id: string; name: string; type: AccountType; institution: string | null; last_four: string | null; balance: number; currency: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; type?: AccountType; institution?: string | null; last_four?: string | null; balance?: number; currency?: string; created_by?: string | null },
        Partial<{ name: string; type: AccountType; institution: string | null; last_four: string | null; balance: number; currency: string }>
      >;
      transactions: T<
        { id: string; family_id: string; account_id: string | null; member_id: string | null; name: string; merchant: string | null; amount: number; category: string | null; date: string; type: TransactionType; status: string; notes: string | null; idempotency_key: string | null; fingerprint: string | null; source: string; receipt_document_id: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; account_id?: string | null; member_id?: string | null; name: string; merchant?: string | null; amount: number; category?: string | null; date?: string; type?: TransactionType; status?: string; notes?: string | null; idempotency_key?: string | null; fingerprint?: string | null; source?: string; receipt_document_id?: string | null; created_by?: string | null },
        Partial<{ account_id: string | null; member_id: string | null; name: string; merchant: string | null; amount: number; category: string | null; date: string; type: TransactionType; status: string; notes: string | null }>
      >;
      wallet_cards: T<
        { id: string; family_id: string; member_id: string | null; name: string; brand: string; kind: string; last_four: string | null; available_cents: number; limit_cents: number | null; color: string | null; is_active: boolean; sort_order: number; metadata: Json; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; name: string; brand?: string; kind?: string; last_four?: string | null; available_cents?: number; limit_cents?: number | null; color?: string | null; is_active?: boolean; sort_order?: number; metadata?: Json; created_by?: string | null },
        Partial<{ member_id: string | null; name: string; brand: string; kind: string; last_four: string | null; available_cents: number; limit_cents: number | null; color: string | null; is_active: boolean; sort_order: number; metadata: Json }>
      >;
      wallet_passes: T<
        { id: string; family_id: string; member_id: string | null; name: string; kind: string; status: string | null; detail: string | null; member_no: string | null; points: number | null; expires_on: string | null; is_active: boolean; sort_order: number; metadata: Json; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; name: string; kind?: string; status?: string | null; detail?: string | null; member_no?: string | null; points?: number | null; expires_on?: string | null; is_active?: boolean; sort_order?: number; metadata?: Json; created_by?: string | null },
        Partial<{ member_id: string | null; name: string; kind: string; status: string | null; detail: string | null; member_no: string | null; points: number | null; expires_on: string | null; is_active: boolean; sort_order: number; metadata: Json }>
      >;
      wallet_rewards: T<
        { id: string; family_id: string; member_id: string | null; name: string; kind: string; balance: number; unit: string; value_cents: number; program: string | null; is_active: boolean; sort_order: number; metadata: Json; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; name: string; kind?: string; balance?: number; unit?: string; value_cents?: number; program?: string | null; is_active?: boolean; sort_order?: number; metadata?: Json; created_by?: string | null },
        Partial<{ member_id: string | null; name: string; kind: string; balance: number; unit: string; value_cents: number; program: string | null; is_active: boolean; sort_order: number; metadata: Json }>
      >;
      budgets: T<
        { id: string; family_id: string; category: string; amount: number; period: BudgetPeriod; created_by: string | null } & Stamps,
        { id?: string; family_id: string; category: string; amount: number; period?: BudgetPeriod; created_by?: string | null },
        Partial<{ category: string; amount: number; period: BudgetPeriod }>
      >;
      bills: T<
        { id: string; family_id: string; name: string; amount: number; due_date: string; is_recurring: boolean; recurrence: string | null; status: BillStatus; category: string | null; autopay: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; amount: number; due_date: string; is_recurring?: boolean; recurrence?: string | null; status?: BillStatus; category?: string | null; autopay?: boolean; created_by?: string | null },
        Partial<{ name: string; amount: number; due_date: string; is_recurring: boolean; recurrence: string | null; status: BillStatus; category: string | null; autopay: boolean }>
      >;
      savings_goals: T<
        { id: string; family_id: string; name: string; target_amount: number; current_amount: number; target_date: string | null; emoji: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; target_amount: number; current_amount?: number; target_date?: string | null; emoji?: string | null; created_by?: string | null },
        Partial<{ name: string; target_amount: number; current_amount: number; target_date: string | null; emoji: string | null }>
      >;
      // ── Health ──────────────────────────────────────────────
      health_metrics: T<
        { id: string; family_id: string; member_id: string; type: MetricType; value: number; unit: string | null; recorded_at: string; created_at: string },
        { id?: string; family_id: string; member_id: string; type: MetricType; value: number; unit?: string | null; recorded_at?: string },
        Partial<{ type: MetricType; value: number; unit: string | null; recorded_at: string }>
      >;
      health_visits: T<
        { id: string; family_id: string; member_id: string | null; provider_id: string | null; kind: string; title: string; provider_name: string | null; location: string | null; visit_date: string; reason: string | null; outcome: string | null; follow_up_date: string | null; cost_cents: number | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; provider_id?: string | null; kind?: string; title: string; provider_name?: string | null; location?: string | null; visit_date?: string; reason?: string | null; outcome?: string | null; follow_up_date?: string | null; cost_cents?: number | null; created_by?: string | null },
        Partial<{ member_id: string | null; provider_id: string | null; kind: string; title: string; provider_name: string | null; location: string | null; visit_date: string; reason: string | null; outcome: string | null; follow_up_date: string | null; cost_cents: number | null }>
      >;
      immunizations: T<
        { id: string; family_id: string; member_id: string | null; vaccine: string; dose_label: string | null; date_given: string | null; next_due_date: string | null; provider_name: string | null; lot_number: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; vaccine: string; dose_label?: string | null; date_given?: string | null; next_due_date?: string | null; provider_name?: string | null; lot_number?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; vaccine: string; dose_label: string | null; date_given: string | null; next_due_date: string | null; provider_name: string | null; lot_number: string | null; notes: string | null }>
      >;
      workout_logs: T<
        { id: string; family_id: string; member_id: string; activity: string; duration_minutes: number | null; calories: number | null; distance: number | null; notes: string | null; recorded_at: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; activity: string; duration_minutes?: number | null; calories?: number | null; distance?: number | null; notes?: string | null; recorded_at?: string; created_by?: string | null },
        Partial<{ activity: string; duration_minutes: number | null; calories: number | null; distance: number | null; notes: string | null; recorded_at: string }>
      >;
      symptom_logs: T<
        { id: string; family_id: string; member_id: string; symptom: string; severity: number; body_area: string | null; started_at: string; ended_at: string | null; status: string; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; symptom: string; severity?: number; body_area?: string | null; started_at?: string; ended_at?: string | null; status?: string; notes?: string | null; created_by?: string | null },
        Partial<{ symptom: string; severity: number; body_area: string | null; started_at: string; ended_at: string | null; status: string; notes: string | null }>
      >;
      health_goals: T<
        { id: string; family_id: string; member_id: string; metric_type: string; target: number; period: string; label: string | null; is_active: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; metric_type: string; target: number; period?: string; label?: string | null; is_active?: boolean; created_by?: string | null },
        Partial<{ metric_type: string; target: number; period: string; label: string | null; is_active: boolean }>
      >;
      // ── School ──────────────────────────────────────────────
      school_classes: T<
        { id: string; family_id: string; member_id: string; subject: string; teacher: string | null; room: string | null; time_slot: string | null; day_of_week: number | null; school_name: string | null; week_pattern: WeekPattern; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; subject: string; teacher?: string | null; room?: string | null; time_slot?: string | null; day_of_week?: number | null; school_name?: string | null; week_pattern?: WeekPattern; created_by?: string | null },
        Partial<{ subject: string; teacher: string | null; room: string | null; time_slot: string | null; day_of_week: number | null; school_name: string | null; week_pattern: WeekPattern }>
      >;
      grades: T<
        { id: string; family_id: string; member_id: string; class_id: string | null; subject: string; title: string | null; grade: string | null; grade_type: GradeType; score: number | null; max_score: number | null; date: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; class_id?: string | null; subject: string; title?: string | null; grade?: string | null; grade_type?: GradeType; score?: number | null; max_score?: number | null; date?: string; created_by?: string | null },
        Partial<{ class_id: string | null; subject: string; title: string | null; grade: string | null; grade_type: GradeType; score: number | null; max_score: number | null; date: string }>
      >;
      // ── Sports ──────────────────────────────────────────────
      teams: T<
        { id: string; family_id: string; member_id: string | null; sport: string; team_name: string; season: string | null; coach: string | null; is_active: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; sport: string; team_name: string; season?: string | null; coach?: string | null; is_active?: boolean; created_by?: string | null },
        Partial<{ member_id: string | null; sport: string; team_name: string; season: string | null; coach: string | null; is_active: boolean }>
      >;
      game_results: T<
        { id: string; family_id: string; team_id: string; opponent: string; our_score: number; their_score: number; date: string; result: GameResult; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; team_id: string; opponent: string; our_score?: number; their_score?: number; date?: string; result: GameResult; notes?: string | null; created_by?: string | null },
        Partial<{ opponent: string; our_score: number; their_score: number; date: string; result: GameResult; notes: string | null }>
      >;
      user_preferences: T<
        { user_id: string; theme: ThemePref; push_enabled: boolean; email_enabled: boolean; expo_push_token: string | null; active_family_id: string | null; default_dashboard: DashboardView; notification_prefs: Json } & Stamps,
        { user_id: string; theme?: ThemePref; push_enabled?: boolean; email_enabled?: boolean; expo_push_token?: string | null; active_family_id?: string | null; default_dashboard?: DashboardView; notification_prefs?: Json },
        Partial<{ theme: ThemePref; push_enabled: boolean; email_enabled: boolean; expo_push_token: string | null; active_family_id: string | null; default_dashboard: DashboardView; notification_prefs: Json }>
      >;
      // ── Site-wide super admin allowlist (email-keyed; readable only via is_super_admin()) ──
      super_admins: T<
        { email: string; created_at: string },
        { email: string; created_at?: string },
        Partial<{ email: string }>
      >;
      blog_posts: T<
        { id: string; slug: string; title: string; excerpt: string; author: string; published_at: string; reading_minutes: number; tags: string[]; category: string; featured: boolean; accent_color: string | null; hero_image_url: string | null; hero_image_alt: string | null; hero_image_credit: string | null; hero_image_source_url: string | null; hero_image_license: string | null; hero_image_attribution: string | null; hero_image_source_hash: string | null; body: Json; published: boolean } & Stamps,
        { id?: string; slug: string; title: string; excerpt?: string; author?: string; published_at?: string; reading_minutes?: number; tags?: string[]; category: string; featured?: boolean; accent_color?: string | null; hero_image_url?: string | null; hero_image_alt?: string | null; hero_image_credit?: string | null; hero_image_source_url?: string | null; hero_image_license?: string | null; hero_image_attribution?: string | null; hero_image_source_hash?: string | null; body?: Json; published?: boolean },
        Partial<{ slug: string; title: string; excerpt: string; author: string; published_at: string; reading_minutes: number; tags: string[]; category: string; featured: boolean; accent_color: string | null; hero_image_url: string | null; hero_image_alt: string | null; hero_image_credit: string | null; hero_image_source_url: string | null; hero_image_license: string | null; hero_image_attribution: string | null; hero_image_source_hash: string | null; body: Json; published: boolean }>
      >;
      // ── Editable "All Services" tooltip overrides (0203) ──
      service_descriptions: T<
        { service_key: string; description: string; updated_by: string | null; created_at: string; updated_at: string },
        { service_key: string; description?: string; updated_by?: string | null },
        Partial<{ description: string; updated_by: string | null }>
      >;
      // ── Blog engagement: anonymous ♥ per visitor + email subscribers (0201) ──
      blog_post_likes: T<
        { id: string; post_id: string; visitor_id: string; created_at: string },
        { id?: string; post_id: string; visitor_id: string; created_at?: string },
        Partial<{ post_id: string; visitor_id: string }>
      >;
      blog_post_saves: T<
        { id: string; post_id: string; user_id: string; created_at: string },
        { id?: string; post_id: string; user_id: string; created_at?: string },
        Partial<{ post_id: string; user_id: string }>
      >;
      blog_subscribers: T<
        { id: string; email: string; status: string; source: string; visitor_id: string | null; unsubscribe_token: string; created_at: string; updated_at: string; unsubscribed_at: string | null },
        { id?: string; email: string; status?: string; source?: string; visitor_id?: string | null; unsubscribe_token?: string; unsubscribed_at?: string | null },
        Partial<{ email: string; status: string; source: string; visitor_id: string | null; unsubscribed_at: string | null }>
      >;
      // ── Support tickets (admin console only — full schema) ────────────────
      support_tickets: T<
        {
          id: string; ticket_number: string; subject: string; description: string | null;
          category: string; priority: string; status: string;
          requester_id: string | null; requester_name: string | null; requester_email: string;
          assigned_agent_id: string | null; assigned_agent_name: string | null;
          family_id: string | null; tags: string[]; resolution_note: string | null;
          created_at: string; updated_at: string; resolved_at: string | null; closed_at: string | null;
        },
        {
          id?: string; ticket_number: string; subject: string; description?: string | null;
          category?: string; priority?: string; status?: string;
          requester_id?: string | null; requester_name?: string | null; requester_email: string;
          assigned_agent_id?: string | null; assigned_agent_name?: string | null;
          family_id?: string | null; tags?: string[]; resolution_note?: string | null;
        },
        Partial<{
          subject: string; description: string | null; category: string; priority: string; status: string;
          assigned_agent_id: string | null; assigned_agent_name: string | null;
          tags: string[]; resolution_note: string | null; resolved_at: string | null; closed_at: string | null;
        }>
      >;
      // ── Admin users (admin console roles & management) ────────────────────
      admin_users: T<
        {
          id: string; user_id: string | null; email: string; full_name: string | null;
          avatar_url: string | null; admin_role: string; permissions: string[];
          status: string; last_active_at: string | null; joined_at: string; created_at: string;
        },
        {
          id?: string; user_id?: string | null; email: string; full_name?: string | null;
          avatar_url?: string | null; admin_role?: string; permissions?: string[];
          status?: string; last_active_at?: string | null; joined_at?: string;
        },
        Partial<{
          full_name: string | null; avatar_url: string | null; admin_role: string;
          permissions: string[]; status: string; last_active_at: string | null;
        }>
      >;
      // ── Core Platform (0014) ──────────────────────────────────
      family_conversations: T<
        { id: string; family_id: string; name: string | null; kind: string; avatar_emoji: string | null; description: string | null; is_archived: boolean; member_ids: string[]; participant_ids: string[]; created_by: string | null; last_message_at: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; name?: string | null; kind?: string; avatar_emoji?: string | null; description?: string | null; is_archived?: boolean; member_ids?: string[]; participant_ids?: string[]; created_by?: string | null },
        Partial<{ name: string | null; avatar_emoji: string | null; description: string | null; is_archived: boolean; member_ids: string[]; participant_ids: string[]; last_message_at: string | null }>
      >;
      family_messages: T<
        { id: string; conversation_id: string; family_id: string; sender_id: string | null; sender_name: string | null; sender_avatar: string | null; content: string | null; kind: string; attachment_url: string | null; attachment_name: string | null; attachment_mime: string | null; reply_to_id: string | null; reactions: Json; read_by: string[]; is_pinned: boolean; deleted_at: string | null; created_at: string },
        { id?: string; conversation_id: string; family_id: string; sender_id?: string | null; sender_name?: string | null; sender_avatar?: string | null; content?: string | null; kind?: string; attachment_url?: string | null; attachment_name?: string | null; attachment_mime?: string | null; reply_to_id?: string | null; reactions?: Json; read_by?: string[] },
        Partial<{ content: string | null; reactions: Json; read_by: string[]; is_pinned: boolean; deleted_at: string | null }>
      >;
      family_albums: T<
        { id: string; family_id: string; name: string; description: string | null; cover_url: string | null; kind: string; is_shared: boolean; photo_count: number; created_by: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; name: string; description?: string | null; cover_url?: string | null; kind?: string; is_shared?: boolean; created_by?: string | null },
        Partial<{ name: string; description: string | null; cover_url: string | null; kind: string; is_shared: boolean; photo_count: number }>
      >;
      family_photos: T<
        { id: string; family_id: string; album_id: string | null; uploaded_by: string | null; storage_path: string; url: string | null; thumbnail_url: string | null; caption: string | null; taken_at: string | null; width: number | null; height: number | null; size_bytes: number | null; tags: string[]; member_tags: string[]; is_favorite: boolean; metadata: Json; media_type: string; duration_seconds: number | null; created_at: string },
        { id?: string; family_id: string; album_id?: string | null; uploaded_by?: string | null; storage_path: string; url?: string | null; thumbnail_url?: string | null; caption?: string | null; taken_at?: string | null; width?: number | null; height?: number | null; size_bytes?: number | null; tags?: string[]; member_tags?: string[]; media_type?: string; duration_seconds?: number | null },
        Partial<{ album_id: string | null; caption: string | null; tags: string[]; member_tags: string[]; is_favorite: boolean; url: string | null; media_type: string; duration_seconds: number | null }>
      >;
      family_contacts: T<
        { id: string; family_id: string; name: string; relationship: string | null; category: string; phone: string | null; phone_alt: string | null; email: string | null; address: string | null; notes: string | null; photo_url: string | null; is_emergency: boolean; birthday_month: number | null; birthday_day: number | null; tags: string[]; linked_member_id: string | null; specialty: string | null; organization: string | null; created_by: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; name: string; relationship?: string | null; category?: string; phone?: string | null; phone_alt?: string | null; email?: string | null; address?: string | null; notes?: string | null; photo_url?: string | null; is_emergency?: boolean; birthday_month?: number | null; birthday_day?: number | null; specialty?: string | null; organization?: string | null; linked_member_id?: string | null; created_by?: string | null },
        Partial<{ name: string; relationship: string | null; category: string; phone: string | null; phone_alt: string | null; email: string | null; address: string | null; notes: string | null; is_emergency: boolean; birthday_month: number | null; birthday_day: number | null; specialty: string | null; organization: string | null; linked_member_id: string | null; updated_at: string }>
      >;
      family_credentials: T<
        { id: string; family_id: string; category: string; label: string; username: string | null; secret: string; url: string | null; notes: string | null; member_id: string | null; is_favorite: boolean; created_by: string | null; created_at: string; updated_at: string; deleted_at: string | null },
        { id?: string; family_id: string; category?: string; label: string; username?: string | null; secret?: string; url?: string | null; notes?: string | null; member_id?: string | null; is_favorite?: boolean; created_by?: string | null },
        Partial<{ category: string; label: string; username: string | null; secret: string; url: string | null; notes: string | null; member_id: string | null; is_favorite: boolean; deleted_at: string | null }>
      >;
      front_desk_settings: T<
        { family_id: string; enabled: boolean; greeting: string; screening_mode: string; voicemail_enabled: boolean; forward_number: string | null; quiet_hours_start: number | null; quiet_hours_end: number | null; block_spam: boolean; block_unknown: boolean; blocked_numbers: unknown[]; allowed_numbers: unknown[]; created_at: string; updated_at: string },
        { family_id: string; enabled?: boolean; greeting?: string; screening_mode?: string; voicemail_enabled?: boolean; forward_number?: string | null; quiet_hours_start?: number | null; quiet_hours_end?: number | null; block_spam?: boolean; block_unknown?: boolean; blocked_numbers?: unknown[]; allowed_numbers?: unknown[] },
        Partial<{ enabled: boolean; greeting: string; screening_mode: string; voicemail_enabled: boolean; forward_number: string | null; quiet_hours_start: number | null; quiet_hours_end: number | null; block_spam: boolean; block_unknown: boolean; blocked_numbers: unknown[]; allowed_numbers: unknown[]; updated_at: string }>
      >;
      call_logs: T<
        { id: string; family_id: string; contact_id: string | null; caller_name: string | null; caller_number: string | null; direction: string; status: string; classification: string; priority: string; transcript: string | null; ai_summary: string | null; action_items: unknown[]; voicemail_url: string | null; duration_secs: number | null; is_read: boolean; received_at: string; created_by: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; contact_id?: string | null; caller_name?: string | null; caller_number?: string | null; direction?: string; status?: string; classification?: string; priority?: string; transcript?: string | null; ai_summary?: string | null; action_items?: unknown[]; voicemail_url?: string | null; duration_secs?: number | null; is_read?: boolean; received_at?: string; created_by?: string | null },
        Partial<{ contact_id: string | null; caller_name: string | null; caller_number: string | null; status: string; classification: string; priority: string; transcript: string | null; ai_summary: string | null; action_items: unknown[]; voicemail_url: string | null; duration_secs: number | null; is_read: boolean; updated_at: string }>
      >;
      family_ai_settings: T<
        { family_id: string; enabled: boolean; behavior: AutonomyBehaviorValue; category_behavior: Json; risk_overrides: Json; child_channels: Json; memory_enabled: boolean; quiet_hours_start: number | null; quiet_hours_end: number | null; updated_by: string | null; created_at: string; updated_at: string },
        { family_id: string; enabled?: boolean; behavior?: AutonomyBehaviorValue; category_behavior?: Json; risk_overrides?: Json; child_channels?: Json; memory_enabled?: boolean; quiet_hours_start?: number | null; quiet_hours_end?: number | null; updated_by?: string | null },
        Partial<{ enabled: boolean; behavior: AutonomyBehaviorValue; category_behavior: Json; risk_overrides: Json; child_channels: Json; memory_enabled: boolean; quiet_hours_start: number | null; quiet_hours_end: number | null; updated_by: string | null; updated_at: string }>
      >;
      trust_policies: T<
        { id: string; family_id: string; name: string; description: string | null; domain: string; capability: string; subject_kind: string; subject_role: string | null; subject_member_id: string | null; effect: string; conditions: Json; approval_model: string; required_approvals: number; priority: number; enabled: boolean; is_system: boolean; created_by: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; name: string; description?: string | null; domain?: string; capability?: string; subject_kind?: string; subject_role?: string | null; subject_member_id?: string | null; effect?: string; conditions?: Json; approval_model?: string; required_approvals?: number; priority?: number; enabled?: boolean; is_system?: boolean; created_by?: string | null },
        Partial<{ name: string; description: string | null; domain: string; capability: string; subject_kind: string; subject_role: string | null; subject_member_id: string | null; effect: string; conditions: Json; approval_model: string; required_approvals: number; priority: number; enabled: boolean; updated_at: string }>
      >;
      permission_grants: T<
        { id: string; family_id: string; member_id: string; domain: string; capability: string; effect: string; created_by: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; member_id: string; domain: string; capability: string; effect?: string; created_by?: string | null },
        Partial<{ domain: string; capability: string; effect: string; updated_at: string }>
      >;
      trust_delegations: T<
        { id: string; family_id: string; from_member_id: string; to_member_id: string; domains: string[]; reason: string | null; starts_at: string; expires_at: string; revoked_at: string | null; created_by: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; from_member_id: string; to_member_id: string; domains?: string[]; reason?: string | null; starts_at?: string; expires_at: string; revoked_at?: string | null; created_by?: string | null },
        Partial<{ domains: string[]; reason: string | null; expires_at: string; revoked_at: string | null; updated_at: string }>
      >;
      approval_requests: T<
        { id: string; family_id: string; domain: string; capability: string; requested_by_kind: string; requested_by_member_id: string | null; agent: string | null; title: string; summary: string | null; payload: Json; amount_cents: number | null; confidence: number | null; policy_id: string | null; reasoning: string | null; approval_model: string; required_approvals: number; approvals: Json; status: string; priority: string; decided_by: string | null; decided_at: string | null; expires_at: string | null; executed_at: string | null; execution_result: string | null; request_id: string | null; run_id: string | null; plan_step_id: string | null; plan_step_ids: string[]; consequences: Json; evidence: Json | null; edited_payload: Json | null; payload_kind: AiApprovalPayloadKind | null; reviewed_by: string | null; review_note: string | null; dedupe_key: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; domain: string; capability?: string; requested_by_kind?: string; requested_by_member_id?: string | null; agent?: string | null; title: string; summary?: string | null; payload?: Json; amount_cents?: number | null; confidence?: number | null; policy_id?: string | null; reasoning?: string | null; approval_model?: string; required_approvals?: number; approvals?: Json; status?: string; priority?: string; expires_at?: string | null; request_id?: string | null; run_id?: string | null; plan_step_id?: string | null; plan_step_ids?: string[]; consequences?: Json; evidence?: Json | null; edited_payload?: Json | null; payload_kind?: AiApprovalPayloadKind | null; dedupe_key?: string | null },
        Partial<{ status: string; approvals: Json; decided_by: string | null; decided_at: string | null; executed_at: string | null; execution_result: string | null; priority: string; expires_at: string | null; edited_payload: Json | null; consequences: Json; reviewed_by: string | null; review_note: string | null; request_id: string | null; payload_kind: AiApprovalPayloadKind | null; updated_at: string }>
      >;
      trust_scores: T<
        { id: string; family_id: string; actor_kind: string; actor_id: string; score: number; factors: Json; verified: boolean; interactions: number; successes: number; updated_at: string; created_at: string },
        { id?: string; family_id: string; actor_kind: string; actor_id: string; score?: number; factors?: Json; verified?: boolean; interactions?: number; successes?: number },
        Partial<{ score: number; factors: Json; verified: boolean; interactions: number; successes: number; updated_at: string }>
      >;
      emergency_sessions: T<
        { id: string; family_id: string; kind: string; reason: string | null; activated_by: string | null; activated_at: string; ended_by: string | null; ended_at: string | null; expires_at: string; elevated_domains: string[]; created_at: string; updated_at: string },
        { id?: string; family_id: string; kind?: string; reason?: string | null; activated_by?: string | null; ended_by?: string | null; ended_at?: string | null; expires_at?: string; elevated_domains?: string[] },
        Partial<{ kind: string; reason: string | null; ended_by: string | null; ended_at: string | null; expires_at: string; elevated_domains: string[]; updated_at: string }>
      >;
      trust_audit_logs: T<
        { id: string; family_id: string; actor_kind: string; actor_id: string | null; domain: string | null; capability: string | null; decision: string; reason: string | null; policy_id: string | null; confidence: number | null; approval_id: string | null; context: Json; device: string | null; created_at: string },
        { id?: string; family_id: string; actor_kind?: string; actor_id?: string | null; domain?: string | null; capability?: string | null; decision: string; reason?: string | null; policy_id?: string | null; confidence?: number | null; approval_id?: string | null; context?: Json; device?: string | null },
        Partial<{ reason: string | null; context: Json }>
      >;
      concierge_sessions: T<
        { id: string; family_id: string; created_by: string | null; title: string; kind: string; status: string; notes: string | null; ai_summary: string | null; messages: unknown[]; created_at: string; updated_at: string },
        { id?: string; family_id: string; created_by?: string | null; title?: string; kind?: string; status?: string; notes?: string | null; ai_summary?: string | null; messages?: unknown[] },
        Partial<{ title: string; kind: string; status: string; notes: string | null; ai_summary: string | null; messages: unknown[]; updated_at: string }>
      >;
      concierge_plans: T<
        { id: string; family_id: string; session_id: string | null; created_by: string | null; title: string; kind: string; description: string | null; ai_suggestion: string | null; status: string; planned_for: string | null; budget_cents: number | null; location: string | null; members: unknown[]; links: unknown[]; created_at: string; updated_at: string },
        { id?: string; family_id: string; session_id?: string | null; created_by?: string | null; title: string; kind?: string; description?: string | null; ai_suggestion?: string | null; status?: string; planned_for?: string | null; budget_cents?: number | null; location?: string | null; members?: unknown[]; links?: unknown[] },
        Partial<{ title: string; kind: string; description: string | null; ai_suggestion: string | null; status: string; planned_for: string | null; budget_cents: number | null; location: string | null; members: unknown[]; links: unknown[]; updated_at: string }>
      >;
      concierge_plan_actions: T<
        { id: string; family_id: string; plan_id: string; action_kind: string; target_table: string; target_id: string | null; detail: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; plan_id: string; action_kind: string; target_table: string; target_id?: string | null; detail?: string | null; created_by?: string | null },
        Partial<{ action_kind: string; target_table: string; target_id: string | null; detail: string | null }>
      >;
      trip_plans: T<
        { id: string; family_id: string; created_by: string | null; event_id: string | null; title: string; destination: string; dest_lat: number | null; dest_lng: number | null; start_date: string | null; end_date: string | null; members: unknown[]; interests: string | null; recommendations: Json; weather_summary: string | null; status: string; created_at: string; updated_at: string },
        { id?: string; family_id: string; created_by?: string | null; event_id?: string | null; title: string; destination: string; dest_lat?: number | null; dest_lng?: number | null; start_date?: string | null; end_date?: string | null; members?: unknown[]; interests?: string | null; recommendations?: Json; weather_summary?: string | null; status?: string },
        Partial<{ title: string; destination: string; dest_lat: number | null; dest_lng: number | null; start_date: string | null; end_date: string | null; members: unknown[]; interests: string | null; recommendations: Json; weather_summary: string | null; status: string; event_id: string | null; updated_at: string }>
      >;
      departure_plans: T<
        { id: string; family_id: string; created_by: string | null; event_id: string | null; reminder_event_id: string | null; title: string; origin: string | null; origin_lat: number | null; origin_lng: number | null; destination: string | null; dest_lat: number | null; dest_lng: number | null; event_start: string; prep_minutes: number; park_minutes: number; buffer_minutes: number; drive_seconds: number; traffic_factor: number; weather_delay_minutes: number; weather_summary: string | null; leave_by: string | null; last_checked_at: string | null; status: string; created_at: string; updated_at: string },
        { id?: string; family_id: string; created_by?: string | null; event_id?: string | null; reminder_event_id?: string | null; title: string; origin?: string | null; origin_lat?: number | null; origin_lng?: number | null; destination?: string | null; dest_lat?: number | null; dest_lng?: number | null; event_start: string; prep_minutes?: number; park_minutes?: number; buffer_minutes?: number; drive_seconds?: number; traffic_factor?: number; weather_delay_minutes?: number; weather_summary?: string | null; leave_by?: string | null; last_checked_at?: string | null; status?: string },
        Partial<{ title: string; origin: string | null; origin_lat: number | null; origin_lng: number | null; destination: string | null; dest_lat: number | null; dest_lng: number | null; event_start: string; prep_minutes: number; park_minutes: number; buffer_minutes: number; drive_seconds: number; traffic_factor: number; weather_delay_minutes: number; weather_summary: string | null; leave_by: string | null; last_checked_at: string | null; reminder_event_id: string | null; status: string; updated_at: string }>
      >;
      family_communications: T<
        { id: string; family_id: string; contact_id: string | null; thread_id: string | null; channel: string; direction: string; subject: string | null; body: string | null; summary: string | null; action_items: unknown[]; category: string; status: string; priority: string; received_at: string; created_by: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; contact_id?: string | null; thread_id?: string | null; channel?: string; direction?: string; subject?: string | null; body?: string | null; summary?: string | null; action_items?: unknown[]; category?: string; status?: string; priority?: string; received_at?: string; created_by?: string | null },
        Partial<{ contact_id: string | null; subject: string | null; body: string | null; summary: string | null; action_items: unknown[]; category: string; status: string; priority: string; received_at: string; updated_at: string }>
      >;
      family_reminders: T<
        { id: string; family_id: string; created_by: string | null; assigned_to_id: string | null; member_id: string | null; title: string; notes: string | null; kind: string; remind_at: string | null; location_name: string | null; recurrence: string; recurrence_time: string | null; recurrence_days: number[] | null; priority: string; status: string; completed_at: string | null; snoozed_until: string | null; ai_suggested: boolean; tags: string[]; url: string | null; flagged: boolean; early_reminder_minutes: number | null; image_url: string | null; subtasks: Json; list_id: string | null; idempotency_key: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; created_by?: string | null; assigned_to_id?: string | null; member_id?: string | null; title: string; notes?: string | null; kind?: string; remind_at?: string | null; location_name?: string | null; recurrence?: string; priority?: string; status?: string; ai_suggested?: boolean; tags?: string[]; url?: string | null; flagged?: boolean; early_reminder_minutes?: number | null; image_url?: string | null; subtasks?: Json; idempotency_key?: string | null; list_id?: string | null },
        Partial<{ title: string; notes: string | null; kind: string; remind_at: string | null; location_name: string | null; recurrence: string; priority: string; status: string; completed_at: string | null; snoozed_until: string | null; assigned_to_id: string | null; member_id: string | null; tags: string[]; url: string | null; flagged: boolean; early_reminder_minutes: number | null; image_url: string | null; subtasks: Json; list_id: string | null; updated_at: string }>
      >;
      reminder_lists: T<
        { id: string; family_id: string; created_by: string | null; name: string; color: string; icon: string; sort_order: number } & Stamps,
        { id?: string; family_id: string; created_by?: string | null; name: string; color?: string; icon?: string; sort_order?: number },
        Partial<{ name: string; color: string; icon: string; sort_order: number }>
      >;
      family_recipes: T<
        { id: string; family_id: string; name: string; description: string | null; category: string; cuisine: string | null; servings: number; prep_time_mins: number | null; cook_time_mins: number | null; difficulty: string; ingredients: Json; instructions: Json; notes: string | null; photo_url: string | null; tags: string[]; allergy_flags: string[]; is_favorite: boolean; is_public: boolean; rating: number | null; times_made: number; last_made_at: string | null; source_url: string | null; ai_generated: boolean; estimated_cost_cents: number | null; source_provider: string | null; source_recipe_id: string | null; attribution: string | null; license_notes: string | null; imported_at: string | null; raw_payload: Json | null; created_by: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; name: string; description?: string | null; category?: string; cuisine?: string | null; servings?: number; prep_time_mins?: number | null; cook_time_mins?: number | null; difficulty?: string; ingredients?: Json; instructions?: Json; notes?: string | null; photo_url?: string | null; tags?: string[]; allergy_flags?: string[]; ai_generated?: boolean; source_url?: string | null; source_provider?: string | null; source_recipe_id?: string | null; attribution?: string | null; license_notes?: string | null; imported_at?: string | null; raw_payload?: Json | null; created_by?: string | null },
        Partial<{ name: string; description: string | null; category: string; cuisine: string | null; servings: number; prep_time_mins: number | null; cook_time_mins: number | null; difficulty: string; ingredients: Json; instructions: Json; notes: string | null; photo_url: string | null; tags: string[]; allergy_flags: string[]; is_favorite: boolean; rating: number | null; times_made: number; last_made_at: string | null; source_url: string | null; source_provider: string | null; source_recipe_id: string | null; attribution: string | null; license_notes: string | null; imported_at: string | null; raw_payload: Json | null; updated_at: string }>
      >;
      todo_lists: T<
        { id: string; family_id: string; created_by: string | null; name: string; color: string; icon: string; is_shared: boolean; sort_order: number; archived_at: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; created_by?: string | null; name: string; color?: string; icon?: string; is_shared?: boolean; sort_order?: number },
        Partial<{ name: string; color: string; icon: string; is_shared: boolean; sort_order: number; archived_at: string | null }>
      >;
      todo_items: T<
        { id: string; family_id: string; list_id: string; created_by: string | null; assigned_to_id: string | null; title: string; notes: string | null; is_done: boolean; priority: string; due_date: string | null; tags: string[]; sort_order: number; idempotency_key: string | null; completed_at: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; list_id: string; created_by?: string | null; assigned_to_id?: string | null; title: string; notes?: string | null; is_done?: boolean; priority?: string; due_date?: string | null; tags?: string[]; idempotency_key?: string | null; sort_order?: number },
        Partial<{ title: string; notes: string | null; is_done: boolean; priority: string; due_date: string | null; tags: string[]; sort_order: number; completed_at: string | null; assigned_to_id: string | null }>
      >;
      sync_providers: T<
        { provider: SyncProviderEnum; label: string; capabilities: Json; auth_kind: string; is_enabled: boolean; docs_url: string | null; notes: string | null } & Stamps,
        { provider: SyncProviderEnum; label: string; capabilities?: Json; auth_kind?: string; is_enabled?: boolean; docs_url?: string | null; notes?: string | null },
        Partial<{ label: string; capabilities: Json; auth_kind: string; is_enabled: boolean; docs_url: string | null; notes: string | null }>
      >;
      sync_accounts: T<
        { id: string; user_id: string; family_id: string; provider: SyncProviderEnum; external_id: string | null; display_name: string | null; sync_direction: SyncDirection; sync_status: SyncStatusEnum; scopes: string[]; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; user_id: string; family_id: string; provider: SyncProviderEnum; external_id?: string | null; display_name?: string | null; sync_direction?: SyncDirection; sync_status?: SyncStatusEnum; scopes?: string[]; last_synced_at?: string | null; created_by?: string | null; updated_by?: string | null; metadata?: Json },
        Partial<{ display_name: string | null; external_id: string | null; sync_direction: SyncDirection; sync_status: SyncStatusEnum; scopes: string[]; last_synced_at: string | null; updated_by: string | null; metadata: Json }>
      >;
      sync_connections: T<
        { id: string; account_id: string; user_id: string; family_id: string; provider: SyncProviderEnum; external_id: string | null; item_types: SyncItemType[]; sync_direction: SyncDirection; sync_status: SyncStatusEnum; health: string; last_error: string | null; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; account_id: string; user_id: string; family_id: string; provider: SyncProviderEnum; external_id?: string | null; item_types?: SyncItemType[]; sync_direction?: SyncDirection; sync_status?: SyncStatusEnum; health?: string; last_error?: string | null; last_synced_at?: string | null; created_by?: string | null; updated_by?: string | null; metadata?: Json },
        Partial<{ item_types: SyncItemType[]; sync_direction: SyncDirection; sync_status: SyncStatusEnum; health: string; last_error: string | null; last_synced_at: string | null; updated_by: string | null; metadata: Json }>
      >;
      sync_tokens: T<
        { id: string; account_id: string; user_id: string; family_id: string | null; provider: SyncProviderEnum; external_id: string | null; access_token_enc: string | null; refresh_token_enc: string | null; token_type: string | null; scope: string | null; expires_at: string | null; sync_direction: SyncDirection; sync_status: SyncStatusEnum; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; account_id: string; user_id: string; family_id?: string | null; provider: SyncProviderEnum; external_id?: string | null; access_token_enc?: string | null; refresh_token_enc?: string | null; token_type?: string | null; scope?: string | null; expires_at?: string | null; sync_direction?: SyncDirection; sync_status?: SyncStatusEnum; metadata?: Json },
        Partial<{ access_token_enc: string | null; refresh_token_enc: string | null; token_type: string | null; scope: string | null; expires_at: string | null; sync_status: SyncStatusEnum; last_synced_at: string | null; metadata: Json }>
      >;
      sync_calendars: T<
        { id: string; user_id: string | null; family_id: string; account_id: string | null; provider: SyncProviderEnum; external_id: string | null; name: string; description: string | null; color: string | null; timezone: string; is_primary: boolean; is_owned_locally: boolean; feed_token: string | null; feed_enabled: boolean; sync_direction: SyncDirection; sync_status: SyncStatusEnum; sync_token: string | null; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; user_id?: string | null; family_id: string; account_id?: string | null; provider?: SyncProviderEnum; external_id?: string | null; name: string; description?: string | null; color?: string | null; timezone?: string; is_primary?: boolean; is_owned_locally?: boolean; feed_token?: string | null; feed_enabled?: boolean; sync_direction?: SyncDirection; sync_status?: SyncStatusEnum; sync_token?: string | null; created_by?: string | null; updated_by?: string | null; metadata?: Json },
        Partial<{ name: string; description: string | null; color: string | null; timezone: string; is_primary: boolean; feed_token: string | null; feed_enabled: boolean; sync_direction: SyncDirection; sync_status: SyncStatusEnum; sync_token: string | null; last_synced_at: string | null; updated_by: string | null; metadata: Json }>
      >;
      sync_calendar_shares: T<
        { id: string; calendar_id: string; user_id: string | null; family_id: string; provider: SyncProviderEnum; external_id: string | null; shared_with_member: string | null; shared_with_email: string | null; permission: string; sync_direction: SyncDirection; sync_status: SyncStatusEnum; revoked_at: string | null; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; calendar_id: string; user_id?: string | null; family_id: string; provider?: SyncProviderEnum; external_id?: string | null; shared_with_member?: string | null; shared_with_email?: string | null; permission?: string; sync_direction?: SyncDirection; sync_status?: SyncStatusEnum; created_by?: string | null; metadata?: Json },
        Partial<{ permission: string; sync_direction: SyncDirection; sync_status: SyncStatusEnum; revoked_at: string | null; last_synced_at: string | null; updated_by: string | null; metadata: Json }>
      >;
      sync_calendar_events: T<
        { id: string; calendar_id: string; user_id: string | null; family_id: string; provider: SyncProviderEnum; external_id: string | null; uid: string | null; title: string; description: string | null; location: string | null; starts_at: string; ends_at: string | null; all_day: boolean; timezone: string; recurrence_rule: string | null; recurrence_id: string | null; color: string | null; reminders: Json; status: string; etag: string | null; deleted_at: string | null; sync_direction: SyncDirection; sync_status: SyncStatusEnum; content_hash: string | null; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; calendar_id: string; user_id?: string | null; family_id: string; provider?: SyncProviderEnum; external_id?: string | null; uid?: string | null; title: string; description?: string | null; location?: string | null; starts_at: string; ends_at?: string | null; all_day?: boolean; timezone?: string; recurrence_rule?: string | null; recurrence_id?: string | null; color?: string | null; reminders?: Json; status?: string; etag?: string | null; deleted_at?: string | null; sync_direction?: SyncDirection; sync_status?: SyncStatusEnum; content_hash?: string | null; last_synced_at?: string | null; created_by?: string | null; updated_by?: string | null; metadata?: Json },
        Partial<{ external_id: string | null; uid: string | null; title: string; description: string | null; location: string | null; starts_at: string; ends_at: string | null; all_day: boolean; timezone: string; recurrence_rule: string | null; color: string | null; reminders: Json; status: string; etag: string | null; deleted_at: string | null; sync_direction: SyncDirection; sync_status: SyncStatusEnum; content_hash: string | null; last_synced_at: string | null; updated_by: string | null; metadata: Json }>
      >;
      sync_event_attendees: T<
        { id: string; event_id: string; family_id: string; provider: SyncProviderEnum; external_id: string | null; member_id: string | null; email: string | null; display_name: string | null; response_status: string; is_organizer: boolean; sync_status: SyncStatusEnum; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; event_id: string; family_id: string; provider?: SyncProviderEnum; external_id?: string | null; member_id?: string | null; email?: string | null; display_name?: string | null; response_status?: string; is_organizer?: boolean; sync_status?: SyncStatusEnum; created_by?: string | null; metadata?: Json },
        Partial<{ response_status: string; is_organizer: boolean; sync_status: SyncStatusEnum; last_synced_at: string | null; updated_by: string | null; metadata: Json }>
      >;
      sync_reminder_lists: T<
        { id: string; user_id: string | null; family_id: string; account_id: string | null; provider: SyncProviderEnum; external_id: string | null; name: string; color: string | null; is_owned_locally: boolean; sync_direction: SyncDirection; sync_status: SyncStatusEnum; sync_token: string | null; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; user_id?: string | null; family_id: string; account_id?: string | null; provider?: SyncProviderEnum; external_id?: string | null; name: string; color?: string | null; is_owned_locally?: boolean; sync_direction?: SyncDirection; sync_status?: SyncStatusEnum; sync_token?: string | null; created_by?: string | null; metadata?: Json },
        Partial<{ name: string; color: string | null; sync_direction: SyncDirection; sync_status: SyncStatusEnum; sync_token: string | null; last_synced_at: string | null; updated_by: string | null; metadata: Json }>
      >;
      sync_reminders: T<
        { id: string; list_id: string; user_id: string | null; family_id: string; provider: SyncProviderEnum; external_id: string | null; title: string; notes: string | null; due_at: string | null; all_day: boolean; recurrence_rule: string | null; priority: string; is_completed: boolean; completed_at: string | null; assigned_member: string | null; reminders: Json; etag: string | null; deleted_at: string | null; sync_direction: SyncDirection; sync_status: SyncStatusEnum; content_hash: string | null; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; list_id: string; user_id?: string | null; family_id: string; provider?: SyncProviderEnum; external_id?: string | null; title: string; notes?: string | null; due_at?: string | null; all_day?: boolean; recurrence_rule?: string | null; priority?: string; is_completed?: boolean; completed_at?: string | null; assigned_member?: string | null; reminders?: Json; etag?: string | null; deleted_at?: string | null; sync_direction?: SyncDirection; sync_status?: SyncStatusEnum; content_hash?: string | null; last_synced_at?: string | null; created_by?: string | null; updated_by?: string | null; metadata?: Json },
        Partial<{ title: string; notes: string | null; due_at: string | null; all_day: boolean; recurrence_rule: string | null; priority: string; is_completed: boolean; completed_at: string | null; assigned_member: string | null; reminders: Json; etag: string | null; deleted_at: string | null; sync_direction: SyncDirection; sync_status: SyncStatusEnum; content_hash: string | null; last_synced_at: string | null; updated_by: string | null; metadata: Json }>
      >;
      sync_note_folders: T<
        { id: string; user_id: string | null; family_id: string; account_id: string | null; provider: SyncProviderEnum; external_id: string | null; name: string; parent_id: string | null; is_owned_locally: boolean; sync_direction: SyncDirection; sync_status: SyncStatusEnum; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; user_id?: string | null; family_id: string; account_id?: string | null; provider?: SyncProviderEnum; external_id?: string | null; name: string; parent_id?: string | null; is_owned_locally?: boolean; sync_direction?: SyncDirection; sync_status?: SyncStatusEnum; created_by?: string | null; metadata?: Json },
        Partial<{ name: string; parent_id: string | null; sync_direction: SyncDirection; sync_status: SyncStatusEnum; last_synced_at: string | null; updated_by: string | null; metadata: Json }>
      >;
      sync_notes: T<
        { id: string; folder_id: string | null; user_id: string | null; family_id: string; provider: SyncProviderEnum; external_id: string | null; title: string; body_markdown: string | null; body_html: string | null; checklist: Json; tags: string[]; version: number; etag: string | null; deleted_at: string | null; sync_direction: SyncDirection; sync_status: SyncStatusEnum; content_hash: string | null; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; folder_id?: string | null; user_id?: string | null; family_id: string; provider?: SyncProviderEnum; external_id?: string | null; title?: string; body_markdown?: string | null; body_html?: string | null; checklist?: Json; tags?: string[]; version?: number; etag?: string | null; deleted_at?: string | null; sync_direction?: SyncDirection; sync_status?: SyncStatusEnum; content_hash?: string | null; created_by?: string | null; updated_by?: string | null; metadata?: Json },
        Partial<{ folder_id: string | null; title: string; body_markdown: string | null; body_html: string | null; checklist: Json; tags: string[]; version: number; etag: string | null; deleted_at: string | null; sync_direction: SyncDirection; sync_status: SyncStatusEnum; content_hash: string | null; last_synced_at: string | null; updated_by: string | null; metadata: Json }>
      >;
      sync_external_mappings: T<
        { id: string; user_id: string | null; family_id: string; account_id: string | null; provider: SyncProviderEnum; item_type: SyncItemType; local_id: string; external_id: string; external_etag: string | null; sync_direction: SyncDirection; sync_status: SyncStatusEnum; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; user_id?: string | null; family_id: string; account_id?: string | null; provider: SyncProviderEnum; item_type: SyncItemType; local_id: string; external_id: string; external_etag?: string | null; sync_direction?: SyncDirection; sync_status?: SyncStatusEnum; last_synced_at?: string | null; metadata?: Json },
        Partial<{ external_etag: string | null; sync_direction: SyncDirection; sync_status: SyncStatusEnum; last_synced_at: string | null; updated_by: string | null; metadata: Json }>
      >;
      sync_jobs: T<
        { id: string; user_id: string | null; family_id: string; account_id: string | null; provider: SyncProviderEnum; external_id: string | null; item_type: SyncItemType | null; kind: string; sync_direction: SyncDirection; sync_status: SyncStatusEnum; status: SyncJobStatus; scheduled_for: string; attempts: number; max_attempts: number; next_attempt_at: string | null; idempotency_key: string | null; last_error: string | null; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; user_id?: string | null; family_id: string; account_id?: string | null; provider: SyncProviderEnum; external_id?: string | null; item_type?: SyncItemType | null; kind?: string; sync_direction?: SyncDirection; sync_status?: SyncStatusEnum; status?: SyncJobStatus; scheduled_for?: string; attempts?: number; max_attempts?: number; next_attempt_at?: string | null; idempotency_key?: string | null; metadata?: Json },
        Partial<{ status: SyncJobStatus; sync_status: SyncStatusEnum; scheduled_for: string; attempts: number; next_attempt_at: string | null; last_error: string | null; last_synced_at: string | null; updated_by: string | null; metadata: Json }>
      >;
      sync_job_runs: T<
        { id: string; job_id: string; user_id: string | null; family_id: string; provider: SyncProviderEnum; external_id: string | null; status: SyncJobStatus; sync_status: SyncStatusEnum; items_imported: number; items_exported: number; items_skipped: number; conflicts_found: number; started_at: string; finished_at: string | null; duration_ms: number | null; error: string | null; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; job_id: string; user_id?: string | null; family_id: string; provider: SyncProviderEnum; external_id?: string | null; status?: SyncJobStatus; sync_status?: SyncStatusEnum; items_imported?: number; items_exported?: number; items_skipped?: number; conflicts_found?: number; metadata?: Json },
        Partial<{ status: SyncJobStatus; sync_status: SyncStatusEnum; items_imported: number; items_exported: number; items_skipped: number; conflicts_found: number; finished_at: string | null; duration_ms: number | null; error: string | null; last_synced_at: string | null; metadata: Json }>
      >;
      sync_webhook_events: T<
        { id: string; family_id: string | null; account_id: string | null; provider: SyncProviderEnum; external_id: string | null; resource: string | null; payload: Json; signature_ok: boolean; processed: boolean; sync_status: SyncStatusEnum; received_at: string; processed_at: string | null; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; family_id?: string | null; account_id?: string | null; provider: SyncProviderEnum; external_id?: string | null; resource?: string | null; payload?: Json; signature_ok?: boolean; processed?: boolean; sync_status?: SyncStatusEnum; metadata?: Json },
        Partial<{ processed: boolean; signature_ok: boolean; sync_status: SyncStatusEnum; processed_at: string | null; last_synced_at: string | null; metadata: Json }>
      >;
      sync_change_logs: T<
        { id: string; user_id: string | null; family_id: string; provider: SyncProviderEnum; external_id: string | null; item_type: SyncItemType; local_id: string | null; operation: string; origin: string; sync_direction: SyncDirection; sync_status: SyncStatusEnum; before: Json | null; after: Json | null; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; user_id?: string | null; family_id: string; provider?: SyncProviderEnum; external_id?: string | null; item_type: SyncItemType; local_id?: string | null; operation: string; origin?: string; sync_direction?: SyncDirection; sync_status?: SyncStatusEnum; before?: Json | null; after?: Json | null; metadata?: Json },
        Partial<{ sync_status: SyncStatusEnum; last_synced_at: string | null; metadata: Json }>
      >;
      sync_provider_errors: T<
        { id: string; family_id: string | null; account_id: string | null; provider: SyncProviderEnum; external_id: string | null; code: string | null; message_redacted: string | null; http_status: number | null; is_fatal: boolean; sync_status: SyncStatusEnum; occurred_at: string; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; family_id?: string | null; account_id?: string | null; provider: SyncProviderEnum; external_id?: string | null; code?: string | null; message_redacted?: string | null; http_status?: number | null; is_fatal?: boolean; sync_status?: SyncStatusEnum; metadata?: Json },
        Partial<{ is_fatal: boolean; sync_status: SyncStatusEnum; metadata: Json }>
      >;
      sync_conflicts: T<
        { id: string; user_id: string | null; family_id: string; account_id: string | null; provider: SyncProviderEnum; external_id: string | null; item_type: SyncItemType; local_id: string | null; conflict_kind: string; local_snapshot: Json | null; remote_snapshot: Json | null; status: SyncConflictStatus; sync_direction: SyncDirection; sync_status: SyncStatusEnum; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; user_id?: string | null; family_id: string; account_id?: string | null; provider: SyncProviderEnum; external_id?: string | null; item_type: SyncItemType; local_id?: string | null; conflict_kind: string; local_snapshot?: Json | null; remote_snapshot?: Json | null; status?: SyncConflictStatus; sync_direction?: SyncDirection; sync_status?: SyncStatusEnum; metadata?: Json },
        Partial<{ status: SyncConflictStatus; sync_status: SyncStatusEnum; local_snapshot: Json | null; remote_snapshot: Json | null; last_synced_at: string | null; updated_by: string | null; metadata: Json }>
      >;
      sync_conflict_resolutions: T<
        { id: string; conflict_id: string; user_id: string | null; family_id: string; provider: SyncProviderEnum; external_id: string | null; resolution: SyncConflictResolutionEnum; resolved_by: string | null; sync_direction: SyncDirection; sync_status: SyncStatusEnum; result_snapshot: Json | null; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; conflict_id: string; user_id?: string | null; family_id: string; provider: SyncProviderEnum; external_id?: string | null; resolution: SyncConflictResolutionEnum; resolved_by?: string | null; sync_direction?: SyncDirection; sync_status?: SyncStatusEnum; result_snapshot?: Json | null; created_by?: string | null; metadata?: Json },
        Partial<{ sync_status: SyncStatusEnum; result_snapshot: Json | null; last_synced_at: string | null; metadata: Json }>
      >;
      sync_audit_logs: T<
        { id: string; user_id: string | null; family_id: string | null; provider: SyncProviderEnum | null; external_id: string | null; action: string; item_type: SyncItemType | null; target_id: string | null; sync_direction: SyncDirection | null; sync_status: SyncStatusEnum | null; ip_redacted: string | null; detail: Json; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; user_id?: string | null; family_id?: string | null; provider?: SyncProviderEnum | null; external_id?: string | null; action: string; item_type?: SyncItemType | null; target_id?: string | null; sync_direction?: SyncDirection | null; sync_status?: SyncStatusEnum | null; ip_redacted?: string | null; detail?: Json; created_by?: string | null; metadata?: Json },
        Partial<{ detail: Json; metadata: Json }>
      >;
      sync_settings: T<
        { family_id: string; user_id: string | null; provider: SyncProviderEnum | null; external_id: string | null; default_direction: SyncDirection; sync_interval_mins: number; auto_resolve: SyncConflictResolutionEnum | null; calendars_enabled: boolean; reminders_enabled: boolean; notes_enabled: boolean; sync_status: SyncStatusEnum; last_synced_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { family_id: string; user_id?: string | null; provider?: SyncProviderEnum | null; external_id?: string | null; default_direction?: SyncDirection; sync_interval_mins?: number; auto_resolve?: SyncConflictResolutionEnum | null; calendars_enabled?: boolean; reminders_enabled?: boolean; notes_enabled?: boolean; metadata?: Json },
        Partial<{ default_direction: SyncDirection; sync_interval_mins: number; auto_resolve: SyncConflictResolutionEnum | null; calendars_enabled: boolean; reminders_enabled: boolean; notes_enabled: boolean; sync_status: SyncStatusEnum; last_synced_at: string | null; updated_by: string | null; metadata: Json }>
      >;
      // ── Marketing (admin-only) ──────────────────────────────
      marketing_segments: T<
        { id: string; name: string; description: string | null; kind: string; rules: Json; member_keys: string[]; status: string; metadata: Json; created_by: string | null; updated_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; name: string; description?: string | null; kind?: string; rules?: Json; member_keys?: string[]; status?: string; metadata?: Json; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null },
        Partial<{ name: string; description: string | null; kind: string; rules: Json; member_keys: string[]; status: string; metadata: Json; updated_by: string | null; deleted_at: string | null }>
      >;
      marketing_campaigns: T<
        { id: string; name: string; objective: string | null; channel: string; type: string; status: string; segment_id: string | null; budget_cents: number; starts_at: string | null; ends_at: string | null; notes: string | null; kpis: Json; metadata: Json; created_by: string | null; updated_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; name: string; objective?: string | null; channel?: string; type?: string; status?: string; segment_id?: string | null; budget_cents?: number; starts_at?: string | null; ends_at?: string | null; notes?: string | null; kpis?: Json; metadata?: Json; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null },
        Partial<{ name: string; objective: string | null; channel: string; type: string; status: string; segment_id: string | null; budget_cents: number; starts_at: string | null; ends_at: string | null; notes: string | null; kpis: Json; metadata: Json; updated_by: string | null; deleted_at: string | null }>
      >;
      marketing_email_campaigns: T<
        { id: string; campaign_id: string | null; segment_id: string | null; subject: string; preview_text: string | null; body_html: string; from_name: string | null; status: string; scheduled_at: string | null; sent_at: string | null; recipients: number; opens: number; clicks: number; bounces: number; unsubscribes: number; provider_ref: string | null; metadata: Json; created_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; campaign_id?: string | null; segment_id?: string | null; subject?: string; preview_text?: string | null; body_html?: string; from_name?: string | null; status?: string; scheduled_at?: string | null; sent_at?: string | null; recipients?: number; opens?: number; clicks?: number; bounces?: number; unsubscribes?: number; provider_ref?: string | null; metadata?: Json; created_by?: string | null; deleted_at?: string | null },
        Partial<{ subject: string; preview_text: string | null; body_html: string; from_name: string | null; status: string; scheduled_at: string | null; sent_at: string | null; recipients: number; opens: number; clicks: number; bounces: number; unsubscribes: number; provider_ref: string | null; metadata: Json }>
      >;
      marketing_content_items: T<
        { id: string; campaign_id: string | null; title: string; kind: string; channel: string | null; brief: string | null; body: string | null; status: string; publish_at: string | null; metadata: Json; created_by: string | null; updated_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; campaign_id?: string | null; title: string; kind?: string; channel?: string | null; brief?: string | null; body?: string | null; status?: string; publish_at?: string | null; metadata?: Json; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null },
        Partial<{ campaign_id: string | null; title: string; kind: string; channel: string | null; brief: string | null; body: string | null; status: string; publish_at: string | null; metadata: Json; updated_by: string | null; deleted_at: string | null }>
      >;
      marketing_seo_pages: T<
        { id: string; path: string; title: string | null; meta_description: string | null; issues: Json; score: number | null; status: string; last_audited_at: string | null; metadata: Json } & Stamps,
        { id?: string; path: string; title?: string | null; meta_description?: string | null; issues?: Json; score?: number | null; status?: string; last_audited_at?: string | null; metadata?: Json },
        Partial<{ title: string | null; meta_description: string | null; issues: Json; score: number | null; status: string; last_audited_at: string | null; metadata: Json }>
      >;
      marketing_seo_keywords: T<
        { id: string; keyword: string; intent: string | null; target_path: string | null; source: string; status: string; metadata: Json; created_by: string | null } & Stamps,
        { id?: string; keyword: string; intent?: string | null; target_path?: string | null; source?: string; status?: string; metadata?: Json; created_by?: string | null },
        Partial<{ keyword: string; intent: string | null; target_path: string | null; source: string; status: string; metadata: Json }>
      >;
      marketing_aeo_questions: T<
        { id: string; question: string; answer: string | null; entity: string | null; source_path: string | null; pattern: string | null; status: string; clarity_score: number | null; last_reviewed: string | null; metadata: Json; created_by: string | null } & Stamps,
        { id?: string; question: string; answer?: string | null; entity?: string | null; source_path?: string | null; pattern?: string | null; status?: string; clarity_score?: number | null; last_reviewed?: string | null; metadata?: Json; created_by?: string | null },
        Partial<{ question: string; answer: string | null; entity: string | null; source_path: string | null; pattern: string | null; status: string; clarity_score: number | null; last_reviewed: string | null; metadata: Json }>
      >;
      marketing_aeo_question_translations: T<
        { id: string; question_id: string; locale: string; question: string; answer: string; source: string; reviewed_at: string | null } & Stamps,
        { id?: string; question_id: string; locale: string; question: string; answer: string; source?: string; reviewed_at?: string | null },
        Partial<{ question: string; answer: string; source: string; reviewed_at: string | null }>
      >;
      marketing_settings: T<
        { key: string; value: Json; updated_by: string | null; updated_at: string },
        { key: string; value?: Json; updated_by?: string | null },
        Partial<{ value: Json; updated_by: string | null }>
      >;
      marketing_audit_logs: T<
        { id: string; actor_id: string | null; actor_email: string | null; action: string; resource: string; resource_id: string | null; metadata: Json; created_at: string },
        { id?: string; actor_id?: string | null; actor_email?: string | null; action: string; resource: string; resource_id?: string | null; metadata?: Json },
        Partial<{ metadata: Json }>
      >;
      marketing_sms_campaigns: T<
        { id: string; campaign_id: string | null; segment_id: string | null; message: string; status: string; scheduled_at: string | null; sent_at: string | null; recipients: number; delivered: number; replies: number; opt_outs: number; provider_ref: string | null; metadata: Json; created_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; campaign_id?: string | null; segment_id?: string | null; message?: string; status?: string; scheduled_at?: string | null; sent_at?: string | null; recipients?: number; delivered?: number; replies?: number; opt_outs?: number; provider_ref?: string | null; metadata?: Json; created_by?: string | null; deleted_at?: string | null },
        Partial<{ message: string; status: string; scheduled_at: string | null; sent_at: string | null; recipients: number; delivered: number; replies: number; opt_outs: number; metadata: Json }>
      >;
      marketing_social_posts: T<
        { id: string; campaign_id: string | null; platform: string; content: string; link: string | null; status: string; scheduled_at: string | null; metadata: Json; created_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; campaign_id?: string | null; platform?: string; content?: string; link?: string | null; status?: string; scheduled_at?: string | null; metadata?: Json; created_by?: string | null; deleted_at?: string | null },
        Partial<{ platform: string; content: string; link: string | null; status: string; scheduled_at: string | null; metadata: Json }>
      >;
      assistant_links: T<
        { id: string; family_id: string; user_id: string; provider: string; label: string; token_hash: string; token_prefix: string; scopes: string[]; last_used_at: string | null; revoked_at: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; user_id: string; provider?: string; label: string; token_hash: string; token_prefix: string; scopes?: string[]; last_used_at?: string | null; revoked_at?: string | null; created_by?: string | null },
        Partial<{ label: string; provider: string; scopes: string[]; last_used_at: string | null; revoked_at: string | null }>
      >;
      assistant_link_events: T<
        { id: string; link_id: string; family_id: string; intent: string; utterance: string | null; outcome: string; created_at: string },
        { id?: string; link_id: string; family_id: string; intent: string; utterance?: string | null; outcome: string; created_at?: string },
        never
      >;
      marketing_recurring_ads: T<
        { id: string; campaign_id: string | null; name: string; status: string; body_variants: string[]; link: string | null; media_urls: string[]; platforms: string[]; cadence: string; times_of_day: number[]; days_of_week: number[]; day_of_month: number | null; timezone: string; starts_at: string; ends_at: string | null; max_occurrences: number | null; next_run_at: string | null; last_run_at: string | null; occurrences: number; last_error: string | null; created_by: string | null; updated_by: string | null; metadata: Json; deleted_at: string | null } & Stamps,
        { id?: string; campaign_id?: string | null; name: string; status?: string; body_variants?: string[]; link?: string | null; media_urls?: string[]; platforms?: string[]; cadence?: string; times_of_day?: number[]; days_of_week?: number[]; day_of_month?: number | null; timezone?: string; starts_at?: string; ends_at?: string | null; max_occurrences?: number | null; next_run_at?: string | null; last_run_at?: string | null; occurrences?: number; last_error?: string | null; created_by?: string | null; updated_by?: string | null; metadata?: Json; deleted_at?: string | null },
        Partial<{ campaign_id: string | null; name: string; status: string; body_variants: string[]; link: string | null; media_urls: string[]; platforms: string[]; cadence: string; times_of_day: number[]; days_of_week: number[]; day_of_month: number | null; timezone: string; starts_at: string; ends_at: string | null; max_occurrences: number | null; next_run_at: string | null; last_run_at: string | null; occurrences: number; last_error: string | null; updated_by: string | null; metadata: Json; deleted_at: string | null }>
      >;
      marketing_recurring_ad_runs: T<
        { id: string; ad_id: string; post_id: string | null; occurrence: number; platform: string; status: string; body: string; scheduled_for: string; ran_at: string; provider_object_id: string | null; permalink_url: string | null; error_code: string | null; error_message: string | null; metadata: Json; created_at: string },
        { id?: string; ad_id: string; post_id?: string | null; occurrence: number; platform: string; status: string; body?: string; scheduled_for: string; ran_at?: string; provider_object_id?: string | null; permalink_url?: string | null; error_code?: string | null; error_message?: string | null; metadata?: Json; created_at?: string },
        Partial<{ post_id: string | null; status: string; permalink_url: string | null; error_code: string | null; error_message: string | null; metadata: Json }>
      >;
      marketing_ad_campaigns: T<
        { id: string; campaign_id: string | null; platform: string; name: string; objective: string | null; budget_cents: number; spend_cents: number; impressions: number; clicks: number; conversions: number; utm: Json; status: string; metadata: Json; created_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; campaign_id?: string | null; platform?: string; name: string; objective?: string | null; budget_cents?: number; spend_cents?: number; impressions?: number; clicks?: number; conversions?: number; utm?: Json; status?: string; metadata?: Json; created_by?: string | null; deleted_at?: string | null },
        Partial<{ platform: string; name: string; objective: string | null; budget_cents: number; spend_cents: number; impressions: number; clicks: number; conversions: number; utm: Json; status: string; metadata: Json }>
      >;
      marketing_automation_workflows: T<
        { id: string; name: string; trigger: string; steps: Json; status: string; run_count: number; metadata: Json; created_by: string | null; updated_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; name: string; trigger?: string; steps?: Json; status?: string; run_count?: number; metadata?: Json; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null },
        Partial<{ name: string; trigger: string; steps: Json; status: string; run_count: number; metadata: Json; updated_by: string | null; deleted_at: string | null }>
      >;
      marketing_automation_runs: T<
        { id: string; workflow_id: string; status: string; subject_key: string | null; metadata: Json; created_at: string },
        { id?: string; workflow_id: string; status?: string; subject_key?: string | null; metadata?: Json },
        Partial<{ status: string; metadata: Json }>
      >;
      marketing_funnels: T<
        { id: string; name: string; steps: Json; status: string; metadata: Json; created_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; name: string; steps?: Json; status?: string; metadata?: Json; created_by?: string | null; deleted_at?: string | null },
        Partial<{ name: string; steps: Json; status: string; metadata: Json; deleted_at: string | null }>
      >;
      marketing_landing_pages: T<
        { id: string; campaign_id: string | null; slug: string; title: string; headline: string | null; subhead: string | null; body: string | null; status: string; published: boolean; views: number; conversions: number; metadata: Json; created_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; campaign_id?: string | null; slug: string; title: string; headline?: string | null; subhead?: string | null; body?: string | null; status?: string; published?: boolean; views?: number; conversions?: number; metadata?: Json; created_by?: string | null; deleted_at?: string | null },
        Partial<{ slug: string; title: string; headline: string | null; subhead: string | null; body: string | null; status: string; published: boolean; views: number; conversions: number; metadata: Json }>
      >;
      marketing_pages: T<
        { id: string; page_type: string; slug: string; path: string; parent_id: string | null; campaign_id: string | null; template_id: string | null; title: string; summary: string | null; body: string | null; content: Json; seo: Json; aeo: Json; status: string; version: number; published_at: string | null; created_by: string | null; updated_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; page_type: string; slug: string; path: string; parent_id?: string | null; campaign_id?: string | null; template_id?: string | null; title: string; summary?: string | null; body?: string | null; content?: Json; seo?: Json; aeo?: Json; status?: string; version?: number; published_at?: string | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null },
        Partial<{ page_type: string; slug: string; path: string; parent_id: string | null; campaign_id: string | null; template_id: string | null; title: string; summary: string | null; body: string | null; content: Json; seo: Json; aeo: Json; status: string; version: number; published_at: string | null; updated_by: string | null; deleted_at: string | null }>
      >;
      marketing_page_versions: T<
        { id: string; page_id: string; version: number; title: string; summary: string | null; body: string | null; content: Json; seo: Json; aeo: Json; change_source: string; change_note: string | null; created_by: string | null; created_at: string },
        { id?: string; page_id: string; version: number; title: string; summary?: string | null; body?: string | null; content?: Json; seo?: Json; aeo?: Json; change_source?: string; change_note?: string | null; created_by?: string | null },
        Partial<{ title: string; summary: string | null; body: string | null; content: Json; seo: Json; aeo: Json; change_source: string; change_note: string | null }>
      >;
      marketing_content_templates: T<
        { id: string; name: string; page_type: string; description: string | null; schema: Json; instructions: string; defaults: Json; version: number; status: string; is_default: boolean; created_by: string | null; updated_by: string | null } & Stamps,
        { id?: string; name: string; page_type: string; description?: string | null; schema?: Json; instructions?: string; defaults?: Json; version?: number; status?: string; is_default?: boolean; created_by?: string | null; updated_by?: string | null },
        Partial<{ name: string; page_type: string; description: string | null; schema: Json; instructions: string; defaults: Json; version: number; status: string; is_default: boolean; updated_by: string | null }>
      >;
      marketing_brand_rules: T<
        { id: string; rule_key: string; name: string; instructions: string; value: Json; version: number; active: boolean; updated_by: string | null } & Stamps,
        { id?: string; rule_key: string; name: string; instructions?: string; value?: Json; version?: number; active?: boolean; updated_by?: string | null },
        Partial<{ rule_key: string; name: string; instructions: string; value: Json; version: number; active: boolean; updated_by: string | null }>
      >;
      marketing_generation_jobs: T<
        { id: string; job_type: string; target_type: string; target_id: string | null; target_path: string | null; status: string; priority: number; attempts: number; max_attempts: number; run_after: string; locked_at: string | null; started_at: string | null; completed_at: string | null; idempotency_key: string; payload: Json; result: Json; error: string | null; created_by: string | null } & Stamps,
        { id?: string; job_type: string; target_type?: string; target_id?: string | null; target_path?: string | null; status?: string; priority?: number; attempts?: number; max_attempts?: number; run_after?: string; locked_at?: string | null; started_at?: string | null; completed_at?: string | null; idempotency_key: string; payload?: Json; result?: Json; error?: string | null; created_by?: string | null },
        Partial<{ job_type: string; target_type: string; target_id: string | null; target_path: string | null; status: string; priority: number; attempts: number; max_attempts: number; run_after: string; locked_at: string | null; started_at: string | null; completed_at: string | null; payload: Json; result: Json; error: string | null }>
      >;
      marketing_page_relationships: T<
        { id: string; from_page_id: string; to_page_id: string; relationship: string; position: number; metadata: Json; created_at: string },
        { id?: string; from_page_id: string; to_page_id: string; relationship: string; position?: number; metadata?: Json },
        Partial<{ relationship: string; position: number; metadata: Json }>
      >;
      marketing_embeddings: T<
        { id: string; source_type: string; source_id: string; chunk_index: number; content_hash: string; content: string; embedding: Json | null; provider: string; model: string; dimensions: number; status: string; metadata: Json } & Stamps,
        { id?: string; source_type: string; source_id: string; chunk_index?: number; content_hash: string; content: string; embedding?: Json | null; provider?: string; model?: string; dimensions?: number; status?: string; metadata?: Json },
        Partial<{ chunk_index: number; content_hash: string; content: string; embedding: Json | null; provider: string; model: string; dimensions: number; status: string; metadata: Json }>
      >;
      marketing_provider_observations: T<
        { id: string; provider: string; engine: string; observed_for: string; page_path: string; query: string; clicks: number; impressions: number; ctr: number | null; average_position: number | null; citations: number; cited: boolean | null; payload: Json; source_status: string } & Stamps,
        { id?: string; provider: string; engine?: string; observed_for: string; page_path?: string; query?: string; clicks?: number; impressions?: number; ctr?: number | null; average_position?: number | null; citations?: number; cited?: boolean | null; payload?: Json; source_status?: string },
        Partial<{ provider: string; engine: string; observed_for: string; page_path: string; query: string; clicks: number; impressions: number; ctr: number | null; average_position: number | null; citations: number; cited: boolean | null; payload: Json; source_status: string }>
      >;
      marketing_provider_syncs: T<
        { provider: string; status: string; last_started_at: string | null; last_completed_at: string | null; last_error: string | null; rows_imported: number; metadata: Json; updated_at: string },
        { provider: string; status?: string; last_started_at?: string | null; last_completed_at?: string | null; last_error?: string | null; rows_imported?: number; metadata?: Json },
        Partial<{ status: string; last_started_at: string | null; last_completed_at: string | null; last_error: string | null; rows_imported: number; metadata: Json }>
      >;
      marketing_forms: T<
        { id: string; campaign_id: string | null; name: string; fields: Json; status: string; metadata: Json; created_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; campaign_id?: string | null; name: string; fields?: Json; status?: string; metadata?: Json; created_by?: string | null; deleted_at?: string | null },
        Partial<{ name: string; fields: Json; status: string; metadata: Json; deleted_at: string | null }>
      >;
      marketing_form_submissions: T<
        { id: string; form_id: string; email: string | null; data: Json; source: string | null; created_at: string },
        { id?: string; form_id: string; email?: string | null; data?: Json; source?: string | null },
        Partial<{ email: string | null; data: Json; source: string | null }>
      >;
      marketing_suppressions: T<
        { email: string; reason: string; campaign_id: string | null; created_at: string },
        { email: string; reason?: string; campaign_id?: string | null },
        Partial<{ reason: string; campaign_id: string | null }>
      >;
      resend_webhook_events: T<
        { svix_id: string; event_type: string; status: string; received_at: string; processed_at: string | null; error: string | null },
        { svix_id: string; event_type: string; status?: string; received_at?: string; processed_at?: string | null; error?: string | null },
        Partial<{ event_type: string; status: string; received_at: string; processed_at: string | null; error: string | null }>
      >;
      guardian_callback_events: T<
        { event_id: string; callback_type: string; status: string; received_at: string; processed_at: string | null; error: string | null },
        { event_id: string; callback_type: string; status?: string; received_at?: string; processed_at?: string | null; error?: string | null },
        Partial<{ callback_type: string; status: string; received_at: string; processed_at: string | null; error: string | null }>
      >;
      crm_contacts: T<
        { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; company: string | null; lead_status: string; lifecycle_stage: string; lead_source: string | null; family_id: string | null; owner_id: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null; company?: string | null; lead_status?: string; lifecycle_stage?: string; lead_source?: string | null; family_id?: string | null; owner_id?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ first_name: string | null; last_name: string | null; email: string | null; phone: string | null; company: string | null; lead_status: string; lifecycle_stage: string; lead_source: string | null; family_id: string | null; owner_id: string | null; notes: string | null }>
      >;
      crm_deals: T<
        { id: string; contact_id: string | null; name: string; amount_cents: number; currency: string; stage: string; close_date: string | null; owner_id: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; contact_id?: string | null; name: string; amount_cents?: number; currency?: string; stage?: string; close_date?: string | null; owner_id?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ contact_id: string | null; name: string; amount_cents: number; currency: string; stage: string; close_date: string | null; owner_id: string | null; notes: string | null }>
      >;
      crm_quotes: T<
        { id: string; contact_id: string | null; deal_id: string | null; title: string; status: string; amount_cents: number; currency: string; valid_until: string | null; notes: string | null; sent_at: string | null; responded_at: string | null; created_by: string | null } & Stamps,
        { id?: string; contact_id?: string | null; deal_id?: string | null; title: string; status?: string; amount_cents?: number; currency?: string; valid_until?: string | null; notes?: string | null; sent_at?: string | null; responded_at?: string | null; created_by?: string | null },
        Partial<{ contact_id: string | null; deal_id: string | null; title: string; status: string; amount_cents: number; currency: string; valid_until: string | null; notes: string | null; sent_at: string | null; responded_at: string | null }>
      >;
      mkt_visitors: T<
        { id: string; anonymous_id: string; contact_id: string | null; device_type: string | null; country: string | null; first_seen: string; last_seen: string; session_count: number } & Stamps,
        { id?: string; anonymous_id: string; contact_id?: string | null; device_type?: string | null; country?: string | null; first_seen?: string; last_seen?: string; session_count?: number },
        Partial<{ contact_id: string | null; device_type: string | null; country: string | null; last_seen: string; session_count: number }>
      >;
      mkt_sessions: T<
        { id: string; visitor_id: string | null; source: string | null; medium: string | null; campaign: string | null; landing_path: string | null; page_views: number; started_at: string },
        { id?: string; visitor_id?: string | null; source?: string | null; medium?: string | null; campaign?: string | null; landing_path?: string | null; page_views?: number; started_at?: string },
        Partial<{ source: string | null; medium: string | null; campaign: string | null; landing_path: string | null; page_views: number }>
      >;
      mkt_touchpoints: T<
        { id: string; visitor_id: string | null; source: string | null; medium: string | null; campaign: string | null; kind: string; occurred_at: string },
        { id?: string; visitor_id?: string | null; source?: string | null; medium?: string | null; campaign?: string | null; kind?: string; occurred_at?: string },
        Partial<{ source: string | null; medium: string | null; campaign: string | null; kind: string }>
      >;
      mkt_consent_events: T<
        { id: string; anonymous_id: string; contact_id: string | null; category: string; decision: string; policy_version: string; source: string | null; gpc: boolean; user_agent: string | null; metadata: Json; created_at: string },
        { id?: string; anonymous_id: string; contact_id?: string | null; category: string; decision: string; policy_version?: string; source?: string | null; gpc?: boolean; user_agent?: string | null; metadata?: Json },
        Partial<{ contact_id: string | null; category: string; decision: string; policy_version: string; source: string | null; gpc: boolean; user_agent: string | null; metadata: Json }>
      >;
      family_apps: T<
        { id: string; slug: string; name: string; tagline: string | null; description: string | null; category: string; emoji: string | null; publisher: string; capabilities: string[]; is_official: boolean; is_ai: boolean; rating: number | null; install_count: number; status: string; sort_order: number; created_at: string; updated_at: string },
        { id?: string; slug: string; name: string; tagline?: string | null; description?: string | null; category?: string; emoji?: string | null; publisher?: string; capabilities?: string[]; is_official?: boolean; is_ai?: boolean; rating?: number | null; install_count?: number; status?: string; sort_order?: number },
        Partial<{ name: string; tagline: string | null; description: string | null; category: string; emoji: string | null; publisher: string; capabilities: string[]; is_official: boolean; is_ai: boolean; rating: number | null; install_count: number; status: string; sort_order: number }>
      >;
      family_app_installs: T<
        { id: string; family_id: string; app_id: string; installed_by: string | null; enabled: boolean; config: Json; created_by: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; app_id: string; installed_by?: string | null; enabled?: boolean; config?: Json; created_by?: string | null },
        Partial<{ installed_by: string | null; enabled: boolean; config: Json }>
      >;
      testimonials: T<
        { id: string; author_name: string; author_role: string | null; company: string | null; quote: string; rating: number | null; avatar_url: string | null; is_published: boolean; sort_order: number; created_by: string | null } & Stamps,
        { id?: string; author_name: string; author_role?: string | null; company?: string | null; quote: string; rating?: number | null; avatar_url?: string | null; is_published?: boolean; sort_order?: number; created_by?: string | null },
        Partial<{ author_name: string; author_role: string | null; company: string | null; quote: string; rating: number | null; avatar_url: string | null; is_published: boolean; sort_order: number }>
      >;
      case_studies: T<
        { id: string; title: string; slug: string; industry: string | null; customer_name: string | null; summary: string | null; body: string | null; result_metric: string | null; is_published: boolean; created_by: string | null } & Stamps,
        { id?: string; title: string; slug: string; industry?: string | null; customer_name?: string | null; summary?: string | null; body?: string | null; result_metric?: string | null; is_published?: boolean; created_by?: string | null },
        Partial<{ title: string; slug: string; industry: string | null; customer_name: string | null; summary: string | null; body: string | null; result_metric: string | null; is_published: boolean }>
      >;
      marketing_assets: T<
        { id: string; name: string; kind: string; storage_path: string; mime_type: string | null; size_bytes: number | null; width: number | null; height: number | null; alt_text: string | null; tags: string[]; metadata: Json; content_hash: string | null; license: string; source_url: string | null; attribution: string | null; created_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; name: string; kind?: string; storage_path: string; mime_type?: string | null; size_bytes?: number | null; width?: number | null; height?: number | null; alt_text?: string | null; tags?: string[]; metadata?: Json; content_hash?: string | null; license?: string; source_url?: string | null; attribution?: string | null; created_by?: string | null; deleted_at?: string | null },
        Partial<{ name: string; kind: string; storage_path: string; mime_type: string | null; size_bytes: number | null; width: number | null; height: number | null; alt_text: string | null; tags: string[]; metadata: Json; content_hash: string | null; license: string; source_url: string | null; attribution: string | null; deleted_at: string | null }>
      >;
      marketing_videos: T<
        { id: string; title: string; provider: string; video_id: string | null; url: string | null; storage_path: string | null; poster_url: string | null; captions_url: string | null; transcript: string | null; duration_seconds: number | null; status: string; tags: string[]; metadata: Json; source_hash: string | null; license: string; source_url: string | null; attribution: string | null; created_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; title: string; provider?: string; video_id?: string | null; url?: string | null; storage_path?: string | null; poster_url?: string | null; captions_url?: string | null; transcript?: string | null; duration_seconds?: number | null; status?: string; tags?: string[]; metadata?: Json; source_hash?: string | null; license?: string; source_url?: string | null; attribution?: string | null; created_by?: string | null; deleted_at?: string | null },
        Partial<{ title: string; provider: string; video_id: string | null; url: string | null; storage_path: string | null; poster_url: string | null; captions_url: string | null; transcript: string | null; duration_seconds: number | null; status: string; tags: string[]; metadata: Json; source_hash: string | null; license: string; source_url: string | null; attribution: string | null; deleted_at: string | null }>
      >;
      marketing_exit_intent: T<
        { id: string; name: string; headline: string; body: string | null; cta_label: string | null; cta_href: string | null; match: Json; trigger_config: Json; priority: number; status: string; impressions: number; conversions: number; metadata: Json; created_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; name: string; headline: string; body?: string | null; cta_label?: string | null; cta_href?: string | null; match?: Json; trigger_config?: Json; priority?: number; status?: string; impressions?: number; conversions?: number; metadata?: Json; created_by?: string | null; deleted_at?: string | null },
        Partial<{ name: string; headline: string; body: string | null; cta_label: string | null; cta_href: string | null; match: Json; trigger_config: Json; priority: number; status: string; impressions: number; conversions: number; metadata: Json; deleted_at: string | null }>
      >;
      marketing_push_campaigns: T<
        { id: string; title: string; body: string | null; url: string | null; segment_id: string | null; audience: string; status: string; recipients: number; sent: number; failed: number; skipped: number; clicked: number; sent_at: string | null; metadata: Json; created_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; title: string; body?: string | null; url?: string | null; segment_id?: string | null; audience?: string; status?: string; recipients?: number; sent?: number; failed?: number; skipped?: number; clicked?: number; sent_at?: string | null; metadata?: Json; created_by?: string | null; deleted_at?: string | null },
        Partial<{ title: string; body: string | null; url: string | null; segment_id: string | null; audience: string; status: string; recipients: number; sent: number; failed: number; skipped: number; clicked: number; sent_at: string | null; metadata: Json; deleted_at: string | null }>
      >;
      marketing_personalization_rules: T<
        { id: string; name: string; slot: string; match: Json; variant: Json; priority: number; status: string; metadata: Json; created_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; name: string; slot: string; match?: Json; variant?: Json; priority?: number; status?: string; metadata?: Json; created_by?: string | null; deleted_at?: string | null },
        Partial<{ name: string; slot: string; match: Json; variant: Json; priority: number; status: string; metadata: Json; deleted_at: string | null }>
      >;
      affiliates: T<
        { id: string; name: string; email: string | null; code: string; commission_rate: number; status: string; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; name: string; email?: string | null; code: string; commission_rate?: number; status?: string; notes?: string | null; created_by?: string | null },
        Partial<{ name: string; email: string | null; code: string; commission_rate: number; status: string; notes: string | null }>
      >;
      affiliate_referrals: T<
        { id: string; affiliate_id: string; referred_email: string | null; family_id: string | null; status: string; amount_cents: number; commission_cents: number; converted_at: string | null; paid_at: string | null; created_at: string },
        { id?: string; affiliate_id: string; referred_email?: string | null; family_id?: string | null; status?: string; amount_cents?: number; commission_cents?: number; converted_at?: string | null; paid_at?: string | null; created_at?: string },
        Partial<{ referred_email: string | null; family_id: string | null; status: string; amount_cents: number; commission_cents: number; converted_at: string | null; paid_at: string | null }>
      >;
      competitors: T<
        { id: string; name: string; domain: string | null; ranking: number | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; name: string; domain?: string | null; ranking?: number | null; notes?: string | null; created_by?: string | null },
        Partial<{ name: string; domain: string | null; ranking: number | null; notes: string | null }>
      >;
      keyword_intel: T<
        { id: string; keyword: string; search_volume: number; difficulty: number | null; our_rank: number | null; competitor_id: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; keyword: string; search_volume?: number; difficulty?: number | null; our_rank?: number | null; competitor_id?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ keyword: string; search_volume: number; difficulty: number | null; our_rank: number | null; competitor_id: string | null; notes: string | null }>
      >;
      backlinks: T<
        { id: string; source_domain: string; target_url: string | null; authority: number | null; status: string; discovered_at: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; source_domain: string; target_url?: string | null; authority?: number | null; status?: string; discovered_at?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ source_domain: string; target_url: string | null; authority: number | null; status: string; discovered_at: string | null; notes: string | null }>
      >;
      weather_locations: T<
        { id: string; family_id: string; name: string; admin1: string | null; country: string | null; latitude: number; longitude: number; is_default: boolean; sort_order: number; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; admin1?: string | null; country?: string | null; latitude: number; longitude: number; is_default?: boolean; sort_order?: number; created_by?: string | null },
        Partial<{ name: string; admin1: string | null; country: string | null; latitude: number; longitude: number; is_default: boolean; sort_order: number }>
      >;
      display_layouts: T<
        { id: string; family_id: string; tiles: Json; settings: Json; updated_by: string | null } & Stamps,
        { id?: string; family_id: string; tiles?: Json; settings?: Json; updated_by?: string | null },
        Partial<{ tiles: Json; settings: Json; updated_by: string | null }>
      >;
      referral_codes: T<
        { id: string; family_id: string; code: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; code: string; created_by?: string | null },
        Partial<{ code: string }>
      >;
      referrals: T<
        { id: string; code: string; referrer_family_id: string; referred_family_id: string | null; referred_email: string | null; status: string; source: string | null; referrer_reward_cents: number; referred_reward_cents: number; signed_up_at: string; converted_at: string | null; rewarded_at: string | null; metadata: Json } & Stamps,
        { id?: string; code: string; referrer_family_id: string; referred_family_id?: string | null; referred_email?: string | null; status?: string; source?: string | null; referrer_reward_cents?: number; referred_reward_cents?: number; signed_up_at?: string; converted_at?: string | null; rewarded_at?: string | null; metadata?: Json },
        Partial<{ referred_family_id: string | null; referred_email: string | null; status: string; source: string | null; referrer_reward_cents: number; referred_reward_cents: number; converted_at: string | null; rewarded_at: string | null; metadata: Json }>
      >;
      // ── Admin console (migration 0015) ──────────────────────
      app_settings: T<
        { key: string; value: Json; updated_by: string | null; updated_at: string },
        { key: string; value?: Json; updated_by?: string | null; updated_at?: string },
        Partial<{ value: Json; updated_by: string | null; updated_at: string }>
      >;
      system_backups: T<
        { id: string; label: string; kind: string; status: string; size_bytes: number; location: string | null; row_counts: Json; created_by: string | null; created_at: string; metadata: Json },
        { id?: string; label: string; kind?: string; status?: string; size_bytes?: number; location?: string | null; row_counts?: Json; created_by?: string | null; metadata?: Json },
        Partial<{ label: string; kind: string; status: string; size_bytes: number; location: string | null; row_counts: Json; metadata: Json }>
      >;
      admin_integrations: T<
        { id: string; key: string; name: string; description: string | null; category: string; status: string; config: Json; last_sync_at: string | null; created_by: string | null; updated_by: string | null } & Stamps,
        { id?: string; key: string; name: string; description?: string | null; category?: string; status?: string; config?: Json; last_sync_at?: string | null; created_by?: string | null; updated_by?: string | null },
        Partial<{ name: string; description: string | null; category: string; status: string; config: Json; last_sync_at: string | null; updated_by: string | null }>
      >;
      // ── Bubaly modules (migration 0014) ──────────────────
      family_routines: T<
        { id: string; family_id: string; member_id: string | null; title: string; description: string | null; category: string | null; time_of_day: string | null; days_of_week: number[]; status: string; metadata: Json; created_by: string | null; updated_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; title: string; description?: string | null; category?: string | null; time_of_day?: string | null; days_of_week?: number[]; status?: string; metadata?: Json; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null },
        Partial<{ member_id: string | null; title: string; description: string | null; category: string | null; time_of_day: string | null; days_of_week: number[]; status: string; metadata: Json; updated_by: string | null; deleted_at: string | null }>
      >;
      family_digital_twin_profiles: T<
        { id: string; family_id: string; member_id: string; preferences: Json; responsibilities: Json; strengths: string | null; notes: string | null; ai_insights: string | null; stress_baseline: number; status: string; metadata: Json; created_by: string | null; updated_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; preferences?: Json; responsibilities?: Json; strengths?: string | null; notes?: string | null; ai_insights?: string | null; stress_baseline?: number; status?: string; metadata?: Json; created_by?: string | null; updated_by?: string | null },
        Partial<{ preferences: Json; responsibilities: Json; strengths: string | null; notes: string | null; ai_insights: string | null; stress_baseline: number; status: string; metadata: Json; updated_by: string | null }>
      >;
      family_ai_recommendations: T<
        { id: string; family_id: string; member_id: string | null; category: string; title: string; body: string | null; priority: string; cta_href: string | null; source: string | null; status: string; metadata: Json; created_by: string | null; updated_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; category?: string; title: string; body?: string | null; priority?: string; cta_href?: string | null; source?: string | null; status?: string; metadata?: Json; created_by?: string | null; updated_by?: string | null },
        Partial<{ member_id: string | null; category: string; title: string; body: string | null; priority: string; cta_href: string | null; source: string | null; status: string; metadata: Json; updated_by: string | null }>
      >;
      family_stress_signals: T<
        { id: string; family_id: string; member_id: string | null; signal_type: string; weight: number; source: string | null; occurred_on: string; notes: string | null; status: string; metadata: Json; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; signal_type: string; weight?: number; source?: string | null; occurred_on?: string; notes?: string | null; status?: string; metadata?: Json; created_by?: string | null },
        Partial<{ member_id: string | null; signal_type: string; weight: number; source: string | null; occurred_on: string; notes: string | null; status: string; metadata: Json }>
      >;
      family_stress_predictions: T<
        { id: string; family_id: string; for_date: string; score: number; level: string; factors: Json; suggestions: Json; status: string; metadata: Json; created_by: string | null } & Stamps,
        { id?: string; family_id: string; for_date?: string; score?: number; level?: string; factors?: Json; suggestions?: Json; status?: string; metadata?: Json; created_by?: string | null },
        Partial<{ for_date: string; score: number; level: string; factors: Json; suggestions: Json; status: string; metadata: Json }>
      >;
      routine_runs: T<
        { id: string; family_id: string; rule_id: string; due_at: string; request_id: string | null; status: RoutineRunStatus; detail: string | null; created_at: string },
        { id?: string; family_id: string; rule_id: string; due_at: string; request_id?: string | null; status?: RoutineRunStatus; detail?: string | null },
        Partial<{ request_id: string | null; status: RoutineRunStatus; detail: string | null }>
      >;
      family_automation_rules: T<
        { id: string; family_id: string; name: string; trigger_type: string; trigger_config: Json; action_type: string; action_config: Json; is_enabled: boolean; requires_approval: boolean; last_run_at: string | null; status: string; metadata: Json; schedule_kind: RoutineScheduleKind | null; schedule_expr: string | null; anchor_key: string | null; offset_days: number | null; at_hour: number | null; next_run_at: string | null; said: string | null; source_request_id: string | null; created_by: string | null; updated_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; trigger_type: string; trigger_config?: Json; action_type: string; action_config?: Json; is_enabled?: boolean; requires_approval?: boolean; last_run_at?: string | null; status?: string; metadata?: Json; schedule_kind?: RoutineScheduleKind | null; schedule_expr?: string | null; anchor_key?: string | null; offset_days?: number | null; at_hour?: number | null; next_run_at?: string | null; said?: string | null; source_request_id?: string | null; created_by?: string | null; updated_by?: string | null },
        Partial<{ name: string; trigger_type: string; trigger_config: Json; action_type: string; action_config: Json; is_enabled: boolean; requires_approval: boolean; last_run_at: string | null; status: string; metadata: Json; updated_by: string | null; schedule_kind: RoutineScheduleKind | null; schedule_expr: string | null; anchor_key: string | null; offset_days: number | null; at_hour: number | null; next_run_at: string | null; said: string | null; source_request_id: string | null }>
      >;
      // Also the AI run + continuation queue (0250). `status` is the legacy 0022
      // free-text column the concierge/autopilot surfaces still read and write;
      // `state` is the constrained §10 lifecycle the executor owns.
      family_automation_runs: T<
        { id: string; family_id: string; rule_id: string | null; trigger_type: string | null; status: string; summary: string | null; result: Json; approved_by: string | null; approved_at: string | null; metadata: Json; created_by: string | null; request_id: string | null; plan_id: string | null; requested_by_member_id: string | null; run_type: AiRunType; state: AiRunLifecycleState; current_step_id: string | null; progress: Json; started_at: string | null; completed_at: string | null; error: string | null; cancel_requested_at: string | null; paused_at: string | null; run_after: string; lease_owner: string | null; lease_expires_at: string | null; attempt: number; max_attempts: number; idempotency_key: string | null } & Stamps,
        { id?: string; family_id: string; rule_id?: string | null; trigger_type?: string | null; status?: string; summary?: string | null; result?: Json; approved_by?: string | null; approved_at?: string | null; metadata?: Json; created_by?: string | null; request_id?: string | null; plan_id?: string | null; requested_by_member_id?: string | null; run_type?: AiRunType; state?: AiRunLifecycleState; current_step_id?: string | null; progress?: Json; started_at?: string | null; completed_at?: string | null; error?: string | null; cancel_requested_at?: string | null; paused_at?: string | null; run_after?: string; lease_owner?: string | null; lease_expires_at?: string | null; attempt?: number; max_attempts?: number; idempotency_key?: string | null },
        Partial<{ status: string; summary: string | null; result: Json; approved_by: string | null; approved_at: string | null; metadata: Json; plan_id: string | null; state: AiRunLifecycleState; current_step_id: string | null; progress: Json; started_at: string | null; completed_at: string | null; error: string | null; cancel_requested_at: string | null; paused_at: string | null; run_after: string; lease_owner: string | null; lease_expires_at: string | null; attempt: number }>
      >;
      family_knowledge_nodes: T<
        { id: string; family_id: string; member_id: string | null; node_type: string; label: string; ref_table: string | null; ref_id: string | null; weight: number; status: string; metadata: Json; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; node_type: string; label: string; ref_table?: string | null; ref_id?: string | null; weight?: number; status?: string; metadata?: Json; created_by?: string | null },
        Partial<{ member_id: string | null; node_type: string; label: string; ref_table: string | null; ref_id: string | null; weight: number; status: string; metadata: Json }>
      >;
      family_knowledge_edges: T<
        { id: string; family_id: string; source_id: string; target_id: string; relation: string; weight: number; status: string; metadata: Json; created_by: string | null } & Stamps,
        { id?: string; family_id: string; source_id: string; target_id: string; relation?: string; weight?: number; status?: string; metadata?: Json; created_by?: string | null },
        Partial<{ relation: string; weight: number; status: string; metadata: Json }>
      >;
      family_emergency_contacts: T<
        { id: string; family_id: string; member_id: string | null; name: string; relationship: string | null; phone: string | null; alt_phone: string | null; email: string | null; address: string | null; is_primary: boolean; can_pickup: boolean; priority: number; notes: string | null; status: string; metadata: Json; created_by: string | null; updated_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; name: string; relationship?: string | null; phone?: string | null; alt_phone?: string | null; email?: string | null; address?: string | null; is_primary?: boolean; can_pickup?: boolean; priority?: number; notes?: string | null; status?: string; metadata?: Json; created_by?: string | null; updated_by?: string | null },
        Partial<{ member_id: string | null; name: string; relationship: string | null; phone: string | null; alt_phone: string | null; email: string | null; address: string | null; is_primary: boolean; can_pickup: boolean; priority: number; notes: string | null; status: string; metadata: Json; updated_by: string | null }>
      >;
      family_emergency_plans: T<
        { id: string; family_id: string; title: string; plan_type: string | null; content: string | null; safe_location: string | null; instructions: string | null; is_active: boolean; status: string; metadata: Json; created_by: string | null; updated_by: string | null } & Stamps,
        { id?: string; family_id: string; title: string; plan_type?: string | null; content?: string | null; safe_location?: string | null; instructions?: string | null; is_active?: boolean; status?: string; metadata?: Json; created_by?: string | null; updated_by?: string | null },
        Partial<{ title: string; plan_type: string | null; content: string | null; safe_location: string | null; instructions: string | null; is_active: boolean; status: string; metadata: Json; updated_by: string | null }>
      >;
      family_memories: T<
        { id: string; family_id: string; member_id: string | null; title: string; body: string | null; kind: string; memory_date: string; media_path: string | null; tags: string[]; is_favorite: boolean; status: string; metadata: Json; created_by: string | null; updated_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; title: string; body?: string | null; kind?: string; memory_date?: string; media_path?: string | null; tags?: string[]; is_favorite?: boolean; status?: string; metadata?: Json; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null },
        Partial<{ member_id: string | null; title: string; body: string | null; kind: string; memory_date: string; media_path: string | null; tags: string[]; is_favorite: boolean; status: string; metadata: Json; updated_by: string | null; deleted_at: string | null }>
      >;
      family_milestones: T<
        { id: string; family_id: string; member_id: string | null; title: string; description: string | null; milestone_date: string; category: string | null; status: string; metadata: Json; created_by: string | null; updated_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; title: string; description?: string | null; milestone_date?: string; category?: string | null; status?: string; metadata?: Json; created_by?: string | null; updated_by?: string | null },
        Partial<{ member_id: string | null; title: string; description: string | null; milestone_date: string; category: string | null; status: string; metadata: Json; updated_by: string | null }>
      >;

      // ---- Social command center (migration 0034) ----
      social_providers: T<
        { platform: SocialPlatformEnum; label: string; capabilities: Json; auth_method: string; is_enabled: boolean; needs_app_review: boolean; char_limit: number; docs_url: string | null; notes: string | null } & Stamps,
        { platform: SocialPlatformEnum; label: string; capabilities?: Json; auth_method?: string; is_enabled?: boolean; needs_app_review?: boolean; char_limit?: number; docs_url?: string | null; notes?: string | null },
        Partial<{ label: string; capabilities: Json; auth_method: string; is_enabled: boolean; needs_app_review: boolean; char_limit: number; docs_url: string | null; notes: string | null }>
      >;
      social_accounts: T<
        { id: string; family_id: string; user_id: string; platform: SocialPlatformEnum; account_type: string | null; provider_account_id: string | null; handle: string | null; display_name: string | null; avatar_url: string | null; profile_url: string | null; status: SocialAccountStatus; health: string; scopes: string[]; last_synced_at: string | null; last_error: string | null; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; user_id: string; platform: SocialPlatformEnum; account_type?: string | null; provider_account_id?: string | null; handle?: string | null; display_name?: string | null; avatar_url?: string | null; profile_url?: string | null; status?: SocialAccountStatus; health?: string; scopes?: string[]; last_synced_at?: string | null; last_error?: string | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ account_type: string | null; handle: string | null; display_name: string | null; avatar_url: string | null; profile_url: string | null; status: SocialAccountStatus; health: string; scopes: string[]; last_synced_at: string | null; last_error: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      social_account_tokens: T<
        { id: string; account_id: string; family_id: string | null; platform: SocialPlatformEnum; provider_account_id: string | null; access_token_enc: string | null; refresh_token_enc: string | null; token_type: string | null; scope: string | null; expires_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; account_id: string; family_id?: string | null; platform: SocialPlatformEnum; provider_account_id?: string | null; access_token_enc?: string | null; refresh_token_enc?: string | null; token_type?: string | null; scope?: string | null; expires_at?: string | null; created_by?: string | null; updated_by?: string | null; metadata?: Json },
        Partial<{ access_token_enc: string | null; refresh_token_enc: string | null; token_type: string | null; scope: string | null; expires_at: string | null; updated_by: string | null; metadata: Json }>
      >;
      social_feed_items: T<
        { id: string; family_id: string; account_id: string; platform: SocialPlatformEnum; provider_object_id: string | null; author_name: string | null; author_handle: string | null; author_avatar_url: string | null; permalink_url: string | null; body: string | null; media_type: string | null; media: Json; metrics: Json; posted_at: string | null; fetched_at: string; status: string; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; account_id: string; platform: SocialPlatformEnum; provider_object_id?: string | null; author_name?: string | null; author_handle?: string | null; author_avatar_url?: string | null; permalink_url?: string | null; body?: string | null; media_type?: string | null; media?: Json; metrics?: Json; posted_at?: string | null; fetched_at?: string; status?: string; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ author_name: string | null; author_handle: string | null; permalink_url: string | null; body: string | null; media_type: string | null; media: Json; metrics: Json; posted_at: string | null; status: string; deleted_at: string | null; metadata: Json }>
      >;
      social_campaigns: T<
        { id: string; family_id: string; user_id: string | null; name: string; description: string | null; status: string; goal: string | null; color: string | null; starts_on: string | null; ends_on: string | null; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; user_id?: string | null; name: string; description?: string | null; status?: string; goal?: string | null; color?: string | null; starts_on?: string | null; ends_on?: string | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ name: string; description: string | null; status: string; goal: string | null; color: string | null; starts_on: string | null; ends_on: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      social_posts: T<
        { id: string; family_id: string; user_id: string | null; campaign_id: string | null; title: string | null; body: string; kind: SocialPostKind; status: SocialPostStatusEnum; link: string | null; scheduled_for: string | null; published_at: string | null; approval_status: SocialApprovalStatus; approved_by: string | null; approved_at: string | null; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; user_id?: string | null; campaign_id?: string | null; title?: string | null; body?: string; kind?: SocialPostKind; status?: SocialPostStatusEnum; link?: string | null; scheduled_for?: string | null; published_at?: string | null; approval_status?: SocialApprovalStatus; approved_by?: string | null; approved_at?: string | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ campaign_id: string | null; title: string | null; body: string; kind: SocialPostKind; status: SocialPostStatusEnum; link: string | null; scheduled_for: string | null; published_at: string | null; approval_status: SocialApprovalStatus; approved_by: string | null; approved_at: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      social_post_variants: T<
        { id: string; post_id: string; family_id: string; platform: SocialPlatformEnum; body: string; hashtags: string[]; mentions: string[]; char_count: number; status: string; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; post_id: string; family_id: string; platform: SocialPlatformEnum; body?: string; hashtags?: string[]; mentions?: string[]; char_count?: number; status?: string; created_by?: string | null; updated_by?: string | null; metadata?: Json },
        Partial<{ body: string; hashtags: string[]; mentions: string[]; char_count: number; status: string; updated_by: string | null; metadata: Json }>
      >;
      social_post_targets: T<
        { id: string; post_id: string; family_id: string; account_id: string | null; platform: SocialPlatformEnum; status: SocialTargetStatus; provider_object_id: string | null; permalink_url: string | null; error: string | null; scheduled_for: string | null; published_at: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; post_id: string; family_id: string; account_id?: string | null; platform: SocialPlatformEnum; status?: SocialTargetStatus; provider_object_id?: string | null; permalink_url?: string | null; error?: string | null; scheduled_for?: string | null; published_at?: string | null; created_by?: string | null; updated_by?: string | null; metadata?: Json },
        Partial<{ account_id: string | null; status: SocialTargetStatus; provider_object_id: string | null; permalink_url: string | null; error: string | null; scheduled_for: string | null; published_at: string | null; updated_by: string | null; metadata: Json }>
      >;
      social_media_library: T<
        { id: string; family_id: string; user_id: string | null; kind: SocialAssetKind; title: string | null; url: string | null; storage_path: string | null; mime_type: string | null; width: number | null; height: number | null; duration_ms: number | null; size_bytes: number | null; alt_text: string | null; tags: string[]; source: string; status: string; usage_count: number; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; user_id?: string | null; kind: SocialAssetKind; title?: string | null; url?: string | null; storage_path?: string | null; mime_type?: string | null; width?: number | null; height?: number | null; duration_ms?: number | null; size_bytes?: number | null; alt_text?: string | null; tags?: string[]; source?: string; status?: string; usage_count?: number; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ title: string | null; url: string | null; storage_path: string | null; mime_type: string | null; alt_text: string | null; tags: string[]; source: string; status: string; usage_count: number; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      social_post_assets: T<
        { id: string; post_id: string; family_id: string; asset_id: string; platform: SocialPlatformEnum | null; position: number; role: string; created_by: string | null; metadata: Json } & Stamps,
        { id?: string; post_id: string; family_id: string; asset_id: string; platform?: SocialPlatformEnum | null; position?: number; role?: string; created_by?: string | null; metadata?: Json },
        Partial<{ platform: SocialPlatformEnum | null; position: number; role: string; metadata: Json }>
      >;
      social_schedules: T<
        { id: string; post_id: string; family_id: string; scheduled_for: string; timezone: string; recurrence: string; status: string; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; post_id: string; family_id: string; scheduled_for: string; timezone?: string; recurrence?: string; status?: string; created_by?: string | null; updated_by?: string | null; metadata?: Json },
        Partial<{ scheduled_for: string; timezone: string; recurrence: string; status: string; updated_by: string | null; metadata: Json }>
      >;
      social_publish_jobs: T<
        { id: string; post_id: string; family_id: string; status: SocialJobStatus; scheduled_for: string; attempts: number; max_attempts: number; next_attempt_at: string | null; idempotency_key: string | null; last_error: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; post_id: string; family_id: string; status?: SocialJobStatus; scheduled_for?: string; attempts?: number; max_attempts?: number; next_attempt_at?: string | null; idempotency_key?: string | null; last_error?: string | null; created_by?: string | null; updated_by?: string | null; metadata?: Json },
        Partial<{ status: SocialJobStatus; scheduled_for: string; attempts: number; next_attempt_at: string | null; last_error: string | null; updated_by: string | null; metadata: Json }>
      >;
      social_publish_results: T<
        { id: string; job_id: string | null; target_id: string | null; post_id: string; family_id: string; account_id: string | null; platform: SocialPlatformEnum; status: SocialTargetStatus; provider_object_id: string | null; permalink_url: string | null; error_code: string | null; error_message: string | null; raw_response: Json; attempted_at: string; created_by: string | null; metadata: Json } & Stamps,
        { id?: string; job_id?: string | null; target_id?: string | null; post_id: string; family_id: string; account_id?: string | null; platform: SocialPlatformEnum; status?: SocialTargetStatus; provider_object_id?: string | null; permalink_url?: string | null; error_code?: string | null; error_message?: string | null; raw_response?: Json; attempted_at?: string; created_by?: string | null; metadata?: Json },
        Partial<{ status: SocialTargetStatus; provider_object_id: string | null; permalink_url: string | null; error_code: string | null; error_message: string | null; raw_response: Json; metadata: Json }>
      >;
      social_comments: T<
        { id: string; family_id: string; account_id: string | null; platform: SocialPlatformEnum; provider_object_id: string | null; feed_item_id: string | null; parent_provider_id: string | null; kind: string; author_name: string | null; author_handle: string | null; body: string | null; permalink_url: string | null; status: SocialInboxStatus; assigned_to: string | null; posted_at: string | null; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; account_id?: string | null; platform: SocialPlatformEnum; provider_object_id?: string | null; feed_item_id?: string | null; parent_provider_id?: string | null; kind?: string; author_name?: string | null; author_handle?: string | null; body?: string | null; permalink_url?: string | null; status?: SocialInboxStatus; assigned_to?: string | null; posted_at?: string | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ kind: string; body: string | null; status: SocialInboxStatus; assigned_to: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      social_messages: T<
        { id: string; family_id: string; account_id: string | null; platform: SocialPlatformEnum; provider_object_id: string | null; thread_id: string | null; direction: string; author_name: string | null; author_handle: string | null; body: string | null; status: SocialInboxStatus; assigned_to: string | null; posted_at: string | null; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; account_id?: string | null; platform: SocialPlatformEnum; provider_object_id?: string | null; thread_id?: string | null; direction?: string; author_name?: string | null; author_handle?: string | null; body?: string | null; status?: SocialInboxStatus; assigned_to?: string | null; posted_at?: string | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ direction: string; body: string | null; status: SocialInboxStatus; assigned_to: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      social_analytics_snapshots: T<
        { id: string; family_id: string; account_id: string | null; post_id: string | null; platform: SocialPlatformEnum; captured_for: string; impressions: number; reach: number; likes: number; comments: number; shares: number; saves: number; clicks: number; views: number; watch_time_seconds: number; followers: number; engagement_rate: number; metrics: Json; created_by: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; account_id?: string | null; post_id?: string | null; platform: SocialPlatformEnum; captured_for?: string; impressions?: number; reach?: number; likes?: number; comments?: number; shares?: number; saves?: number; clicks?: number; views?: number; watch_time_seconds?: number; followers?: number; engagement_rate?: number; metrics?: Json; created_by?: string | null; metadata?: Json },
        Partial<{ impressions: number; reach: number; likes: number; comments: number; shares: number; saves: number; clicks: number; views: number; watch_time_seconds: number; followers: number; engagement_rate: number; metrics: Json; metadata: Json }>
      >;
      social_ai_generations: T<
        { id: string; family_id: string; user_id: string | null; post_id: string | null; kind: string; platform: SocialPlatformEnum | null; prompt: string | null; input: Json; output: Json; model: string | null; tokens: number; status: string; created_by: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; user_id?: string | null; post_id?: string | null; kind: string; platform?: SocialPlatformEnum | null; prompt?: string | null; input?: Json; output?: Json; model?: string | null; tokens?: number; status?: string; created_by?: string | null; metadata?: Json },
        Partial<{ post_id: string | null; output: Json; status: string; tokens: number; metadata: Json }>
      >;
      social_content_templates: T<
        { id: string; family_id: string; user_id: string | null; name: string; kind: SocialPostKind; body: string; platforms: string[]; hashtags: string[]; status: string; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; user_id?: string | null; name: string; kind?: SocialPostKind; body?: string; platforms?: string[]; hashtags?: string[]; status?: string; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ name: string; kind: SocialPostKind; body: string; platforms: string[]; hashtags: string[]; status: string; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      social_calendar_items: T<
        { id: string; family_id: string; post_id: string | null; campaign_id: string | null; title: string | null; platform: SocialPlatformEnum | null; scheduled_for: string; status: string; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; post_id?: string | null; campaign_id?: string | null; title?: string | null; platform?: SocialPlatformEnum | null; scheduled_for: string; status?: string; created_by?: string | null; updated_by?: string | null; metadata?: Json },
        Partial<{ title: string | null; platform: SocialPlatformEnum | null; scheduled_for: string; status: string; updated_by: string | null; metadata: Json }>
      >;
      social_webhook_events: T<
        { id: string; family_id: string | null; account_id: string | null; platform: SocialPlatformEnum; provider_object_id: string | null; event_type: string | null; payload: Json; signature_ok: boolean; processed: boolean; processed_at: string | null; received_at: string; metadata: Json } & Stamps,
        { id?: string; family_id?: string | null; account_id?: string | null; platform: SocialPlatformEnum; provider_object_id?: string | null; event_type?: string | null; payload?: Json; signature_ok?: boolean; processed?: boolean; processed_at?: string | null; received_at?: string; metadata?: Json },
        Partial<{ processed: boolean; signature_ok: boolean; processed_at: string | null; metadata: Json }>
      >;
      social_provider_errors: T<
        { id: string; family_id: string | null; account_id: string | null; platform: SocialPlatformEnum; scope: string | null; error_code: string | null; error_message: string | null; context: Json; occurred_at: string; created_by: string | null; metadata: Json } & Stamps,
        { id?: string; family_id?: string | null; account_id?: string | null; platform: SocialPlatformEnum; scope?: string | null; error_code?: string | null; error_message?: string | null; context?: Json; occurred_at?: string; created_by?: string | null; metadata?: Json },
        Partial<{ error_code: string | null; error_message: string | null; context: Json; metadata: Json }>
      >;
      social_usage_events: T<
        { id: string; family_id: string; user_id: string | null; platform: SocialPlatformEnum | null; kind: string; quantity: number; unit: string; occurred_at: string; metadata: Json } & Stamps,
        { id?: string; family_id: string; user_id?: string | null; platform?: SocialPlatformEnum | null; kind: string; quantity?: number; unit?: string; occurred_at?: string; metadata?: Json },
        Partial<{ quantity: number; unit: string; metadata: Json }>
      >;
      social_audit_logs: T<
        { id: string; family_id: string; actor_id: string | null; action: string; entity_type: string | null; entity_id: string | null; summary: string | null; before: Json | null; after: Json | null; ip: string | null; occurred_at: string; metadata: Json } & Stamps,
        { id?: string; family_id: string; actor_id?: string | null; action: string; entity_type?: string | null; entity_id?: string | null; summary?: string | null; before?: Json | null; after?: Json | null; ip?: string | null; occurred_at?: string; metadata?: Json },
        Partial<{ summary: string | null; metadata: Json }>
      >;
      social_settings: T<
        { id: string; family_id: string; default_timezone: string; default_platforms: string[]; require_approval: boolean; auto_hashtags: boolean; signature: string | null; ai_tone: string; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; default_timezone?: string; default_platforms?: string[]; require_approval?: boolean; auto_hashtags?: boolean; signature?: string | null; ai_tone?: string; created_by?: string | null; updated_by?: string | null; metadata?: Json },
        Partial<{ default_timezone: string; default_platforms: string[]; require_approval: boolean; auto_hashtags: boolean; signature: string | null; ai_tone: string; updated_by: string | null; metadata: Json }>
      >;
      social_access_permissions: T<
        { id: string; family_id: string; user_id: string; member_id: string | null; social_role: SocialRoleEnum; status: string; granted_by: string | null; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; user_id: string; member_id?: string | null; social_role?: SocialRoleEnum; status?: string; granted_by?: string | null; created_by?: string | null; updated_by?: string | null; metadata?: Json },
        Partial<{ member_id: string | null; social_role: SocialRoleEnum; status: string; updated_by: string | null; metadata: Json }>
      >;

      // ---- Push devices (migration 0035) ----
      push_devices: T<
        { id: string; user_id: string; family_id: string | null; platform: string; provider: string; endpoint: string | null; p256dh: string | null; auth: string | null; token: string | null; device_key: string; user_agent: string | null; enabled: boolean; last_seen_at: string; created_by: string | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; user_id: string; family_id?: string | null; platform?: string; provider?: string; endpoint?: string | null; p256dh?: string | null; auth?: string | null; token?: string | null; device_key: string; user_agent?: string | null; enabled?: boolean; last_seen_at?: string; created_by?: string | null; updated_by?: string | null; metadata?: Json },
        Partial<{ family_id: string | null; platform: string; provider: string; endpoint: string | null; p256dh: string | null; auth: string | null; token: string | null; user_agent: string | null; enabled: boolean; last_seen_at: string; updated_by: string | null; metadata: Json }>
      >;

      // ---- Home & Maintenance command center (migration 0036) ----
      homes: T<
        { id: string; family_id: string; name: string; address: string | null; home_type: string | null; year_built: number | null; square_feet: number | null; bedrooms: number | null; bathrooms: number | null; purchase_date: string | null; is_primary: boolean; notes: string | null; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; name: string; address?: string | null; home_type?: string | null; year_built?: number | null; square_feet?: number | null; bedrooms?: number | null; bathrooms?: number | null; purchase_date?: string | null; is_primary?: boolean; notes?: string | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ name: string; address: string | null; home_type: string | null; year_built: number | null; square_feet: number | null; bedrooms: number | null; bathrooms: number | null; purchase_date: string | null; is_primary: boolean; notes: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      home_contractors: T<
        { id: string; family_id: string; name: string; trade: string | null; company: string | null; phone: string | null; email: string | null; website: string | null; rating: number | null; hourly_rate: number | null; is_preferred: boolean; last_used_on: string | null; notes: string | null; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; name: string; trade?: string | null; company?: string | null; phone?: string | null; email?: string | null; website?: string | null; rating?: number | null; hourly_rate?: number | null; is_preferred?: boolean; last_used_on?: string | null; notes?: string | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ name: string; trade: string | null; company: string | null; phone: string | null; email: string | null; website: string | null; rating: number | null; hourly_rate: number | null; is_preferred: boolean; last_used_on: string | null; notes: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      home_warranties: T<
        { id: string; family_id: string; home_id: string | null; asset_id: string | null; name: string; provider: string | null; warranty_type: string; policy_number: string | null; coverage: string | null; starts_on: string | null; expires_on: string | null; cost: number | null; premium_period: string | null; claim_phone: string | null; claim_url: string | null; claim_email: string | null; document_id: string | null; status: string; notes: string | null; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; home_id?: string | null; asset_id?: string | null; name: string; provider?: string | null; warranty_type?: string; policy_number?: string | null; coverage?: string | null; starts_on?: string | null; expires_on?: string | null; cost?: number | null; premium_period?: string | null; claim_phone?: string | null; claim_url?: string | null; claim_email?: string | null; document_id?: string | null; status?: string; notes?: string | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ home_id: string | null; asset_id: string | null; name: string; provider: string | null; warranty_type: string; policy_number: string | null; coverage: string | null; starts_on: string | null; expires_on: string | null; cost: number | null; premium_period: string | null; claim_phone: string | null; claim_url: string | null; claim_email: string | null; document_id: string | null; status: string; notes: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      home_service_records: T<
        { id: string; family_id: string; home_id: string | null; asset_id: string | null; contractor_id: string | null; title: string; service_date: string; provider: string | null; cost: number | null; description: string | null; next_due_on: string | null; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; home_id?: string | null; asset_id?: string | null; contractor_id?: string | null; title: string; service_date?: string; provider?: string | null; cost?: number | null; description?: string | null; next_due_on?: string | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ home_id: string | null; asset_id: string | null; contractor_id: string | null; title: string; service_date: string; provider: string | null; cost: number | null; description: string | null; next_due_on: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      home_ai_logs: T<
        { id: string; family_id: string; user_id: string | null; asset_id: string | null; kind: string; input: Json; output: Json; model: string | null; status: string; created_by: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; user_id?: string | null; asset_id?: string | null; kind: string; input?: Json; output?: Json; model?: string | null; status?: string; created_by?: string | null; metadata?: Json },
        Partial<{ output: Json; status: string; metadata: Json }>
      >;

      // ---- Auto / vehicles command center (migration 0037) ----
      vehicles: T<
        { id: string; family_id: string; nickname: string | null; make: string | null; model: string | null; year: number | null; trim: string | null; color: string | null; vin: string | null; license_plate: string | null; plate_state: string | null; body_type: string | null; fuel_type: string | null; mileage: number | null; purchase_date: string | null; primary_driver: string | null; status: string; photo_url: string | null; notes: string | null; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; nickname?: string | null; make?: string | null; model?: string | null; year?: number | null; trim?: string | null; color?: string | null; vin?: string | null; license_plate?: string | null; plate_state?: string | null; body_type?: string | null; fuel_type?: string | null; mileage?: number | null; purchase_date?: string | null; primary_driver?: string | null; status?: string; photo_url?: string | null; notes?: string | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ nickname: string | null; make: string | null; model: string | null; year: number | null; trim: string | null; color: string | null; vin: string | null; license_plate: string | null; plate_state: string | null; body_type: string | null; fuel_type: string | null; mileage: number | null; purchase_date: string | null; primary_driver: string | null; status: string; photo_url: string | null; notes: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      driver_licenses: T<
        { id: string; family_id: string; member_id: string | null; holder_name: string; license_number: string | null; state: string | null; license_class: string | null; endorsements: string | null; restrictions: string | null; issued_on: string | null; expires_on: string | null; status: string; document_id: string | null; notes: string | null; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; holder_name: string; license_number?: string | null; state?: string | null; license_class?: string | null; endorsements?: string | null; restrictions?: string | null; issued_on?: string | null; expires_on?: string | null; status?: string; document_id?: string | null; notes?: string | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ member_id: string | null; holder_name: string; license_number: string | null; state: string | null; license_class: string | null; endorsements: string | null; restrictions: string | null; issued_on: string | null; expires_on: string | null; status: string; document_id: string | null; notes: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      vehicle_registrations: T<
        { id: string; family_id: string; vehicle_id: string | null; plate: string | null; state: string | null; registered_on: string | null; expires_on: string | null; fee: number | null; document_id: string | null; status: string; notes: string | null; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; vehicle_id?: string | null; plate?: string | null; state?: string | null; registered_on?: string | null; expires_on?: string | null; fee?: number | null; document_id?: string | null; status?: string; notes?: string | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ vehicle_id: string | null; plate: string | null; state: string | null; registered_on: string | null; expires_on: string | null; fee: number | null; document_id: string | null; status: string; notes: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      vehicle_inspections: T<
        { id: string; family_id: string; vehicle_id: string | null; inspection_type: string; station: string | null; inspected_on: string | null; expires_on: string | null; result: string | null; document_id: string | null; notes: string | null; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; vehicle_id?: string | null; inspection_type?: string; station?: string | null; inspected_on?: string | null; expires_on?: string | null; result?: string | null; document_id?: string | null; notes?: string | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ vehicle_id: string | null; inspection_type: string; station: string | null; inspected_on: string | null; expires_on: string | null; result: string | null; document_id: string | null; notes: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      auto_insurance_policies: T<
        { id: string; family_id: string; vehicle_id: string | null; provider: string | null; policy_number: string | null; naic: string | null; coverage_summary: string | null; liability_limits: string | null; deductible_collision: number | null; deductible_comprehensive: number | null; agent_name: string | null; agent_phone: string | null; claims_phone: string | null; roadside_phone: string | null; effective_on: string | null; expires_on: string | null; premium: number | null; premium_period: string | null; document_id: string | null; is_active: boolean; status: string; notes: string | null; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; vehicle_id?: string | null; provider?: string | null; policy_number?: string | null; naic?: string | null; coverage_summary?: string | null; liability_limits?: string | null; deductible_collision?: number | null; deductible_comprehensive?: number | null; agent_name?: string | null; agent_phone?: string | null; claims_phone?: string | null; roadside_phone?: string | null; effective_on?: string | null; expires_on?: string | null; premium?: number | null; premium_period?: string | null; document_id?: string | null; is_active?: boolean; status?: string; notes?: string | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ vehicle_id: string | null; provider: string | null; policy_number: string | null; naic: string | null; coverage_summary: string | null; liability_limits: string | null; deductible_collision: number | null; deductible_comprehensive: number | null; agent_name: string | null; agent_phone: string | null; claims_phone: string | null; roadside_phone: string | null; effective_on: string | null; expires_on: string | null; premium: number | null; premium_period: string | null; document_id: string | null; is_active: boolean; status: string; notes: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      rental_cars: T<
        { id: string; family_id: string; company: string | null; confirmation_number: string | null; pickup_location: string | null; dropoff_location: string | null; pickup_at: string | null; return_at: string | null; vehicle_desc: string | null; daily_rate: number | null; total_cost: number | null; coverage: string | null; driver_member_id: string | null; status: string; document_id: string | null; notes: string | null; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; company?: string | null; confirmation_number?: string | null; pickup_location?: string | null; dropoff_location?: string | null; pickup_at?: string | null; return_at?: string | null; vehicle_desc?: string | null; daily_rate?: number | null; total_cost?: number | null; coverage?: string | null; driver_member_id?: string | null; status?: string; document_id?: string | null; notes?: string | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ company: string | null; confirmation_number: string | null; pickup_location: string | null; dropoff_location: string | null; pickup_at: string | null; return_at: string | null; vehicle_desc: string | null; daily_rate: number | null; total_cost: number | null; coverage: string | null; driver_member_id: string | null; status: string; document_id: string | null; notes: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      auto_service_records: T<
        { id: string; family_id: string; vehicle_id: string | null; title: string; service_date: string; provider: string | null; cost: number | null; mileage: number | null; description: string | null; next_due_on: string | null; next_due_mileage: number | null; created_by: string | null; updated_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; vehicle_id?: string | null; title: string; service_date?: string; provider?: string | null; cost?: number | null; mileage?: number | null; description?: string | null; next_due_on?: string | null; next_due_mileage?: number | null; created_by?: string | null; updated_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ vehicle_id: string | null; title: string; service_date: string; provider: string | null; cost: number | null; mileage: number | null; description: string | null; next_due_on: string | null; next_due_mileage: number | null; updated_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      auto_ai_logs: T<
        { id: string; family_id: string; user_id: string | null; vehicle_id: string | null; kind: string; input: Json; output: Json; model: string | null; status: string; created_by: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; user_id?: string | null; vehicle_id?: string | null; kind: string; input?: Json; output?: Json; model?: string | null; status?: string; created_by?: string | null; metadata?: Json },
        Partial<{ output: Json; status: string; metadata: Json }>
      >;

      // ---- Surveys / NPS / CSAT / CES (migration 0040) ----
      surveys: T<
        { id: string; slug: string; name: string; type: string; question: string; scale_min: number; scale_max: number; low_label: string | null; high_label: string | null; follow_up_question: string | null; thank_you_message: string | null; status: string; audience: string | null; created_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; slug: string; name: string; type?: string; question: string; scale_min?: number; scale_max?: number; low_label?: string | null; high_label?: string | null; follow_up_question?: string | null; thank_you_message?: string | null; status?: string; audience?: string | null; created_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ slug: string; name: string; type: string; question: string; scale_min: number; scale_max: number; low_label: string | null; high_label: string | null; follow_up_question: string | null; thank_you_message: string | null; status: string; audience: string | null; deleted_at: string | null; metadata: Json }>
      >;
      survey_responses: T<
        { id: string; survey_id: string; score: number | null; comment: string | null; respondent_email: string | null; respondent_family_id: string | null; channel: string; user_agent: string | null; submitted_at: string; metadata: Json } & Stamps,
        { id?: string; survey_id: string; score?: number | null; comment?: string | null; respondent_email?: string | null; respondent_family_id?: string | null; channel?: string; user_agent?: string | null; submitted_at?: string; metadata?: Json },
        Partial<{ score: number | null; comment: string | null; respondent_email: string | null; channel: string; metadata: Json }>
      >;

      // ---- Reviews & Reputation (migration 0041) ----
      reviews: T<
        { id: string; rating: number; title: string | null; body: string | null; author_name: string | null; author_email: string | null; source: string; status: string; reply: string | null; replied_at: string | null; replied_by: string | null; family_id: string | null; survey_response_id: string | null; submitted_at: string; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; rating: number; title?: string | null; body?: string | null; author_name?: string | null; author_email?: string | null; source?: string; status?: string; reply?: string | null; replied_at?: string | null; replied_by?: string | null; family_id?: string | null; survey_response_id?: string | null; submitted_at?: string; deleted_at?: string | null; metadata?: Json },
        Partial<{ rating: number; title: string | null; body: string | null; author_name: string | null; author_email: string | null; source: string; status: string; reply: string | null; replied_at: string | null; replied_by: string | null; deleted_at: string | null; metadata: Json }>
      >;
      reputation_settings: T<
        { id: string; singleton: boolean; google_url: string | null; app_store_url: string | null; play_store_url: string | null; trustpilot_url: string | null; request_headline: string | null; request_message: string | null; thank_you_high: string | null; thank_you_low: string | null; min_public_rating: number; auto_approve_min: number | null; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; singleton?: boolean; google_url?: string | null; app_store_url?: string | null; play_store_url?: string | null; trustpilot_url?: string | null; request_headline?: string | null; request_message?: string | null; thank_you_high?: string | null; thank_you_low?: string | null; min_public_rating?: number; auto_approve_min?: number | null; updated_by?: string | null; metadata?: Json },
        Partial<{ google_url: string | null; app_store_url: string | null; play_store_url: string | null; trustpilot_url: string | null; request_headline: string | null; request_message: string | null; thank_you_high: string | null; thank_you_low: string | null; min_public_rating: number; auto_approve_min: number | null; updated_by: string | null; metadata: Json }>
      >;

      // ---- Loyalty & Rewards (migration 0042) ----
      loyalty_settings: T<
        { id: string; singleton: boolean; enabled: boolean; program_name: string; points_label: string; earn_signup: number; earn_referral: number; earn_review: number; earn_per_dollar: number; tier_silver_at: number; tier_gold_at: number; updated_by: string | null; metadata: Json } & Stamps,
        { id?: string; singleton?: boolean; enabled?: boolean; program_name?: string; points_label?: string; earn_signup?: number; earn_referral?: number; earn_review?: number; earn_per_dollar?: number; tier_silver_at?: number; tier_gold_at?: number; updated_by?: string | null; metadata?: Json },
        Partial<{ enabled: boolean; program_name: string; points_label: string; earn_signup: number; earn_referral: number; earn_review: number; earn_per_dollar: number; tier_silver_at: number; tier_gold_at: number; updated_by: string | null; metadata: Json }>
      >;
      loyalty_rewards: T<
        { id: string; name: string; description: string | null; cost_points: number; kind: string; value_cents: number | null; image_url: string | null; stock: number | null; is_active: boolean; sort: number; created_by: string | null; deleted_at: string | null; metadata: Json } & Stamps,
        { id?: string; name: string; description?: string | null; cost_points: number; kind?: string; value_cents?: number | null; image_url?: string | null; stock?: number | null; is_active?: boolean; sort?: number; created_by?: string | null; deleted_at?: string | null; metadata?: Json },
        Partial<{ name: string; description: string | null; cost_points: number; kind: string; value_cents: number | null; image_url: string | null; stock: number | null; is_active: boolean; sort: number; deleted_at: string | null; metadata: Json }>
      >;
      loyalty_accounts: T<
        { id: string; family_id: string; points_balance: number; lifetime_points: number; tier: string; joined_at: string; metadata: Json } & Stamps,
        { id?: string; family_id: string; points_balance?: number; lifetime_points?: number; tier?: string; joined_at?: string; metadata?: Json },
        Partial<{ points_balance: number; lifetime_points: number; tier: string; metadata: Json }>
      >;
      loyalty_transactions: T<
        { id: string; family_id: string; points: number; kind: string; reason: string | null; source: string | null; balance_after: number; reward_id: string | null; created_by: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; points: number; kind?: string; reason?: string | null; source?: string | null; balance_after?: number; reward_id?: string | null; created_by?: string | null; metadata?: Json },
        Partial<{ metadata: Json }>
      >;
      loyalty_redemptions: T<
        { id: string; family_id: string; reward_id: string | null; reward_name: string; cost_points: number; status: string; code: string | null; fulfilled_at: string | null; fulfilled_by: string | null; notes: string | null; created_by: string | null; metadata: Json } & Stamps,
        { id?: string; family_id: string; reward_id?: string | null; reward_name: string; cost_points: number; status?: string; code?: string | null; fulfilled_at?: string | null; fulfilled_by?: string | null; notes?: string | null; created_by?: string | null; metadata?: Json },
        Partial<{ status: string; code: string | null; fulfilled_at: string | null; fulfilled_by: string | null; notes: string | null; metadata: Json }>
      >;

      // ---- Family Missions: AI chore proof/validation + gamification (migration 0043) ----
      chore_submissions: T<
        { id: string; family_id: string; assignment_id: string; chore_id: string | null; member_id: string; kind: string; media_paths: string[]; note: string | null; status: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; assignment_id: string; chore_id?: string | null; member_id: string; kind?: string; media_paths?: string[]; note?: string | null; status?: string; created_by?: string | null },
        Partial<{ kind: string; media_paths: string[]; note: string | null; status: string }>
      >;
      chore_ai_validations: T<
        { id: string; family_id: string; submission_id: string; status: string; quality_score: number | null; confidence: number | null; recommended_reward_type: string | null; recommended_reward_amount: number | null; kid_feedback: string | null; parent_summary: string | null; detected_issues: Json; safety_flags: Json; needs_parent_review: boolean; model: string | null; is_fallback: boolean } & Stamps,
        { id?: string; family_id: string; submission_id: string; status: string; quality_score?: number | null; confidence?: number | null; recommended_reward_type?: string | null; recommended_reward_amount?: number | null; kid_feedback?: string | null; parent_summary?: string | null; detected_issues?: Json; safety_flags?: Json; needs_parent_review?: boolean; model?: string | null; is_fallback?: boolean },
        Partial<{ status: string; quality_score: number | null; confidence: number | null; needs_parent_review: boolean }>
      >;
      chore_disputes: T<
        { id: string; family_id: string; submission_id: string; member_id: string; reason: string | null; status: string; resolution: string | null; resolved_by: string | null; resolved_at: string | null } & Stamps,
        { id?: string; family_id: string; submission_id: string; member_id: string; reason?: string | null; status?: string; resolution?: string | null; resolved_by?: string | null; resolved_at?: string | null },
        Partial<{ reason: string | null; status: string; resolution: string | null; resolved_by: string | null; resolved_at: string | null }>
      >;
      chore_approval_events: T<
        { id: string; family_id: string; assignment_id: string | null; submission_id: string | null; actor_id: string | null; action: string; points_awarded: number | null; cash_cents: number | null; note: string | null; created_at: string },
        { id?: string; family_id: string; assignment_id?: string | null; submission_id?: string | null; actor_id?: string | null; action: string; points_awarded?: number | null; cash_cents?: number | null; note?: string | null },
        Partial<{ note: string | null }>
      >;
      kid_progress: T<
        { id: string; family_id: string; member_id: string; xp: number; level: number; current_streak: number; longest_streak: number; last_activity: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; xp?: number; level?: number; current_streak?: number; longest_streak?: number; last_activity?: string | null },
        Partial<{ xp: number; level: number; current_streak: number; longest_streak: number; last_activity: string | null }>
      >;
      badges: T<
        { id: string; name: string; description: string | null; icon: string | null; sort: number; created_at: string },
        { id: string; name: string; description?: string | null; icon?: string | null; sort?: number },
        Partial<{ name: string; description: string | null; icon: string | null; sort: number }>
      >;
      member_badges: T<
        { id: string; family_id: string; member_id: string; badge_id: string; awarded_at: string },
        { id?: string; family_id: string; member_id: string; badge_id: string; awarded_at?: string },
        Partial<{ awarded_at: string }>
      >;

      // ---- Family onboarding details (migration 0052) ----
      family_onboarding: T<
        { id: string; family_id: string; household_adults: number; household_children: number; child_ages: number[]; region: string | null; postal_code: string | null; country: string | null; goals: string[]; referral_source: string | null; referral_detail: string | null; completed_at: string | null; metadata: Json; created_by: string | null } & Stamps,
        { id?: string; family_id: string; household_adults?: number; household_children?: number; child_ages?: number[]; region?: string | null; postal_code?: string | null; country?: string | null; goals?: string[]; referral_source?: string | null; referral_detail?: string | null; completed_at?: string | null; metadata?: Json; created_by?: string | null },
        Partial<{ household_adults: number; household_children: number; child_ages: number[]; region: string | null; postal_code: string | null; country: string | null; goals: string[]; referral_source: string | null; referral_detail: string | null; completed_at: string | null; metadata: Json }>
      >;
      onboarding_progress: T<
        { id: string; user_id: string; family_id: string | null; status: string; source: string; steps_completed: string[]; value_engaged: boolean; import_source: string | null; events_imported: number; time_saved_minutes: number; goals: string[]; referral_source: string | null; household_adults: number | null; household_children: number | null; members_added: number; members_invited: number; has_pin: boolean; marketing_opt_in: boolean; completeness: number; completed_at: string | null; reset_at: string | null } & Stamps,
        { id?: string; user_id: string; family_id?: string | null; status?: string; source?: string; steps_completed?: string[]; value_engaged?: boolean; import_source?: string | null; events_imported?: number; time_saved_minutes?: number; goals?: string[]; referral_source?: string | null; household_adults?: number | null; household_children?: number | null; members_added?: number; members_invited?: number; has_pin?: boolean; marketing_opt_in?: boolean; completeness?: number; completed_at?: string | null; reset_at?: string | null },
        Partial<{ family_id: string | null; status: string; source: string; steps_completed: string[]; value_engaged: boolean; import_source: string | null; events_imported: number; time_saved_minutes: number; goals: string[]; referral_source: string | null; household_adults: number | null; household_children: number | null; members_added: number; members_invited: number; has_pin: boolean; marketing_opt_in: boolean; completeness: number; completed_at: string | null; reset_at: string | null }>
      >;
      concierge_calls: T<
        { id: string; family_id: string; requested_by: string | null; task_kind: string; callee_name: string; callee_phone: string | null; callee_category: string; goal: string; details: Json; brief: Json; status: string; priority: string; scheduled_for: string | null; outcome: string | null; transcript_summary: string | null; duration_seconds: number | null; attempts: number; provider_ref: string | null; completed_at: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; requested_by?: string | null; task_kind?: string; callee_name: string; callee_phone?: string | null; callee_category?: string; goal: string; details?: Json; brief?: Json; status?: string; priority?: string; scheduled_for?: string | null; outcome?: string | null; transcript_summary?: string | null; duration_seconds?: number | null; attempts?: number; provider_ref?: string | null; completed_at?: string | null; created_by?: string | null },
        Partial<{ requested_by: string | null; task_kind: string; callee_name: string; callee_phone: string | null; callee_category: string; goal: string; details: Json; brief: Json; status: string; priority: string; scheduled_for: string | null; outcome: string | null; transcript_summary: string | null; duration_seconds: number | null; attempts: number; provider_ref: string | null; completed_at: string | null }>
      >;

      // ---- Workload balancing (migration 0174) ----
      workload_snapshots: T<
        { id: string; family_id: string; member_id: string; week_start: string; chore_minutes: number; chore_count: number; task_count: number; event_count: number; invisible_count: number; load_score: number; share_pct: number; note: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; week_start: string; chore_minutes?: number; chore_count?: number; task_count?: number; event_count?: number; invisible_count?: number; load_score?: number; share_pct?: number; note?: string | null },
        Partial<{ chore_minutes: number; chore_count: number; task_count: number; event_count: number; invisible_count: number; load_score: number; share_pct: number; note: string | null }>
      >;

      // ---- Transparent lead scores (migration 0172) ----
      crm_lead_scores: T<
        { contact_id: string; score: number; band: string; factors: Json; computed_at: string },
        { contact_id: string; score?: number; band?: string; factors?: Json; computed_at?: string },
        Partial<{ score: number; band: string; factors: Json; computed_at: string }>
      >;

      // ---- Progressive-profiling store (migration 0171) ----
      crm_contact_profile: T<
        { contact_id: string; role: string | null; top_priority: string | null; household_size: number | null; child_ages: string | null; interests: string[]; extra: Json; updated_at: string },
        { contact_id: string; role?: string | null; top_priority?: string | null; household_size?: number | null; child_ages?: string | null; interests?: string[]; extra?: Json },
        Partial<{ role: string | null; top_priority: string | null; household_size: number | null; child_ages: string | null; interests: string[]; extra: Json }>
      >;

      // ---- Relationship CRM: per-contact interactions (migration 0170) ----
      contact_interactions: T<
        { id: string; family_id: string; contact_id: string; kind: string; occurred_on: string; title: string; note: string | null; amount: number | null; meta: Json; created_by: string | null } & Stamps,
        { id?: string; family_id: string; contact_id: string; kind?: string; occurred_on?: string; title: string; note?: string | null; amount?: number | null; meta?: Json; created_by?: string | null },
        Partial<{ kind: string; occurred_on: string; title: string; note: string | null; amount: number | null; meta: Json }>
      >;

      // ---- Community Marketplace circles (migration 0176) ----
      marketplace_circles: T<
        { id: string; name: string; emoji: string; join_code: string; created_by_family: string; created_by: string | null } & Stamps,
        { id?: string; name: string; emoji?: string; join_code: string; created_by_family: string; created_by?: string | null },
        Partial<{ name: string; emoji: string }>
      >;
      marketplace_circle_members: T<
        { id: string; circle_id: string; family_id: string; family_name: string; role: string } & Stamps,
        { id?: string; circle_id: string; family_id: string; family_name: string; role?: string },
        Partial<{ family_name: string; role: string }>
      >;
      marketplace_listing_shares: T<
        { id: string; listing_id: string; circle_id: string; family_id: string; created_by: string | null } & Stamps,
        { id?: string; listing_id: string; circle_id: string; family_id: string; created_by?: string | null },
        Partial<Record<string, never>>
      >;

      // ---- Paperwork Inbox (migration 0169) ----
      paperwork_items: T<
        { id: string; family_id: string; kind: string; title: string; summary: string | null; raw_text: string | null; sender: string | null; due_on: string | null; amount: number | null; urgency: string; status: string; actions: Json; meta: Json; created_by: string | null } & Stamps,
        { id?: string; family_id: string; kind?: string; title: string; summary?: string | null; raw_text?: string | null; sender?: string | null; due_on?: string | null; amount?: number | null; urgency?: string; status?: string; actions?: Json; meta?: Json; created_by?: string | null },
        Partial<{ kind: string; title: string; summary: string | null; sender: string | null; due_on: string | null; amount: number | null; urgency: string; status: string; actions: Json; meta: Json }>
      >;

      // ---- Financial Copilot: money-timeline insights (migration 0168) ----
      money_timeline_insights: T<
        { id: string; family_id: string; kind: string; title: string; detail: string; severity: string; week_start: string | null; amount: number | null; status: string; dedupe_key: string; meta: Json } & Stamps,
        { id?: string; family_id: string; kind: string; title: string; detail: string; severity?: string; week_start?: string | null; amount?: number | null; status?: string; dedupe_key: string; meta?: Json },
        Partial<{ kind: string; title: string; detail: string; severity: string; week_start: string | null; amount: number | null; status: string; dedupe_key: string; meta: Json }>
      >;

      // ---- Child independence progression (migration 0175) ----
      independence_milestones: T<
        { id: string; family_id: string; member_id: string; domain: string; title: string; description: string | null; age_band: string; status: string; points: number; evidence: string | null; achieved_at: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; domain: string; title: string; description?: string | null; age_band: string; status?: string; points?: number; evidence?: string | null; achieved_at?: string | null; created_by?: string | null },
        Partial<{ domain: string; title: string; description: string | null; age_band: string; status: string; points: number; evidence: string | null; achieved_at: string | null }>
      >;

      // ---- Vacation Planner (migration 0070) ----
      vacations: T<
        { id: string; family_id: string; title: string; kind: VacationKind; status: VacationStatus; destination: string | null; start_date: string | null; end_date: string | null; timezone: string | null; cover_image_url: string | null; description: string | null; budget_cents: number | null; currency: string; is_international: boolean; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title: string; kind?: VacationKind; status?: VacationStatus; destination?: string | null; start_date?: string | null; end_date?: string | null; timezone?: string | null; cover_image_url?: string | null; description?: string | null; budget_cents?: number | null; currency?: string; is_international?: boolean; notes?: string | null; created_by?: string | null },
        Partial<{ title: string; kind: VacationKind; status: VacationStatus; destination: string | null; start_date: string | null; end_date: string | null; timezone: string | null; cover_image_url: string | null; description: string | null; budget_cents: number | null; currency: string; is_international: boolean; notes: string | null }>
      >;
      vacation_members: T<
        { id: string; family_id: string; vacation_id: string; member_id: string | null; role: string | null; guest_name: string | null; dietary_restrictions: string | null; accessibility_needs: string | null; medical_notes: string | null; preferences: string | null; emergency_contact: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; member_id?: string | null; role?: string | null; guest_name?: string | null; dietary_restrictions?: string | null; accessibility_needs?: string | null; medical_notes?: string | null; preferences?: string | null; emergency_contact?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; role: string | null; guest_name: string | null; dietary_restrictions: string | null; accessibility_needs: string | null; medical_notes: string | null; preferences: string | null; emergency_contact: string | null }>
      >;
      vacation_destinations: T<
        { id: string; family_id: string; vacation_id: string; name: string; region: string | null; country: string | null; latitude: number | null; longitude: number | null; arrive_date: string | null; depart_date: string | null; sort_order: number; notes: string | null; map_url: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; name: string; region?: string | null; country?: string | null; latitude?: number | null; longitude?: number | null; arrive_date?: string | null; depart_date?: string | null; sort_order?: number; notes?: string | null; map_url?: string | null; created_by?: string | null },
        Partial<{ name: string; region: string | null; country: string | null; latitude: number | null; longitude: number | null; arrive_date: string | null; depart_date: string | null; sort_order: number; notes: string | null; map_url: string | null }>
      >;
      vacation_itinerary_days: T<
        { id: string; family_id: string; vacation_id: string; destination_id: string | null; day_date: string; title: string | null; summary: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; destination_id?: string | null; day_date: string; title?: string | null; summary?: string | null; created_by?: string | null },
        Partial<{ destination_id: string | null; day_date: string; title: string | null; summary: string | null }>
      >;
      vacation_itinerary_items: T<
        { id: string; family_id: string; vacation_id: string; day_id: string | null; kind: VacItemKind; day_part: VacDayPart; title: string; location: string | null; start_time: string | null; end_time: string | null; duration_min: number | null; cost_cents: number | null; booked: boolean; confirmation_code: string | null; notes: string | null; member_ids: string[]; sort_order: number; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; day_id?: string | null; kind?: VacItemKind; day_part?: VacDayPart; title: string; location?: string | null; start_time?: string | null; end_time?: string | null; duration_min?: number | null; cost_cents?: number | null; booked?: boolean; confirmation_code?: string | null; notes?: string | null; member_ids?: string[]; sort_order?: number; created_by?: string | null },
        Partial<{ day_id: string | null; kind: VacItemKind; day_part: VacDayPart; title: string; location: string | null; start_time: string | null; end_time: string | null; duration_min: number | null; cost_cents: number | null; booked: boolean; confirmation_code: string | null; notes: string | null; member_ids: string[]; sort_order: number }>
      >;
      vacation_flights: T<
        { id: string; family_id: string; vacation_id: string; airline: string | null; flight_number: string | null; depart_airport: string | null; arrive_airport: string | null; depart_at: string | null; arrive_at: string | null; terminal: string | null; gate: string | null; seats: string | null; confirmation_code: string | null; booked: boolean; cost_cents: number | null; document_id: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; airline?: string | null; flight_number?: string | null; depart_airport?: string | null; arrive_airport?: string | null; depart_at?: string | null; arrive_at?: string | null; terminal?: string | null; gate?: string | null; seats?: string | null; confirmation_code?: string | null; booked?: boolean; cost_cents?: number | null; document_id?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ airline: string | null; flight_number: string | null; depart_airport: string | null; arrive_airport: string | null; depart_at: string | null; arrive_at: string | null; terminal: string | null; gate: string | null; seats: string | null; confirmation_code: string | null; booked: boolean; cost_cents: number | null; document_id: string | null; notes: string | null }>
      >;
      vacation_transportation: T<
        { id: string; family_id: string; vacation_id: string; kind: VacTransportKind; provider: string | null; from_location: string | null; to_location: string | null; depart_at: string | null; arrive_at: string | null; confirmation_code: string | null; distance_miles: number | null; fuel_estimate_cents: number | null; stops: Json; booked: boolean; cost_cents: number | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; kind?: VacTransportKind; provider?: string | null; from_location?: string | null; to_location?: string | null; depart_at?: string | null; arrive_at?: string | null; confirmation_code?: string | null; distance_miles?: number | null; fuel_estimate_cents?: number | null; stops?: Json; booked?: boolean; cost_cents?: number | null; notes?: string | null; created_by?: string | null },
        Partial<{ kind: VacTransportKind; provider: string | null; from_location: string | null; to_location: string | null; depart_at: string | null; arrive_at: string | null; confirmation_code: string | null; distance_miles: number | null; fuel_estimate_cents: number | null; stops: Json; booked: boolean; cost_cents: number | null; notes: string | null }>
      >;
      vacation_lodging: T<
        { id: string; family_id: string; vacation_id: string; destination_id: string | null; kind: VacLodgingKind; name: string; address: string | null; phone: string | null; check_in: string | null; check_out: string | null; confirmation_code: string | null; nightly_cents: number | null; total_cents: number | null; booked: boolean; url: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; destination_id?: string | null; kind?: VacLodgingKind; name: string; address?: string | null; phone?: string | null; check_in?: string | null; check_out?: string | null; confirmation_code?: string | null; nightly_cents?: number | null; total_cents?: number | null; booked?: boolean; url?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ destination_id: string | null; kind: VacLodgingKind; name: string; address: string | null; phone: string | null; check_in: string | null; check_out: string | null; confirmation_code: string | null; nightly_cents: number | null; total_cents: number | null; booked: boolean; url: string | null; notes: string | null }>
      >;
      vacation_activities: T<
        { id: string; family_id: string; vacation_id: string; destination_id: string | null; name: string; category: string | null; location: string | null; scheduled_at: string | null; duration_min: number | null; cost_cents: number | null; family_friendly: boolean; url: string | null; booked: boolean; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; destination_id?: string | null; name: string; category?: string | null; location?: string | null; scheduled_at?: string | null; duration_min?: number | null; cost_cents?: number | null; family_friendly?: boolean; url?: string | null; booked?: boolean; notes?: string | null; created_by?: string | null },
        Partial<{ destination_id: string | null; name: string; category: string | null; location: string | null; scheduled_at: string | null; duration_min: number | null; cost_cents: number | null; family_friendly: boolean; url: string | null; booked: boolean; notes: string | null }>
      >;
      vacation_activity_tickets: T<
        { id: string; family_id: string; vacation_id: string; activity_id: string | null; holder_member_id: string | null; holder_name: string | null; ticket_type: string | null; confirmation_code: string | null; price_cents: number | null; document_id: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; activity_id?: string | null; holder_member_id?: string | null; holder_name?: string | null; ticket_type?: string | null; confirmation_code?: string | null; price_cents?: number | null; document_id?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ activity_id: string | null; holder_member_id: string | null; holder_name: string | null; ticket_type: string | null; confirmation_code: string | null; price_cents: number | null; document_id: string | null; notes: string | null }>
      >;
      vacation_confirmation_imports: T<
        { id: string; family_id: string; vacation_id: string; actor_user_id: string; actor_member_id: string; source_title: string; source_text: string; source_sha256: string; reviewed: Json; receipt: Json; reservation_id: string; itinerary_item_id: string; created_at: string },
        never,
        never
      >;
      vacation_reservations: T<
        { id: string; family_id: string; vacation_id: string; kind: string | null; name: string; location: string | null; reserved_at: string | null; party_size: number | null; confirmation_code: string | null; cost_cents: number | null; booked: boolean; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; kind?: string | null; name: string; location?: string | null; reserved_at?: string | null; party_size?: number | null; confirmation_code?: string | null; cost_cents?: number | null; booked?: boolean; notes?: string | null; created_by?: string | null },
        Partial<{ kind: string | null; name: string; location: string | null; reserved_at: string | null; party_size: number | null; confirmation_code: string | null; cost_cents: number | null; booked: boolean; notes: string | null }>
      >;
      vacation_budgets: T<
        { id: string; family_id: string; vacation_id: string; category: VacBudgetCategory; planned_cents: number; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; category: VacBudgetCategory; planned_cents?: number; notes?: string | null; created_by?: string | null },
        Partial<{ category: VacBudgetCategory; planned_cents: number; notes: string | null }>
      >;
      vacation_expenses: T<
        { id: string; family_id: string; vacation_id: string; category: VacBudgetCategory; description: string; amount_cents: number; spent_on: string; paid_by_member_id: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; category?: VacBudgetCategory; description: string; amount_cents: number; spent_on?: string; paid_by_member_id?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ category: VacBudgetCategory; description: string; amount_cents: number; spent_on: string; paid_by_member_id: string | null; notes: string | null }>
      >;
      vacation_packing_lists: T<
        { id: string; family_id: string; vacation_id: string; name: string; member_id: string | null; is_master: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; name: string; member_id?: string | null; is_master?: boolean; created_by?: string | null },
        Partial<{ name: string; member_id: string | null; is_master: boolean }>
      >;
      vacation_packing_items: T<
        { id: string; family_id: string; vacation_id: string; list_id: string | null; name: string; category: VacPackCategory; quantity: number; packed: boolean; ai_suggested: boolean; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; list_id?: string | null; name: string; category?: VacPackCategory; quantity?: number; packed?: boolean; ai_suggested?: boolean; notes?: string | null; created_by?: string | null },
        Partial<{ list_id: string | null; name: string; category: VacPackCategory; quantity: number; packed: boolean; ai_suggested: boolean; notes: string | null }>
      >;
      vacation_documents: T<
        { id: string; family_id: string; vacation_id: string; kind: VacDocKind; title: string; member_id: string | null; document_id: string | null; file_url: string | null; number: string | null; issued_on: string | null; expires_on: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; kind?: VacDocKind; title: string; member_id?: string | null; document_id?: string | null; file_url?: string | null; number?: string | null; issued_on?: string | null; expires_on?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ kind: VacDocKind; title: string; member_id: string | null; document_id: string | null; file_url: string | null; number: string | null; issued_on: string | null; expires_on: string | null; notes: string | null }>
      >;
      vacation_emergency_contacts: T<
        { id: string; family_id: string; vacation_id: string; name: string; relationship: string | null; phone: string | null; email: string | null; category: string | null; address: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; name: string; relationship?: string | null; phone?: string | null; email?: string | null; category?: string | null; address?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ name: string; relationship: string | null; phone: string | null; email: string | null; category: string | null; address: string | null; notes: string | null }>
      >;
      vacation_medical_information: T<
        { id: string; family_id: string; vacation_id: string; member_id: string | null; allergies: string | null; conditions: string | null; medications: string | null; blood_type: string | null; insurance_provider: string | null; insurance_number: string | null; physician: string | null; physician_phone: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; member_id?: string | null; allergies?: string | null; conditions?: string | null; medications?: string | null; blood_type?: string | null; insurance_provider?: string | null; insurance_number?: string | null; physician?: string | null; physician_phone?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ member_id: string | null; allergies: string | null; conditions: string | null; medications: string | null; blood_type: string | null; insurance_provider: string | null; insurance_number: string | null; physician: string | null; physician_phone: string | null; notes: string | null }>
      >;
      vacation_checklists: T<
        { id: string; family_id: string; vacation_id: string; title: string; done: boolean; due_date: string | null; assignee_member_id: string | null; sort_order: number; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; title: string; done?: boolean; due_date?: string | null; assignee_member_id?: string | null; sort_order?: number; created_by?: string | null },
        Partial<{ title: string; done: boolean; due_date: string | null; assignee_member_id: string | null; sort_order: number }>
      >;
      vacation_weather_snapshots: T<
        { id: string; family_id: string; vacation_id: string; destination_id: string | null; location_label: string | null; latitude: number | null; longitude: number | null; forecast_date: string; temp_high_c: number | null; temp_low_c: number | null; precip_prob: number | null; precip_mm: number | null; wind_kph: number | null; weather_code: number | null; summary: string | null; fetched_at: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; destination_id?: string | null; location_label?: string | null; latitude?: number | null; longitude?: number | null; forecast_date: string; temp_high_c?: number | null; temp_low_c?: number | null; precip_prob?: number | null; precip_mm?: number | null; wind_kph?: number | null; weather_code?: number | null; summary?: string | null; fetched_at?: string; created_by?: string | null },
        Partial<{ destination_id: string | null; location_label: string | null; latitude: number | null; longitude: number | null; forecast_date: string; temp_high_c: number | null; temp_low_c: number | null; precip_prob: number | null; precip_mm: number | null; wind_kph: number | null; weather_code: number | null; summary: string | null; fetched_at: string }>
      >;
      vacation_ai_recommendations: T<
        { id: string; family_id: string; vacation_id: string; kind: VacRecoKind; status: VacRecoStatus; title: string; detail: string | null; severity: number; payload: Json; source: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id: string; kind?: VacRecoKind; status?: VacRecoStatus; title: string; detail?: string | null; severity?: number; payload?: Json; source?: string; created_by?: string | null },
        Partial<{ kind: VacRecoKind; status: VacRecoStatus; title: string; detail: string | null; severity: number; payload: Json; source: string }>
      >;
      vacation_ai_conversations: T<
        { id: string; family_id: string; vacation_id: string | null; title: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id?: string | null; title?: string | null; created_by?: string | null },
        Partial<{ vacation_id: string | null; title: string | null }>
      >;
      vacation_ai_messages: T<
        { id: string; family_id: string; conversation_id: string; role: AiRole; content: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; conversation_id: string; role: AiRole; content: string; created_by?: string | null },
        Partial<{ content: string }>
      >;
      vacation_travel_scores: T<
        { id: string; family_id: string; vacation_id: string; score: number; breakdown: Json; computed_at: string } & Stamps,
        { id?: string; family_id: string; vacation_id: string; score: number; breakdown?: Json; computed_at?: string },
        Partial<{ score: number; breakdown: Json; computed_at: string }>
      >;
      vacation_activity_logs: T<
        { id: string; family_id: string; vacation_id: string | null; actor_member_id: string | null; action: string; detail: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id?: string | null; actor_member_id?: string | null; action: string; detail?: string | null; created_by?: string | null },
        Partial<{ vacation_id: string | null; actor_member_id: string | null; action: string; detail: string | null }>
      >;
      vacation_notifications: T<
        { id: string; family_id: string; vacation_id: string | null; member_id: string | null; title: string; body: string | null; read: boolean; send_at: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id?: string | null; member_id?: string | null; title: string; body?: string | null; read?: boolean; send_at?: string | null; created_by?: string | null },
        Partial<{ vacation_id: string | null; member_id: string | null; title: string; body: string | null; read: boolean; send_at: string | null }>
      >;
      vacation_audit_logs: T<
        { id: string; family_id: string; vacation_id: string | null; table_name: string; record_id: string | null; action: string; changes: Json; actor_user_id: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id?: string | null; table_name: string; record_id?: string | null; action: string; changes?: Json; actor_user_id?: string | null; created_by?: string | null },
        Partial<{ vacation_id: string | null; table_name: string; record_id: string | null; action: string; changes: Json; actor_user_id: string | null }>
      >;

      // ---- Weekend Planner (migration 0071) ----
      weekend_events: T<
        { id: string; family_id: string; source: string; external_id: string | null; title: string; category: string | null; description: string | null; venue_name: string | null; address: string | null; city: string | null; region: string | null; postal_code: string | null; latitude: number | null; longitude: number | null; starts_at: string | null; ends_at: string | null; url: string | null; image_url: string | null; price_min_cents: number | null; price_max_cents: number | null; currency: string; distance_miles: number | null; is_family_friendly: boolean; search_zip: string | null; search_radius: number | null; raw: Json; discovered_at: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; source?: string; external_id?: string | null; title: string; category?: string | null; description?: string | null; venue_name?: string | null; address?: string | null; city?: string | null; region?: string | null; postal_code?: string | null; latitude?: number | null; longitude?: number | null; starts_at?: string | null; ends_at?: string | null; url?: string | null; image_url?: string | null; price_min_cents?: number | null; price_max_cents?: number | null; currency?: string; distance_miles?: number | null; is_family_friendly?: boolean; search_zip?: string | null; search_radius?: number | null; raw?: Json; discovered_at?: string; created_by?: string | null },
        Partial<{ title: string; category: string | null; description: string | null; venue_name: string | null; address: string | null; city: string | null; region: string | null; postal_code: string | null; latitude: number | null; longitude: number | null; starts_at: string | null; ends_at: string | null; url: string | null; image_url: string | null; price_min_cents: number | null; price_max_cents: number | null; distance_miles: number | null; is_family_friendly: boolean; raw: Json }>
      >;
      weekend_plans: T<
        { id: string; family_id: string; event_id: string; status: WeekendPlanStatus; member_ids: string[]; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; event_id: string; status?: WeekendPlanStatus; member_ids?: string[]; notes?: string | null; created_by?: string | null },
        Partial<{ status: WeekendPlanStatus; member_ids: string[]; notes: string | null }>
      >;
      weekend_searches: T<
        { id: string; family_id: string; zip: string; radius_miles: number; days: number; result_count: number; last_run_at: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; zip: string; radius_miles?: number; days?: number; result_count?: number; last_run_at?: string; created_by?: string | null },
        Partial<{ zip: string; radius_miles: number; days: number; result_count: number; last_run_at: string }>
      >;
      weekend_feeds: T<
        { id: string; family_id: string; label: string; url: string; kind: WeekendFeedKind; is_active: boolean; last_fetched_at: string | null; last_status: string | null; last_count: number; created_by: string | null } & Stamps,
        { id?: string; family_id: string; label: string; url: string; kind?: WeekendFeedKind; is_active?: boolean; last_fetched_at?: string | null; last_status?: string | null; last_count?: number; created_by?: string | null },
        Partial<{ label: string; url: string; kind: WeekendFeedKind; is_active: boolean; last_fetched_at: string | null; last_status: string | null; last_count: number }>
      >;
      wardrobe_items: T<
        { id: string; family_id: string; member_id: string; name: string; category: WardrobeCategory; color: string | null; size: string | null; brand: string | null; warmth: number; formality: number; seasons: string[]; status: WardrobeStatus; photo_path: string | null; purchased_on: string | null; price_cents: number | null; wear_count: number; last_worn_on: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; name: string; category?: WardrobeCategory; color?: string | null; size?: string | null; brand?: string | null; warmth?: number; formality?: number; seasons?: string[]; status?: WardrobeStatus; photo_path?: string | null; purchased_on?: string | null; price_cents?: number | null; wear_count?: number; last_worn_on?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ member_id: string; name: string; category: WardrobeCategory; color: string | null; size: string | null; brand: string | null; warmth: number; formality: number; seasons: string[]; status: WardrobeStatus; photo_path: string | null; purchased_on: string | null; price_cents: number | null; wear_count: number; last_worn_on: string | null; notes: string | null }>
      >;
      outfits: T<
        { id: string; family_id: string; member_id: string; name: string; occasion: OutfitOccasion; item_ids: string[]; temp_min_c: number | null; temp_max_c: number | null; rating: number | null; is_favorite: boolean; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; name: string; occasion?: OutfitOccasion; item_ids?: string[]; temp_min_c?: number | null; temp_max_c?: number | null; rating?: number | null; is_favorite?: boolean; notes?: string | null; created_by?: string | null },
        Partial<{ member_id: string; name: string; occasion: OutfitOccasion; item_ids: string[]; temp_min_c: number | null; temp_max_c: number | null; rating: number | null; is_favorite: boolean; notes: string | null }>
      >;
      outfit_logs: T<
        { id: string; family_id: string; member_id: string; outfit_id: string | null; worn_on: string; item_ids: string[]; occasion: string | null; temp_c: number | null; weather: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; outfit_id?: string | null; worn_on?: string; item_ids?: string[]; occasion?: string | null; temp_c?: number | null; weather?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ member_id: string; outfit_id: string | null; worn_on: string; item_ids: string[]; occasion: string | null; temp_c: number | null; weather: string | null; notes: string | null }>
      >;
      watchlist_titles: T<
        { id: string; family_id: string; title: string; kind: WatchKind; year: number | null; genres: string[]; age_rating: string | null; min_age: number; runtime_min: number | null; service: WatchService; status: WatchStatus; priority: number; added_by: string | null; external_url: string | null; poster_path: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title: string; kind?: WatchKind; year?: number | null; genres?: string[]; age_rating?: string | null; min_age?: number; runtime_min?: number | null; service?: WatchService; status?: WatchStatus; priority?: number; added_by?: string | null; external_url?: string | null; poster_path?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ title: string; kind: WatchKind; year: number | null; genres: string[]; age_rating: string | null; min_age: number; runtime_min: number | null; service: WatchService; status: WatchStatus; priority: number; added_by: string | null; external_url: string | null; poster_path: string | null; notes: string | null }>
      >;
      watchlist_votes: T<
        { id: string; family_id: string; title_id: string; member_id: string; vote: WatchVote; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title_id: string; member_id: string; vote?: WatchVote; created_by?: string | null },
        Partial<{ vote: WatchVote }>
      >;
      watch_sessions: T<
        { id: string; family_id: string; title_id: string | null; title_name: string; watched_on: string; member_ids: string[]; rating: number | null; minutes: number | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title_id?: string | null; title_name: string; watched_on?: string; member_ids?: string[]; rating?: number | null; minutes?: number | null; notes?: string | null; created_by?: string | null },
        Partial<{ title_id: string | null; title_name: string; watched_on: string; member_ids: string[]; rating: number | null; minutes: number | null; notes: string | null }>
      >;
      home_locations: T<
        { id: string; family_id: string; name: string; kind: HomeLocationKind; parent_id: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; kind?: HomeLocationKind; parent_id?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ name: string; kind: HomeLocationKind; parent_id: string | null; notes: string | null }>
      >;
      inventory_items: T<
        { id: string; family_id: string; name: string; category: InventoryCategory; location_id: string | null; owner_member_id: string | null; quantity: number; value_cents: number | null; purchased_on: string | null; brand: string | null; model: string | null; serial_number: string | null; warranty_until: string | null; photo_path: string | null; tags: string[]; status: InventoryStatus; lent_to: string | null; lent_on: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; category?: InventoryCategory; location_id?: string | null; owner_member_id?: string | null; quantity?: number; value_cents?: number | null; purchased_on?: string | null; brand?: string | null; model?: string | null; serial_number?: string | null; warranty_until?: string | null; photo_path?: string | null; tags?: string[]; status?: InventoryStatus; lent_to?: string | null; lent_on?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ name: string; category: InventoryCategory; location_id: string | null; owner_member_id: string | null; quantity: number; value_cents: number | null; purchased_on: string | null; brand: string | null; model: string | null; serial_number: string | null; warranty_until: string | null; photo_path: string | null; tags: string[]; status: InventoryStatus; lent_to: string | null; lent_on: string | null; notes: string | null }>
      >;
      inventory_moves: T<
        { id: string; family_id: string; item_id: string; from_location_id: string | null; to_location_id: string | null; moved_by: string | null; moved_at: string; reason: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; item_id: string; from_location_id?: string | null; to_location_id?: string | null; moved_by?: string | null; moved_at?: string; reason?: string | null; created_by?: string | null },
        Partial<{ from_location_id: string | null; to_location_id: string | null; moved_by: string | null; moved_at: string; reason: string | null }>
      >;
      sleep_logs: T<
        { id: string; family_id: string; member_id: string; sleep_date: string; bedtime: string; wake_time: string; duration_min: number; quality: number | null; awakenings: number; source: SleepSource; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; sleep_date: string; bedtime: string; wake_time: string; duration_min: number; quality?: number | null; awakenings?: number; source?: SleepSource; notes?: string | null; created_by?: string | null },
        Partial<{ member_id: string; sleep_date: string; bedtime: string; wake_time: string; duration_min: number; quality: number | null; awakenings: number; source: SleepSource; notes: string | null }>
      >;
      bedtime_routines: T<
        { id: string; family_id: string; member_id: string; name: string; target_bedtime: string; target_wake: string; wind_down_min: number; steps: string[]; days_of_week: number[]; is_active: boolean; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; name?: string; target_bedtime?: string; target_wake?: string; wind_down_min?: number; steps?: string[]; days_of_week?: number[]; is_active?: boolean; notes?: string | null; created_by?: string | null },
        Partial<{ member_id: string; name: string; target_bedtime: string; target_wake: string; wind_down_min: number; steps: string[]; days_of_week: number[]; is_active: boolean; notes: string | null }>
      >;
      sleep_checkins: T<
        { id: string; family_id: string; member_id: string; checkin_date: string; energy: number; mood: number; caffeine_after_2pm: boolean; screens_in_bed: boolean; exercised: boolean; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; checkin_date?: string; energy?: number; mood?: number; caffeine_after_2pm?: boolean; screens_in_bed?: boolean; exercised?: boolean; notes?: string | null; created_by?: string | null },
        Partial<{ member_id: string; checkin_date: string; energy: number; mood: number; caffeine_after_2pm: boolean; screens_in_bed: boolean; exercised: boolean; notes: string | null }>
      >;
      declutter_zones: T<
        { id: string; family_id: string; name: string; room: string | null; kind: DeclutterZoneKind; clutter_score: number; last_reset_at: string | null; photo_path: string | null; target_state: string | null; is_active: boolean; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; room?: string | null; kind?: DeclutterZoneKind; clutter_score?: number; last_reset_at?: string | null; photo_path?: string | null; target_state?: string | null; is_active?: boolean; notes?: string | null; created_by?: string | null },
        Partial<{ name: string; room: string | null; kind: DeclutterZoneKind; clutter_score: number; last_reset_at: string | null; photo_path: string | null; target_state: string | null; is_active: boolean; notes: string | null }>
      >;
      declutter_missions: T<
        { id: string; family_id: string; zone_id: string | null; title: string; minutes: number; assignee_id: string | null; status: DeclutterMissionStatus; scheduled_for: string | null; completed_at: string | null; items_removed: number; before_photo_path: string | null; after_photo_path: string | null; points: number; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; zone_id?: string | null; title: string; minutes?: number; assignee_id?: string | null; status?: DeclutterMissionStatus; scheduled_for?: string | null; completed_at?: string | null; items_removed?: number; before_photo_path?: string | null; after_photo_path?: string | null; points?: number; notes?: string | null; created_by?: string | null },
        Partial<{ zone_id: string | null; title: string; minutes: number; assignee_id: string | null; status: DeclutterMissionStatus; scheduled_for: string | null; completed_at: string | null; items_removed: number; before_photo_path: string | null; after_photo_path: string | null; points: number; notes: string | null }>
      >;
      declutter_sessions: T<
        { id: string; family_id: string; zone_id: string | null; member_id: string | null; started_at: string; minutes: number; missions_done: number; items_removed: number; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; zone_id?: string | null; member_id?: string | null; started_at?: string; minutes?: number; missions_done?: number; items_removed?: number; notes?: string | null; created_by?: string | null },
        Partial<{ zone_id: string | null; member_id: string | null; started_at: string; minutes: number; missions_done: number; items_removed: number; notes: string | null }>
      >;
      moves: T<
        { id: string; family_id: string; title: string; from_address: string | null; to_address: string | null; move_date: string; status: MoveStatus; move_kind: MoveKind; budget_cents: number | null; spent_cents: number; mover_name: string | null; mover_phone: string | null; mover_quote_cents: number | null; has_kids: boolean; has_pets: boolean; is_renting_out: boolean; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title: string; from_address?: string | null; to_address?: string | null; move_date: string; status?: MoveStatus; move_kind?: MoveKind; budget_cents?: number | null; spent_cents?: number; mover_name?: string | null; mover_phone?: string | null; mover_quote_cents?: number | null; has_kids?: boolean; has_pets?: boolean; is_renting_out?: boolean; notes?: string | null; created_by?: string | null },
        Partial<{ title: string; from_address: string | null; to_address: string | null; move_date: string; status: MoveStatus; move_kind: MoveKind; budget_cents: number | null; spent_cents: number; mover_name: string | null; mover_phone: string | null; mover_quote_cents: number | null; has_kids: boolean; has_pets: boolean; is_renting_out: boolean; notes: string | null }>
      >;
      move_tasks: T<
        { id: string; family_id: string; move_id: string; title: string; category: MoveTaskCategory; offset_days: number; due_date: string | null; assignee_id: string | null; status: MoveTaskStatus; date_mode: 'fixed' | 'relative'; completed_at: string | null; template_key: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; move_id: string; title: string; category?: MoveTaskCategory; offset_days?: number; due_date?: string | null; assignee_id?: string | null; status?: MoveTaskStatus; date_mode?: 'fixed' | 'relative'; completed_at?: string | null; template_key?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ title: string; category: MoveTaskCategory; offset_days: number; due_date: string | null; assignee_id: string | null; status: MoveTaskStatus; date_mode: 'fixed' | 'relative'; completed_at: string | null; template_key: string | null; notes: string | null }>
      >;
      move_date_recalculations: T<
        { request_id: string; family_id: string; move_id: string; actor_user_id: string; actor_member_id: string; from_date: string; to_date: string; reviewed: Json; result: Json; created_at: string },
        { request_id: string; family_id: string; move_id: string; actor_user_id: string; actor_member_id: string; from_date: string; to_date: string; reviewed: Json; result: Json; created_at?: string },
        Record<string, never>
      >;
      move_boxes: T<
        { id: string; family_id: string; move_id: string; box_number: number; label: string; from_room: string | null; to_room: string | null; contents: string[]; is_fragile: boolean; is_essential: boolean; status: MoveBoxStatus; packed_by: string | null; photo_path: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; move_id: string; box_number: number; label: string; from_room?: string | null; to_room?: string | null; contents?: string[]; is_fragile?: boolean; is_essential?: boolean; status?: MoveBoxStatus; packed_by?: string | null; photo_path?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ box_number: number; label: string; from_room: string | null; to_room: string | null; contents: string[]; is_fragile: boolean; is_essential: boolean; status: MoveBoxStatus; packed_by: string | null; photo_path: string | null; notes: string | null }>
      >;
      home_projects: T<
        { id: string; family_id: string; title: string; description: string | null; room: string | null; kind: HomeProjectKind; status: HomeProjectStatus; priority: HomeProjectPriority; is_diy: boolean; budget_cents: number | null; labor_cents: number; target_start: string | null; target_end: string | null; completed_at: string | null; owner_id: string | null; contractor_id: string | null; photo_path: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title: string; description?: string | null; room?: string | null; kind?: HomeProjectKind; status?: HomeProjectStatus; priority?: HomeProjectPriority; is_diy?: boolean; budget_cents?: number | null; labor_cents?: number; target_start?: string | null; target_end?: string | null; completed_at?: string | null; owner_id?: string | null; contractor_id?: string | null; photo_path?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ title: string; description: string | null; room: string | null; kind: HomeProjectKind; status: HomeProjectStatus; priority: HomeProjectPriority; is_diy: boolean; budget_cents: number | null; labor_cents: number; target_start: string | null; target_end: string | null; completed_at: string | null; owner_id: string | null; contractor_id: string | null; photo_path: string | null; notes: string | null }>
      >;
      project_materials: T<
        { id: string; family_id: string; project_id: string; name: string; quantity: number; unit: string | null; est_cost_cents: number | null; actual_cost_cents: number | null; is_purchased: boolean; store: string | null; url: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; project_id: string; name: string; quantity?: number; unit?: string | null; est_cost_cents?: number | null; actual_cost_cents?: number | null; is_purchased?: boolean; store?: string | null; url?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ name: string; quantity: number; unit: string | null; est_cost_cents: number | null; actual_cost_cents: number | null; is_purchased: boolean; store: string | null; url: string | null; notes: string | null }>
      >;
      project_quotes: T<
        { id: string; family_id: string; project_id: string; contractor_id: string | null; contractor_name: string; amount_cents: number; includes_materials: boolean; lead_time_days: number | null; valid_until: string | null; status: ProjectQuoteStatus; received_on: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; project_id: string; contractor_id?: string | null; contractor_name: string; amount_cents: number; includes_materials?: boolean; lead_time_days?: number | null; valid_until?: string | null; status?: ProjectQuoteStatus; received_on?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ contractor_id: string | null; contractor_name: string; amount_cents: number; includes_materials: boolean; lead_time_days: number | null; valid_until: string | null; status: ProjectQuoteStatus; received_on: string | null; notes: string | null }>
      >;
      career_profiles: T<
        { id: string; family_id: string; member_id: string; title: string; is_active: boolean; headline: string | null; summary: string | null; skills: string[]; target_roles: string[]; target_keywords: string[]; work_mode: CareerWorkMode; employment_type: CareerEmploymentType; salary_target_cents: number | null; location: string | null; status: CareerStatus; weekly_goal: number; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; title?: string; is_active?: boolean; headline?: string | null; summary?: string | null; skills?: string[]; target_roles?: string[]; target_keywords?: string[]; work_mode?: CareerWorkMode; employment_type?: CareerEmploymentType; salary_target_cents?: number | null; location?: string | null; status?: CareerStatus; weekly_goal?: number; notes?: string | null; created_by?: string | null },
        Partial<{ title: string; is_active: boolean; headline: string | null; summary: string | null; skills: string[]; target_roles: string[]; target_keywords: string[]; work_mode: CareerWorkMode; employment_type: CareerEmploymentType; salary_target_cents: number | null; location: string | null; status: CareerStatus; weekly_goal: number; notes: string | null }>
      >;
      job_applications: T<
        { id: string; family_id: string; profile_id: string; company: string; role_title: string; stage: JobStage; source: string | null; url: string | null; location: string | null; work_mode: 'remote' | 'hybrid' | 'onsite' | null; salary_min_cents: number | null; salary_max_cents: number | null; applied_on: string | null; last_activity_on: string | null; next_step: string | null; next_step_on: string | null; contact_name: string | null; contact_email: string | null; resume_id: string | null; excitement: number | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; profile_id: string; company: string; role_title: string; stage?: JobStage; source?: string | null; url?: string | null; location?: string | null; work_mode?: 'remote' | 'hybrid' | 'onsite' | null; salary_min_cents?: number | null; salary_max_cents?: number | null; applied_on?: string | null; last_activity_on?: string | null; next_step?: string | null; next_step_on?: string | null; contact_name?: string | null; contact_email?: string | null; resume_id?: string | null; excitement?: number | null; notes?: string | null; created_by?: string | null },
        Partial<{ company: string; role_title: string; stage: JobStage; source: string | null; url: string | null; location: string | null; work_mode: 'remote' | 'hybrid' | 'onsite' | null; salary_min_cents: number | null; salary_max_cents: number | null; applied_on: string | null; last_activity_on: string | null; next_step: string | null; next_step_on: string | null; contact_name: string | null; contact_email: string | null; resume_id: string | null; excitement: number | null; notes: string | null }>
      >;
      resume_versions: T<
        { id: string; family_id: string; profile_id: string; title: string; target_role: string | null; body: string; keywords: string[]; ats_score: number | null; matched_keywords: string[]; missing_keywords: string[]; is_primary: boolean; file_path: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; profile_id: string; title: string; target_role?: string | null; body?: string; keywords?: string[]; ats_score?: number | null; matched_keywords?: string[]; missing_keywords?: string[]; is_primary?: boolean; file_path?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ title: string; target_role: string | null; body: string; keywords: string[]; ats_score: number | null; matched_keywords: string[]; missing_keywords: string[]; is_primary: boolean; file_path: string | null; notes: string | null }>
      >;
      language_goals: T<
        { id: string; family_id: string; member_id: string; language_code: string; language_label: string; current_level: CefrLevel; target_level: Exclude<CefrLevel, 'A0'>; weekly_minutes: number; reason: string | null; started_on: string; is_active: boolean; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; language_code: string; language_label: string; current_level?: CefrLevel; target_level?: Exclude<CefrLevel, 'A0'>; weekly_minutes?: number; reason?: string | null; started_on?: string; is_active?: boolean; notes?: string | null; created_by?: string | null },
        Partial<{ member_id: string; language_code: string; language_label: string; current_level: CefrLevel; target_level: Exclude<CefrLevel, 'A0'>; weekly_minutes: number; reason: string | null; started_on: string; is_active: boolean; notes: string | null }>
      >;
      language_sessions: T<
        { id: string; family_id: string; goal_id: string; member_id: string | null; kind: LanguageSessionKind; minutes: number; score: number | null; topic: string | null; corrections: string[]; practiced_on: string; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; goal_id: string; member_id?: string | null; kind?: LanguageSessionKind; minutes?: number; score?: number | null; topic?: string | null; corrections?: string[]; practiced_on?: string; notes?: string | null; created_by?: string | null },
        Partial<{ kind: LanguageSessionKind; minutes: number; score: number | null; topic: string | null; corrections: string[]; practiced_on: string; notes: string | null }>
      >;
      vocab_cards: T<
        { id: string; family_id: string; goal_id: string; term: string; translation: string; example: string | null; part_of_speech: string | null; tags: string[]; ease: number; interval_days: number; repetitions: number; lapses: number; due_on: string; last_reviewed_on: string | null; is_suspended: boolean; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; goal_id: string; term: string; translation: string; example?: string | null; part_of_speech?: string | null; tags?: string[]; ease?: number; interval_days?: number; repetitions?: number; lapses?: number; due_on?: string; last_reviewed_on?: string | null; is_suspended?: boolean; notes?: string | null; created_by?: string | null },
        Partial<{ term: string; translation: string; example: string | null; part_of_speech: string | null; tags: string[]; ease: number; interval_days: number; repetitions: number; lapses: number; due_on: string; last_reviewed_on: string | null; is_suspended: boolean; notes: string | null }>
      >;
    };
    Views: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
    Functions: {
      finance_record_transaction_operation: {
        Args: { p_tool_call_id: string; p_family_id: string; p_actor_user_id: string | null; p_actor_member_id: string | null; p_actor_kind: AiActorKind; p_expected_inputs: Json; p_intent: Json; p_transaction: Json };
        Returns: Json;
      };
      vacation_import_confirmation: {
        Args: { p_family_id: string; p_vacation_id: string; p_member_id: string; p_source: Json; p_fields: Json; p_expected?: Json | null; p_request_id?: string | null };
        Returns: Json;
      };
      move_recalculate_date: {
        Args: { p_family_id: string; p_move_id: string; p_member_id: string; p_new_date: string; p_expected?: Json | null; p_request_id?: string | null };
        Returns: Json;
      };
      ensure_family_for_user: {
        Args: { p_user_id: string; p_name: string; p_timezone?: string; p_display_name?: string | null };
        Returns: string;
      };
      onboarding_claim_family: {
        Args: { p_user_id: string; p_name: string; p_timezone: string };
        Returns: { family_id: string; created: boolean }[];
      };
      accept_invite: { Args: { p_token: string }; Returns: string };
      bump_landing_metric: { Args: { p_slug: string; p_metric: string }; Returns: undefined };
      grocery_from_meal_plan: { Args: { p_family_id: string; p_from: string; p_to: string; p_list_id?: string }; Returns: string };
      is_family_member: { Args: { p_family_id: string }; Returns: boolean };
      // Executor lease (0250): returns the ids it just leased. service_role only.
      claim_ai_runs: { Args: { p_limit?: number; p_lease_seconds?: number }; Returns: string[] };
      can_manage_family: { Args: { p_family_id: string }; Returns: boolean };
      is_family_admin: { Args: { p_family_id: string }; Returns: boolean };
      is_super_admin: { Args: Record<string, never>; Returns: boolean };
      public_stats: { Args: Record<string, never>; Returns: { families: number; members: number; tasks_completed: number }[] };
      social_role_for: { Args: { p_family_id: string }; Returns: SocialRoleEnum };
      social_has_permission: { Args: { p_family_id: string; p_permission: string }; Returns: boolean };
      bump_exit_intent: { Args: { p_id: string; p_metric: string }; Returns: undefined };
      marketplace_member_id: { Args: { p_family_id: string }; Returns: string | null };
      marketplace_accept_offer: { Args: { p_offer: string }; Returns: string };
      marketplace_decline_offer: { Args: { p_offer: string }; Returns: undefined };
      marketplace_set_listing_status: { Args: { p_listing: string; p_status: string }; Returns: undefined };
      wallet_reserve_card_auth: { Args: { p_family: string; p_child_wallet: string; p_amount: number; p_auth_id: string; p_description: string }; Returns: boolean };
      rate_limit_hit: { Args: { p_key: string; p_limit: number; p_window_seconds: number }; Returns: { allowed: boolean; retry_after: number }[] };
      rate_limit_prune: { Args: Record<string, never>; Returns: undefined };
      mark_conversation_read: { Args: { p_conversation_id: string }; Returns: undefined };
      marketplace_create_circle: { Args: { p_family: string; p_name: string; p_emoji?: string }; Returns: string };
      marketplace_join_circle: { Args: { p_family: string; p_code: string }; Returns: string };
      marketplace_leave_circle: { Args: { p_family: string; p_circle: string }; Returns: undefined };
      marketplace_place_bid: { Args: { p_listing_id: string; p_bidder_member_id: string; p_bidder_family_id: string; p_max_cents: number }; Returns: Json };
      marketplace_buy_now: { Args: { p_listing_id: string; p_buyer_member_id: string; p_buyer_family_id: string }; Returns: Json };
      marketplace_close_auction: { Args: { p_listing_id: string; p_now?: string }; Returns: Json };
      marketplace_negotiation_offer: { Args: { p_listing: string; p_buyer_member: string; p_buyer_family: string; p_amount: number; p_message?: string | null }; Returns: Json };
      marketplace_negotiation_respond: { Args: { p_negotiation: string; p_action: string; p_amount?: number | null; p_message?: string | null }; Returns: Json };
      economy_decide_redemption: { Args: { p_redemption_id: string; p_approve: boolean; p_note?: string | null }; Returns: Json };
      invest_decide_order: { Args: { p_order_id: string; p_approve: boolean }; Returns: Json };
      guardian_review_suggestion: { Args: { p_suggestion_id: string; p_decision: string; p_note?: string | null }; Returns: Json };
      marketplace_complete_handoff: { Args: { p_order_id: string; p_code: string }; Returns: Json };
      loyalty_award_points: { Args: { p_family_id: string; p_points: number; p_kind?: string; p_reason?: string | null; p_source?: string | null; p_reward_id?: string | null; p_actor_id?: string | null }; Returns: Json };
      loyalty_redeem_reward: { Args: { p_family_id: string; p_reward_id: string; p_actor_id?: string | null }; Returns: Json };
      loyalty_cancel_redemption: { Args: { p_redemption_id: string; p_actor_id?: string | null }; Returns: Json };
      wallet_transfer: { Args: { p_family_id: string; p_from_child_wallet_id: string; p_to_child_wallet_id: string; p_amount: number; p_note?: string | null; p_actor_id?: string | null }; Returns: Json };
      wallet_approve_gift: { Args: { p_family_id: string; p_gift_payment_id: string; p_actor_id: string }; Returns: Json };
      wallet_decide_spend: { Args: { p_family_id: string; p_approval_id: string; p_decision: string; p_note?: string | null; p_actor_id?: string | null }; Returns: Json };
      wallet_decide_allowance: { Args: { p_family_id: string; p_approval_id: string; p_decision: string; p_note?: string | null; p_actor_id?: string | null }; Returns: Json };
      wallet_fund_goal: { Args: { p_family_id: string; p_goal_id: string; p_amount: number; p_actor_id: string }; Returns: Json };
      claim_marketing_generation_jobs: {
        Args: { p_limit?: number };
        Returns: Tables<'marketing_generation_jobs'>[];
      };
    };
    Enums: {
      member_role: MemberRole;
      invite_status: InviteStatus;
      task_status: TaskStatus;
      priority: Priority;
      event_category: EventCategory;
      recurrence_freq: RecurrenceFreq;
      meal_type: MealType;
      notification_type: NotificationType;
      subscription_status: SubscriptionStatus;
      account_type: AccountType;
      transaction_type: TransactionType;
      budget_period: BudgetPeriod;
      bill_status: BillStatus;
      metric_type: MetricType;
      game_result: GameResult;
      grade_type: GradeType;
      theme_pref: ThemePref;
      ai_role: AiRole;
      record_kind: RecordKind;
      sync_provider: SyncProviderEnum;
      sync_direction: SyncDirection;
      sync_status: SyncStatusEnum;
      sync_item_type: SyncItemType;
      sync_conflict_status: SyncConflictStatus;
      sync_conflict_resolution: SyncConflictResolutionEnum;
      sync_job_status: SyncJobStatus;
      social_platform: SocialPlatformEnum;
      social_account_status: SocialAccountStatus;
      social_post_kind: SocialPostKind;
      social_post_status: SocialPostStatusEnum;
      social_target_status: SocialTargetStatus;
      social_job_status: SocialJobStatus;
      social_approval_status: SocialApprovalStatus;
      social_inbox_status: SocialInboxStatus;
      social_asset_kind: SocialAssetKind;
      social_role: SocialRoleEnum;
    };
  };
}

/** Convenience row-type aliases used throughout the app. */
export type Tables<K extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][K]['Row'];
export type Insertable<K extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][K]['Insert'];
export type Updatable<K extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][K]['Update'];
