// lib/database.types.ts
// Curated subset covering tables used by the current code. Regenerate the COMPLETE,
// always-accurate set with:
//   npx supabase gen types typescript --local > lib/database.types.ts
// (or --project-id <ref> against the hosted project)

type Timestamps = { created_at: string; updated_at: string };

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: { id: string; email: string | null; full_name: string | null; display_name: string | null; avatar_url: string | null } & Timestamps;
        Insert: { id: string; email?: string | null; full_name?: string | null };
        Update: Partial<{ full_name: string | null; display_name: string | null; avatar_url: string | null }>;
      };
      families: {
        Row: { id: string; name: string; timezone: string; created_by: string | null } & Timestamps;
        Insert: { name: string; timezone?: string; created_by?: string | null };
        Update: Partial<{ name: string; timezone: string }>;
      };
      family_members: {
        Row: { id: string; family_id: string; user_id: string | null; role: string; display_name: string; color: string | null; is_active: boolean } & Timestamps;
        Insert: { family_id: string; user_id?: string | null; role?: string; display_name: string };
        Update: Partial<{ role: string; display_name: string; is_active: boolean }>;
      };
      calendar_events: {
        Row: { id: string; family_id: string; title: string; category: string; starts_at: string; ends_at: string | null; all_day: boolean; created_by: string | null } & Timestamps;
        Insert: { family_id: string; title: string; starts_at: string; ends_at?: string | null; category?: string; created_by?: string | null };
        Update: Partial<{ title: string; starts_at: string; ends_at: string | null; category: string }>;
      };
      chores: {
        Row: { id: string; family_id: string; title: string; points: number; due_at: string | null; created_by: string | null } & Timestamps;
        Insert: { family_id: string; title: string; points?: number; due_at?: string | null; created_by?: string | null };
        Update: Partial<{ title: string; points: number; due_at: string | null }>;
      };
      reminders: {
        Row: { id: string; family_id: string; title: string; remind_at: string; recurrence: string; is_done: boolean; created_by: string | null } & Timestamps;
        Insert: { family_id: string; title: string; remind_at: string; recurrence?: string; created_by?: string | null };
        Update: Partial<{ title: string; remind_at: string; is_done: boolean }>;
      };
      grocery_lists: {
        Row: { id: string; family_id: string; name: string; is_archived: boolean } & Timestamps;
        Insert: { family_id: string; name?: string };
        Update: Partial<{ name: string; is_archived: boolean }>;
      };
      grocery_items: {
        Row: { id: string; family_id: string; list_id: string; name: string; quantity: string | null; is_checked: boolean; created_by: string | null } & Timestamps;
        Insert: { family_id: string; list_id: string; name: string; quantity?: string | null; created_by?: string | null };
        Update: Partial<{ name: string; quantity: string | null; is_checked: boolean }>;
      };
      meals: {
        Row: { id: string; family_id: string; name: string; meal_type: string; ingredients: unknown; created_by: string | null } & Timestamps;
        Insert: { family_id: string; name: string; meal_type?: string; created_by?: string | null };
        Update: Partial<{ name: string; meal_type: string }>;
      };
      meal_plans: {
        Row: { id: string; family_id: string; meal_id: string | null; plan_date: string; meal_type: string; created_by: string | null } & Timestamps;
        Insert: { family_id: string; meal_id?: string | null; plan_date: string; meal_type?: string; created_by?: string | null };
        Update: Partial<{ plan_date: string; meal_type: string }>;
      };
    };
    Functions: {
      accept_invite: { Args: { p_token: string }; Returns: string };
      grocery_from_meal_plan: { Args: { p_family_id: string; p_from: string; p_to: string; p_list_id?: string }; Returns: string };
    };
  };
};
