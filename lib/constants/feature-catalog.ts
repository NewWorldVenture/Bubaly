// lib/constants/feature-catalog.ts — the master catalog of services/features the
// admin can gate per tier. The `defaultTier` values mirror the published
// tier-comparison grid (Free / Basic / Plus) and are the GLOBAL default offering.
// The admin's Tier & Features page stores overrides; everything (nav gating +
// pricing page) resolves against catalog defaults + those overrides.

export type FeatureTier = 'off' | 'free' | 'basic' | 'plus';

export type FeatureSection = 'Suggested' | 'Daily Life' | 'Family & Home' | 'Finances & Admin';

export interface FeatureDef {
  key: string;          // stable id (also used as the override key)
  label: string;        // display name
  section: FeatureSection;
  defaultTier: FeatureTier;
  href?: string;        // optional route this gates (for nav/page mapping)
}

const F = (key: string, label: string, section: FeatureSection, defaultTier: FeatureTier, href?: string): FeatureDef =>
  ({ key, label, section, defaultTier, href });

export const FEATURE_CATALOG: FeatureDef[] = [
  // ── Suggested ──────────────────────────────────────────────
  F('parent-dashboard', 'Parent Dashboard', 'Suggested', 'free', '/dashboard'),
  F('family-dashboard', 'Family Dashboard', 'Suggested', 'free', '/dashboard'),
  F('calendar', 'Calendar', 'Suggested', 'free', '/dashboard/calendar'),
  F('tasks-chores', 'Tasks & Chores', 'Suggested', 'free', '/dashboard/chores'),
  F('meals', 'Meals', 'Suggested', 'free', '/dashboard/meals'),
  F('messages', 'Messages', 'Suggested', 'free', '/dashboard/messages'),
  F('ai-assistant', 'AI Assistant', 'Suggested', 'basic', '/dashboard/assistant'),
  F('daily-briefing', 'Daily Briefing', 'Suggested', 'plus', '/dashboard/briefing'),
  F('weekly-briefing', 'Weekly Briefing', 'Suggested', 'plus', '/dashboard/weekly-briefing'),
  F('command-center', 'Command Center', 'Suggested', 'plus', '/dashboard/command-center'),
  F('family-missions', 'Family Missions', 'Suggested', 'plus', '/missions'),
  F('rewards', 'Rewards', 'Suggested', 'plus', '/dashboard/rewards'),
  F('behavior-tracking', 'Behavior Tracking', 'Suggested', 'basic', '/dashboard/behavior'),
  F('screen-time', 'Screen Time', 'Suggested', 'basic', '/dashboard/screen-time'),
  F('conflict-resolution', 'AI Conflict Resolution', 'Suggested', 'plus', '/dashboard/conflicts'),

  // ── Daily Life ─────────────────────────────────────────────
  F('groceries', 'Groceries', 'Daily Life', 'free', '/dashboard/grocery'),
  F('weather', 'Weather', 'Daily Life', 'free', '/dashboard/weather'),
  F('reminders', 'Reminders', 'Daily Life', 'free', '/dashboard/reminders'),
  F('photos', 'Photos', 'Daily Life', 'free', '/dashboard/photos'),
  F('todo-lists', 'To-Do Lists', 'Daily Life', 'free', '/dashboard/todos'),
  F('wish-lists', 'Wish Lists', 'Daily Life', 'free', '/dashboard/wishlists'),
  F('notes', 'Notes', 'Daily Life', 'free', '/dashboard/notes'),
  F('contacts', 'Contacts', 'Daily Life', 'free', '/dashboard/contacts'),
  F('announcements', 'Announcements', 'Daily Life', 'basic', '/dashboard/announcements'),
  F('memories', 'Memories', 'Daily Life', 'basic', '/dashboard/memories'),
  F('activity-feed', 'Activity Feed', 'Daily Life', 'basic', '/dashboard/activity'),
  F('social-circle', 'Social Circle', 'Daily Life', 'basic', '/dashboard/social'),
  F('family-tree', 'Family Tree', 'Daily Life', 'basic', '/dashboard/family-tree'),
  F('grandparent-portal', 'Grandparent Portal', 'Daily Life', 'free', '/dashboard/grandparent-portal'),
  F('pets', 'Pets', 'Daily Life', 'basic', '/dashboard/pets'),
  F('celebrations', 'Celebrations', 'Daily Life', 'basic', '/dashboard/celebrations'),
  F('recipes', 'Recipes', 'Daily Life', 'basic', '/dashboard/recipes'),
  F('readiness', 'Readiness', 'Daily Life', 'basic', '/dashboard/readiness'),
  F('documents', 'Documents', 'Daily Life', 'basic', '/dashboard/documents'),
  F('family-map', 'Family Map', 'Daily Life', 'basic', '/dashboard/locator'),
  F('notifications', 'Notifications', 'Daily Life', 'basic', '/dashboard/notifications'),

  // ── Family & Home ──────────────────────────────────────────
  F('school', 'School', 'Family & Home', 'free', '/dashboard/school'),
  F('timetables', 'Time Tables', 'Family & Home', 'free', '/dashboard/timetable'),
  F('homework', 'Homework', 'Family & Home', 'free', '/dashboard/homework'),
  F('signatures', 'Signatures', 'Family & Home', 'free', '/dashboard/signups'),
  F('home-inventory', 'Home Inventory', 'Family & Home', 'free', '/dashboard/home'),
  F('utility-tracking', 'Utility Tracking', 'Family & Home', 'basic', '/dashboard/utilities'),
  F('household-binder', 'Household Binder', 'Family & Home', 'basic', '/dashboard/binder'),
  F('security-alerts', 'Security Alerts', 'Family & Home', 'basic', '/dashboard/security'),
  F('smart-home', 'Smart Home', 'Family & Home', 'basic', '/dashboard/devices'),
  F('auto-care', 'Auto Care', 'Family & Home', 'basic', '/dashboard/auto'),
  F('health', 'Health', 'Family & Home', 'basic', '/dashboard/health'),
  F('renewals', 'Renewals', 'Family & Home', 'basic', '/dashboard/renewals'),
  F('scan-center', 'Scan Center', 'Family & Home', 'basic', '/dashboard/scan'),
  F('trips', 'Trips', 'Family & Home', 'basic', '/dashboard/trips'),
  F('group-voting', 'Group Voting', 'Family & Home', 'basic', '/dashboard/voting'),
  F('trip-memories', 'Trip Memories', 'Family & Home', 'basic', '/dashboard/trip-memories'),
  F('medications', 'Medications', 'Family & Home', 'basic', '/dashboard/medications'),
  F('rides', 'Rides', 'Family & Home', 'basic', '/dashboard/rides'),
  F('care-plans', 'Care Plans', 'Family & Home', 'basic', '/dashboard/care'),
  F('medical-records', 'Medical Records', 'Family & Home', 'basic', '/dashboard/medical'),
  F('dental', 'Dental', 'Family & Home', 'basic', '/dashboard/dental'),
  F('family-goals', 'Family Goals', 'Family & Home', 'basic', '/dashboard/goals'),
  F('kitchen', 'Kitchen', 'Family & Home', 'basic', '/display'),
  F('magazines', 'Magazines', 'Family & Home', 'basic', '/dashboard/inbox'),
  F('sports', 'Sports', 'Family & Home', 'plus', '/dashboard/sports'),
  F('ai-companion', 'AI Companion', 'Family & Home', 'plus', '/dashboard/family-ai-assistant'),
  F('auto', 'Auto', 'Family & Home', 'plus', '/dashboard/auto'),
  F('ai-advisor', 'AI Advisor', 'Family & Home', 'plus', '/dashboard/family-operations'),
  F('digital-health', 'Digital Health', 'Family & Home', 'plus', '/dashboard/family-digital-twin'),
  F('emergency-hub', 'Emergency Hub', 'Family & Home', 'plus', '/dashboard/family-emergency'),
  F('family-health', 'Family Health', 'Family & Home', 'plus', '/dashboard/family-health'),
  F('stress-tracker', 'Stress Tracker', 'Family & Home', 'plus', '/dashboard/family-stress'),
  F('school-os', 'School OS', 'Family & Home', 'plus', '/dashboard/family-school'),
  F('lifestyle-coaching', 'Lifestyle Coaching', 'Family & Home', 'plus', '/dashboard/family-automation'),
  F('volunteer-hub', 'Volunteer Hub', 'Family & Home', 'basic', '/dashboard/volunteer'),
  F('college-planner', 'College Planner', 'Family & Home', 'basic', '/dashboard/college'),
  F('scholarship-tracker', 'Scholarship Tracker', 'Family & Home', 'basic', '/dashboard/college'),
  F('family-reunions', 'Family Reunions', 'Family & Home', 'basic', '/dashboard/reunions'),
  F('family-yearbook', 'Family Yearbook', 'Daily Life', 'basic', '/dashboard/yearbook'),
  F('relocation-guide', 'Relocation Guide', 'Family & Home', 'basic', '/dashboard/relocation'),

  // ── Finances & Admin ───────────────────────────────────────
  F('finances', 'Finances', 'Finances & Admin', 'free', '/dashboard/billing'),
  F('expense-splitting', 'Expense Splitting', 'Finances & Admin', 'basic', '/dashboard/expenses'),
  F('subscription-tracking', 'Subscription Tracking', 'Finances & Admin', 'basic', '/dashboard/subscriptions'),
  F('insurance-hub', 'Insurance Hub', 'Finances & Admin', 'basic', '/dashboard/insurance'),
  F('tax-vault', 'Tax Document Vault', 'Finances & Admin', 'basic', '/dashboard/tax-vault'),
  F('estate-vault', 'Estate & Legacy Vault', 'Finances & Admin', 'basic', '/dashboard/estate'),
  F('donation-tracker', 'Donation Tracker', 'Finances & Admin', 'basic', '/dashboard/donations'),
  F('calendar-sync', 'Calendar Sync', 'Finances & Admin', 'free', '/dashboard/sync'),
  F('family-accounts', 'Family Accounts', 'Finances & Admin', 'basic', '/dashboard/settings#members'),
  F('switch-to-family', 'Switch to Family', 'Finances & Admin', 'basic', '/dashboard/migrate'),
  F('refer-a-friend', 'Refer a Friend', 'Finances & Admin', 'basic', '/referrals'),
  F('ai-calendar', 'AI Calendar', 'Finances & Admin', 'plus', '/dashboard/family-coo'),
  F('family-tax-center', 'Family Tax Center', 'Finances & Admin', 'plus', '/dashboard/family-cfo'),
  F('auto-bill-pay', 'Auto Bill Pay', 'Finances & Admin', 'plus', '/dashboard/family-cfo'),
];

export const FEATURE_SECTIONS: FeatureSection[] = ['Suggested', 'Daily Life', 'Family & Home', 'Finances & Admin'];

export const FEATURE_CATALOG_BY_KEY: Record<string, FeatureDef> =
  Object.fromEntries(FEATURE_CATALOG.map((f) => [f.key, f]));
