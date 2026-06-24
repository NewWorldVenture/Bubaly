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
export type InsurancePolicyType = 'health' | 'dental' | 'vision' | 'auto' | 'home' | 'renters' | 'life' | 'disability' | 'umbrella' | 'pet' | 'travel' | 'other';
export type PremiumFrequency = 'monthly' | 'quarterly' | 'semiannual' | 'annual';
export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type PantryLocation = 'pantry' | 'fridge' | 'freezer' | 'counter' | 'garage' | 'other';
export type NutritionSubject = 'recipe' | 'meal' | 'week';
export type NotificationType =
  | 'chore_due' | 'medication_due' | 'calendar_event' | 'school_event' | 'sports_event'
  | 'maintenance_task' | 'grocery_reminder' | 'document_expiry' | 'family_invite' | 'system';
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
export type RecordKind = 'medical' | 'dental';
export type RideStatus = 'planned' | 'confirmed' | 'completed' | 'cancelled';
export type HomeworkStatus = 'assigned' | 'in_progress' | 'done' | 'submitted';
export type RenewalStatus = 'active' | 'renewed' | 'expired' | 'cancelled';
export type CareLogType = 'check_in' | 'visit' | 'call' | 'meal' | 'medication' | 'appointment' | 'incident' | 'note';
export type OpportunityStatus = 'interested' | 'registered' | 'waitlisted' | 'passed' | 'missed';
export type LocationEventType = 'arrived' | 'left' | 'ping';
export type WishPriority = 'low' | 'medium' | 'high';
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
      profiles: T<
        { id: string; email: string | null; full_name: string | null; display_name: string | null; avatar_url: string | null; date_of_birth: string | null; phone: string | null } & Stamps,
        { id: string; email?: string | null; full_name?: string | null; display_name?: string | null; avatar_url?: string | null; date_of_birth?: string | null; phone?: string | null },
        Partial<{ email: string | null; full_name: string | null; display_name: string | null; avatar_url: string | null; date_of_birth: string | null; phone: string | null }>
      >;
      families: T<
        { id: string; name: string; avatar_url: string | null; timezone: string; created_by: string | null } & Stamps,
        { id?: string; name: string; avatar_url?: string | null; timezone?: string; created_by?: string | null },
        Partial<{ name: string; avatar_url: string | null; timezone: string }>
      >;
      family_members: T<
        { id: string; family_id: string; user_id: string | null; role: MemberRole; display_name: string; color: string | null; birthday: string | null; is_active: boolean } & Stamps,
        { id?: string; family_id: string; user_id?: string | null; role?: MemberRole; display_name: string; color?: string | null; birthday?: string | null; is_active?: boolean },
        Partial<{ role: MemberRole; display_name: string; color: string | null; birthday: string | null; is_active: boolean }>
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
        { id: string; family_id: string; email: string; role: MemberRole; token: string; status: InviteStatus; invited_by: string | null; expires_at: string; accepted_by: string | null } & Stamps,
        { id?: string; family_id: string; email: string; role?: MemberRole; token?: string; status?: InviteStatus; invited_by?: string | null; expires_at?: string },
        Partial<{ status: InviteStatus; role: MemberRole; accepted_by: string | null }>
      >;
      calendar_events: T<
        { id: string; family_id: string; title: string; description: string | null; location: string | null; category: EventCategory; starts_at: string; ends_at: string | null; all_day: boolean; recurrence: RecurrenceFreq; recurrence_until: string | null; assignee_id: string | null; feed_id: string | null; external_uid: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title: string; description?: string | null; location?: string | null; category?: EventCategory; starts_at: string; ends_at?: string | null; all_day?: boolean; recurrence?: RecurrenceFreq; recurrence_until?: string | null; assignee_id?: string | null; feed_id?: string | null; external_uid?: string | null; created_by?: string | null },
        Partial<{ title: string; description: string | null; location: string | null; category: EventCategory; starts_at: string; ends_at: string | null; all_day: boolean; recurrence: RecurrenceFreq; recurrence_until: string | null; assignee_id: string | null; feed_id: string | null; external_uid: string | null }>
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
        { id: string; family_id: string; chore_id: string; member_id: string; status: TaskStatus; due_at: string | null; submitted_at: string | null; approved_at: string | null; approved_by: string | null; points_awarded: number | null; ai_score: number | null; cash_awarded_cents: number | null; disputed: boolean } & Stamps,
        { id?: string; family_id: string; chore_id: string; member_id: string; status?: TaskStatus; due_at?: string | null },
        Partial<{ status: TaskStatus; due_at: string | null; submitted_at: string | null; approved_at: string | null; approved_by: string | null; points_awarded: number | null; ai_score: number | null; cash_awarded_cents: number | null; disputed: boolean }>
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
        { id: string; family_id: string; name: string; meal_type: MealType; recipe_url: string | null; ingredients: Json; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; meal_type?: MealType; recipe_url?: string | null; ingredients?: Json; notes?: string | null; created_by?: string | null },
        Partial<{ name: string; meal_type: MealType; recipe_url: string | null; ingredients: Json; notes: string | null }>
      >;
      meal_plans: T<
        { id: string; family_id: string; meal_id: string | null; plan_date: string; meal_type: MealType; created_by: string | null } & Stamps,
        { id?: string; family_id: string; meal_id?: string | null; plan_date: string; meal_type?: MealType; created_by?: string | null },
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
      grocery_lists: T<
        { id: string; family_id: string; name: string; is_archived: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name?: string; is_archived?: boolean; created_by?: string | null },
        Partial<{ name: string; is_archived: boolean }>
      >;
      grocery_items: T<
        { id: string; family_id: string; list_id: string; name: string; quantity: string | null; category: string | null; is_checked: boolean; source_meal_id: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; list_id: string; name: string; quantity?: string | null; category?: string | null; is_checked?: boolean; source_meal_id?: string | null; created_by?: string | null },
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
        { id: string; family_id: string; name: string; icon: string | null; address: string | null; latitude: number; longitude: number; radius_m: number; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; icon?: string | null; address?: string | null; latitude: number; longitude: number; radius_m?: number; created_by?: string | null },
        Partial<{ name: string; icon: string | null; address: string | null; latitude: number; longitude: number; radius_m: number }>
      >;
      member_locations: T<
        { id: string; family_id: string; member_id: string; latitude: number | null; longitude: number | null; accuracy_m: number | null; battery: number | null; place_id: string | null; is_sharing: boolean } & Stamps,
        { id?: string; family_id: string; member_id: string; latitude?: number | null; longitude?: number | null; accuracy_m?: number | null; battery?: number | null; place_id?: string | null; is_sharing?: boolean },
        Partial<{ latitude: number | null; longitude: number | null; accuracy_m: number | null; battery: number | null; place_id: string | null; is_sharing: boolean }>
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
        { id: string; family_id: string; title: string; category: string | null; storage_path: string; mime_type: string | null; size_bytes: number | null; expires_at: string | null; member_id: string | null; asset_id: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title: string; category?: string | null; storage_path: string; mime_type?: string | null; size_bytes?: number | null; expires_at?: string | null; member_id?: string | null; asset_id?: string | null; created_by?: string | null },
        Partial<{ title: string; category: string | null; expires_at: string | null; member_id: string | null; asset_id: string | null }>
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
        { id: string; family_id: string; vacation_id: string | null; question: string; description: string | null; kind: string; status: string; closes_at: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; vacation_id?: string | null; question: string; description?: string | null; kind?: string; status?: string; closes_at?: string | null; created_by?: string | null },
        Partial<{ vacation_id: string | null; question: string; description: string | null; kind: string; status: string; closes_at: string | null }>
      >;
      family_poll_options: T<
        { id: string; family_id: string; poll_id: string; label: string; sort: number; created_at: string },
        { id?: string; family_id: string; poll_id: string; label: string; sort?: number },
        Partial<{ label: string; sort: number }>
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
        Partial<{ member_id: string | null; kind: string; title: string; detail: string | null; confidence: number; urgency: number; status: 'open' | 'approved' | 'executed' | 'auto_executed' | 'dismissed' | 'snoozed'; action_type: string | null; action_label: string | null; payload: Json; source_kind: string | null; source_id: string | null; expires_at: string | null; resolved_at: string | null; resolved_by: string | null }>
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
        { id: string; family_id: string; user_id: string | null; title: string; provider: string; model: string | null } & Stamps,
        { id?: string; family_id: string; user_id?: string | null; title?: string; provider?: string; model?: string | null },
        Partial<{ title: string; model: string | null }>
      >;
      ai_messages: T<
        { id: string; family_id: string; conversation_id: string; role: AiRole; content: string; tool_calls: Json | null; tool_results: Json | null; created_at: string },
        { id?: string; family_id: string; conversation_id: string; role: AiRole; content?: string; tool_calls?: Json | null; tool_results?: Json | null },
        Partial<{ content: string; tool_calls: Json | null; tool_results: Json | null }>
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
        { id: string; family_id: string; account_id: string | null; name: string; amount: number; category: string | null; date: string; type: TransactionType; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; account_id?: string | null; name: string; amount: number; category?: string | null; date?: string; type?: TransactionType; notes?: string | null; created_by?: string | null },
        Partial<{ account_id: string | null; name: string; amount: number; category: string | null; date: string; type: TransactionType; notes: string | null }>
      >;
      budgets: T<
        { id: string; family_id: string; category: string; amount: number; period: BudgetPeriod; created_by: string | null } & Stamps,
        { id?: string; family_id: string; category: string; amount: number; period?: BudgetPeriod; created_by?: string | null },
        Partial<{ category: string; amount: number; period: BudgetPeriod }>
      >;
      bills: T<
        { id: string; family_id: string; name: string; amount: number; due_date: string; is_recurring: boolean; recurrence: string | null; status: BillStatus; category: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; amount: number; due_date: string; is_recurring?: boolean; recurrence?: string | null; status?: BillStatus; category?: string | null; created_by?: string | null },
        Partial<{ name: string; amount: number; due_date: string; is_recurring: boolean; recurrence: string | null; status: BillStatus; category: string | null }>
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
        { id: string; slug: string; title: string; excerpt: string; author: string; published_at: string; reading_minutes: number; tags: string[]; category: string; featured: boolean; accent_color: string | null; body: Json; published: boolean } & Stamps,
        { id?: string; slug: string; title: string; excerpt?: string; author?: string; published_at?: string; reading_minutes?: number; tags?: string[]; category: string; featured?: boolean; accent_color?: string | null; body?: Json; published?: boolean },
        Partial<{ slug: string; title: string; excerpt: string; author: string; published_at: string; reading_minutes: number; tags: string[]; category: string; featured: boolean; accent_color: string | null; body: Json; published: boolean }>
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
        { id: string; family_id: string; name: string | null; kind: string; avatar_emoji: string | null; member_ids: string[]; participant_ids: string[]; created_by: string | null; last_message_at: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; name?: string | null; kind?: string; avatar_emoji?: string | null; member_ids?: string[]; participant_ids?: string[]; created_by?: string | null },
        Partial<{ name: string | null; avatar_emoji: string | null; member_ids: string[]; participant_ids: string[]; last_message_at: string | null }>
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
        { id?: string; family_id: string; name: string; relationship?: string | null; category?: string; phone?: string | null; phone_alt?: string | null; email?: string | null; address?: string | null; notes?: string | null; photo_url?: string | null; is_emergency?: boolean; birthday_month?: number | null; birthday_day?: number | null; specialty?: string | null; organization?: string | null; created_by?: string | null },
        Partial<{ name: string; relationship: string | null; category: string; phone: string | null; phone_alt: string | null; email: string | null; address: string | null; notes: string | null; is_emergency: boolean; birthday_month: number | null; birthday_day: number | null; specialty: string | null; organization: string | null; updated_at: string }>
      >;
      family_reminders: T<
        { id: string; family_id: string; created_by: string | null; assigned_to_id: string | null; member_id: string | null; title: string; notes: string | null; kind: string; remind_at: string | null; location_name: string | null; recurrence: string; recurrence_time: string | null; recurrence_days: number[] | null; priority: string; status: string; completed_at: string | null; snoozed_until: string | null; ai_suggested: boolean; tags: string[]; created_at: string; updated_at: string },
        { id?: string; family_id: string; created_by?: string | null; assigned_to_id?: string | null; member_id?: string | null; title: string; notes?: string | null; kind?: string; remind_at?: string | null; location_name?: string | null; recurrence?: string; priority?: string; status?: string; ai_suggested?: boolean },
        Partial<{ title: string; notes: string | null; kind: string; remind_at: string | null; location_name: string | null; recurrence: string; priority: string; status: string; completed_at: string | null; snoozed_until: string | null; assigned_to_id: string | null; member_id: string | null; updated_at: string }>
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
        { id: string; family_id: string; list_id: string; created_by: string | null; assigned_to_id: string | null; title: string; notes: string | null; is_done: boolean; priority: string; due_date: string | null; tags: string[]; sort_order: number; completed_at: string | null; created_at: string; updated_at: string },
        { id?: string; family_id: string; list_id: string; created_by?: string | null; assigned_to_id?: string | null; title: string; notes?: string | null; is_done?: boolean; priority?: string; due_date?: string | null; tags?: string[]; sort_order?: number },
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
        { id: string; name: string; kind: string; storage_path: string; mime_type: string | null; size_bytes: number | null; width: number | null; height: number | null; alt_text: string | null; tags: string[]; metadata: Json; created_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; name: string; kind?: string; storage_path: string; mime_type?: string | null; size_bytes?: number | null; width?: number | null; height?: number | null; alt_text?: string | null; tags?: string[]; metadata?: Json; created_by?: string | null; deleted_at?: string | null },
        Partial<{ name: string; kind: string; storage_path: string; mime_type: string | null; size_bytes: number | null; width: number | null; height: number | null; alt_text: string | null; tags: string[]; metadata: Json; deleted_at: string | null }>
      >;
      marketing_videos: T<
        { id: string; title: string; provider: string; video_id: string | null; url: string | null; storage_path: string | null; poster_url: string | null; captions_url: string | null; transcript: string | null; duration_seconds: number | null; status: string; tags: string[]; metadata: Json; created_by: string | null; deleted_at: string | null } & Stamps,
        { id?: string; title: string; provider?: string; video_id?: string | null; url?: string | null; storage_path?: string | null; poster_url?: string | null; captions_url?: string | null; transcript?: string | null; duration_seconds?: number | null; status?: string; tags?: string[]; metadata?: Json; created_by?: string | null; deleted_at?: string | null },
        Partial<{ title: string; provider: string; video_id: string | null; url: string | null; storage_path: string | null; poster_url: string | null; captions_url: string | null; transcript: string | null; duration_seconds: number | null; status: string; tags: string[]; metadata: Json; deleted_at: string | null }>
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
        { id: string; family_id: string; tiles: Json; updated_by: string | null } & Stamps,
        { id?: string; family_id: string; tiles?: Json; updated_by?: string | null },
        Partial<{ tiles: Json; updated_by: string | null }>
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
      family_automation_rules: T<
        { id: string; family_id: string; name: string; trigger_type: string; trigger_config: Json; action_type: string; action_config: Json; is_enabled: boolean; requires_approval: boolean; last_run_at: string | null; status: string; metadata: Json; created_by: string | null; updated_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; trigger_type: string; trigger_config?: Json; action_type: string; action_config?: Json; is_enabled?: boolean; requires_approval?: boolean; last_run_at?: string | null; status?: string; metadata?: Json; created_by?: string | null; updated_by?: string | null },
        Partial<{ name: string; trigger_type: string; trigger_config: Json; action_type: string; action_config: Json; is_enabled: boolean; requires_approval: boolean; last_run_at: string | null; status: string; metadata: Json; updated_by: string | null }>
      >;
      family_automation_runs: T<
        { id: string; family_id: string; rule_id: string | null; trigger_type: string | null; status: string; summary: string | null; result: Json; approved_by: string | null; approved_at: string | null; metadata: Json; created_by: string | null } & Stamps,
        { id?: string; family_id: string; rule_id?: string | null; trigger_type?: string | null; status?: string; summary?: string | null; result?: Json; approved_by?: string | null; approved_at?: string | null; metadata?: Json; created_by?: string | null },
        Partial<{ status: string; summary: string | null; result: Json; approved_by: string | null; approved_at: string | null; metadata: Json }>
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
    };
    Views: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
    Functions: {
      accept_invite: { Args: { p_token: string }; Returns: string };
      bump_landing_metric: { Args: { p_slug: string; p_metric: string }; Returns: undefined };
      grocery_from_meal_plan: { Args: { p_family_id: string; p_from: string; p_to: string; p_list_id?: string }; Returns: string };
      is_family_member: { Args: { p_family_id: string }; Returns: boolean };
      can_manage_family: { Args: { p_family_id: string }; Returns: boolean };
      is_family_admin: { Args: { p_family_id: string }; Returns: boolean };
      is_super_admin: { Args: Record<string, never>; Returns: boolean };
      public_stats: { Args: Record<string, never>; Returns: { families: number; members: number; tasks_completed: number }[] };
      social_role_for: { Args: { p_family_id: string }; Returns: SocialRoleEnum };
      social_has_permission: { Args: { p_family_id: string; p_permission: string }; Returns: boolean };
      bump_exit_intent: { Args: { p_id: string; p_metric: string }; Returns: undefined };
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
