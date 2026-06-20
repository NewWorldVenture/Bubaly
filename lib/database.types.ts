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
export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
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
export type AiRole = 'user' | 'assistant' | 'system' | 'tool';
export type RecordKind = 'medical' | 'dental';

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
        { id: string; family_id: string; title: string; description: string | null; location: string | null; category: EventCategory; starts_at: string; ends_at: string | null; all_day: boolean; recurrence: RecurrenceFreq; recurrence_until: string | null; assignee_id: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title: string; description?: string | null; location?: string | null; category?: EventCategory; starts_at: string; ends_at?: string | null; all_day?: boolean; recurrence?: RecurrenceFreq; recurrence_until?: string | null; assignee_id?: string | null; created_by?: string | null },
        Partial<{ title: string; description: string | null; location: string | null; category: EventCategory; starts_at: string; ends_at: string | null; all_day: boolean; recurrence: RecurrenceFreq; recurrence_until: string | null; assignee_id: string | null }>
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
        { id: string; family_id: string; title: string; description: string | null; points: number; priority: Priority; recurrence: RecurrenceFreq; due_at: string | null; requires_approval: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title: string; description?: string | null; points?: number; priority?: Priority; recurrence?: RecurrenceFreq; due_at?: string | null; requires_approval?: boolean; created_by?: string | null },
        Partial<{ title: string; description: string | null; points: number; priority: Priority; recurrence: RecurrenceFreq; due_at: string | null; requires_approval: boolean }>
      >;
      chore_assignments: T<
        { id: string; family_id: string; chore_id: string; member_id: string; status: TaskStatus; due_at: string | null; submitted_at: string | null; approved_at: string | null; approved_by: string | null; points_awarded: number | null } & Stamps,
        { id?: string; family_id: string; chore_id: string; member_id: string; status?: TaskStatus; due_at?: string | null },
        Partial<{ status: TaskStatus; due_at: string | null; submitted_at: string | null; approved_at: string | null; approved_by: string | null; points_awarded: number | null }>
      >;
      rewards: T<
        { id: string; family_id: string; title: string; description: string | null; cost_points: number; redeemed_by: string | null; redeemed_at: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title: string; description?: string | null; cost_points?: number; created_by?: string | null },
        Partial<{ title: string; description: string | null; cost_points: number; redeemed_by: string | null; redeemed_at: string | null }>
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
      medications: T<
        { id: string; family_id: string; member_id: string | null; name: string; dosage: string | null; instructions: string | null; is_active: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id?: string | null; name: string; dosage?: string | null; instructions?: string | null; is_active?: boolean; created_by?: string | null },
        Partial<{ member_id: string | null; name: string; dosage: string | null; instructions: string | null; is_active: boolean }>
      >;
      medication_schedules: T<
        { id: string; family_id: string; medication_id: string; time_of_day: string; days_of_week: number[]; starts_on: string; ends_on: string | null; last_taken_at: string | null } & Stamps,
        { id?: string; family_id: string; medication_id: string; time_of_day: string; days_of_week?: number[]; starts_on?: string; ends_on?: string | null },
        Partial<{ time_of_day: string; days_of_week: number[]; starts_on: string; ends_on: string | null; last_taken_at: string | null }>
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
        { id: string; family_id: string; name: string; category: string | null; location: string | null; brand: string | null; model: string | null; purchased_on: string | null; warranty_until: string | null; notes: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; name: string; category?: string | null; location?: string | null; brand?: string | null; model?: string | null; purchased_on?: string | null; warranty_until?: string | null; notes?: string | null; created_by?: string | null },
        Partial<{ name: string; category: string | null; location: string | null; brand: string | null; model: string | null; purchased_on: string | null; warranty_until: string | null; notes: string | null }>
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
      goals: T<
        { id: string; family_id: string; title: string; description: string | null; target_date: string | null; progress: number; is_complete: boolean; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title: string; description?: string | null; target_date?: string | null; progress?: number; is_complete?: boolean; created_by?: string | null },
        Partial<{ title: string; description: string | null; target_date: string | null; progress: number; is_complete: boolean }>
      >;
      reminders: T<
        { id: string; family_id: string; title: string; notes: string | null; remind_at: string; recurrence: RecurrenceFreq; is_done: boolean; member_id: string | null; related_type: string | null; related_id: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; title: string; notes?: string | null; remind_at: string; recurrence?: RecurrenceFreq; is_done?: boolean; member_id?: string | null; related_type?: string | null; related_id?: string | null; created_by?: string | null },
        Partial<{ title: string; notes: string | null; remind_at: string; recurrence: RecurrenceFreq; is_done: boolean }>
      >;
      notifications: T<
        { id: string; family_id: string; user_id: string | null; type: NotificationType; title: string; body: string | null; related_type: string | null; related_id: string | null; is_read: boolean; send_at: string; sent_at: string | null; created_at: string },
        { id?: string; family_id: string; user_id?: string | null; type: NotificationType; title: string; body?: string | null; related_type?: string | null; related_id?: string | null; is_read?: boolean; send_at?: string; sent_at?: string | null },
        Partial<{ is_read: boolean; sent_at: string | null }>
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
      subscriptions: T<
        { id: string; family_id: string; billing_customer_id: string | null; plan: string; status: SubscriptionStatus; provider_ref: string | null; current_period_end: string | null; seats: number } & Stamps,
        { id?: string; family_id: string; billing_customer_id?: string | null; plan?: string; status?: SubscriptionStatus; provider_ref?: string | null; current_period_end?: string | null; seats?: number },
        Partial<{ plan: string; status: SubscriptionStatus; provider_ref: string | null; current_period_end: string | null; seats: number }>
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
      workout_logs: T<
        { id: string; family_id: string; member_id: string; activity: string; duration_minutes: number | null; calories: number | null; distance: number | null; notes: string | null; recorded_at: string; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; activity: string; duration_minutes?: number | null; calories?: number | null; distance?: number | null; notes?: string | null; recorded_at?: string; created_by?: string | null },
        Partial<{ activity: string; duration_minutes: number | null; calories: number | null; distance: number | null; notes: string | null; recorded_at: string }>
      >;
      // ── School ──────────────────────────────────────────────
      school_classes: T<
        { id: string; family_id: string; member_id: string; subject: string; teacher: string | null; room: string | null; time_slot: string | null; day_of_week: number | null; school_name: string | null; created_by: string | null } & Stamps,
        { id?: string; family_id: string; member_id: string; subject: string; teacher?: string | null; room?: string | null; time_slot?: string | null; day_of_week?: number | null; school_name?: string | null; created_by?: string | null },
        Partial<{ subject: string; teacher: string | null; room: string | null; time_slot: string | null; day_of_week: number | null; school_name: string | null }>
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
        { user_id: string; theme: ThemePref; push_enabled: boolean; email_enabled: boolean; expo_push_token: string | null; active_family_id: string | null; notification_prefs: Json } & Stamps,
        { user_id: string; theme?: ThemePref; push_enabled?: boolean; email_enabled?: boolean; expo_push_token?: string | null; active_family_id?: string | null; notification_prefs?: Json },
        Partial<{ theme: ThemePref; push_enabled: boolean; email_enabled: boolean; expo_push_token: string | null; active_family_id: string | null; notification_prefs: Json }>
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
      support_tickets: T<
        { id: string; name: string; email: string; subject: string; message: string; status: string; source: string } & Stamps,
        { id?: string; name?: string; email: string; subject?: string; message?: string; status?: string; source?: string },
        Partial<{ name: string; email: string; subject: string; message: string; status: string; source: string }>
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
    };
    Views: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
    Functions: {
      accept_invite: { Args: { p_token: string }; Returns: string };
      grocery_from_meal_plan: { Args: { p_family_id: string; p_from: string; p_to: string; p_list_id?: string }; Returns: string };
      is_family_member: { Args: { p_family_id: string }; Returns: boolean };
      can_manage_family: { Args: { p_family_id: string }; Returns: boolean };
      is_family_admin: { Args: { p_family_id: string }; Returns: boolean };
      is_super_admin: { Args: Record<string, never>; Returns: boolean };
      public_stats: { Args: Record<string, never>; Returns: { families: number; members: number; tasks_completed: number }[] };
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
