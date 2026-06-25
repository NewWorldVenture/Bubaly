// lib/dashboard/registry.ts — the dashboard quick-action feature registry.
// Server-safe + pure (icons are string keys; the client maps them to components).
// `required_tier` mirrors the published tier grid. The two FIXED features
// (quick_add "+" and ai_assistant) are always rendered and never customizable.

export type DashTier = 'free' | 'basic' | 'plus';

export type DashFeature = {
  key: string;
  label: string;
  description: string;
  route: string;
  icon: string;            // icon key → resolved client-side
  category: string;
  requiredTier: DashTier;
  isFixed: boolean;        // quick_add / ai_assistant
  isCustomizable: boolean;
};

const F = (
  key: string, label: string, route: string, icon: string, category: string, requiredTier: DashTier, description = '',
): DashFeature => ({ key, label, description, route, icon, category, requiredTier, isFixed: false, isCustomizable: true });

/** The two fixed buttons — always present, never removed/reordered/swapped. */
export const FIXED_FEATURES: DashFeature[] = [
  { key: 'quick_add', label: 'Add', description: 'Quick capture anything', route: '/capture', icon: 'plus', category: 'core', requiredTier: 'free', isFixed: true, isCustomizable: false },
  { key: 'ai_assistant', label: 'AI', description: 'Ask your family AI', route: '/dashboard/assistant', icon: 'sparkles', category: 'core', requiredTier: 'free', isFixed: true, isCustomizable: false },
];

/** Customizable dashboard buttons. Routes are real, deduped, non-breaking. */
export const DASH_FEATURES: DashFeature[] = [
  F('calendar', 'Calendar', '/dashboard/calendar', 'calendar', 'daily', 'free'),
  F('grocery', 'Shopping', '/dashboard/grocery', 'cart', 'daily', 'free'),
  F('tasks', 'Tasks', '/dashboard/todos', 'list', 'daily', 'free'),
  F('messages', 'Messenger', '/dashboard/messages', 'message', 'daily', 'free'),
  F('notes', 'Notes', '/dashboard/notes', 'note', 'daily', 'free'),
  F('photos', 'Photos', '/dashboard/photos', 'image', 'daily', 'free'),
  F('contacts', 'Contacts', '/dashboard/contacts', 'users', 'daily', 'free'),
  F('habits', 'Habits', '/dashboard/habits', 'repeat', 'daily', 'free'),
  F('journal', 'Journal', '/dashboard/journal', 'notebook', 'daily', 'free'),
  F('school', 'School', '/dashboard/school', 'school', 'family', 'free'),
  F('meals', 'Meals', '/dashboard/meals', 'meal', 'daily', 'free'),
  F('weather', 'Weather', '/dashboard/weather', 'weather', 'daily', 'free'),
  F('wallet', 'Wallet', '/wallet', 'wallet', 'finance', 'free'),
  F('finances', 'Finances', '/dashboard/billing', 'card', 'finance', 'free'),
  // ── Basic ──
  F('chores', 'Chores', '/dashboard/chores', 'check', 'family', 'basic'),
  F('recipes', 'Recipes', '/dashboard/recipes', 'chef', 'daily', 'basic'),
  F('documents', 'Documents', '/dashboard/documents', 'folder', 'daily', 'basic'),
  F('goals', 'Goals', '/dashboard/goals', 'target', 'family', 'basic'),
  F('health', 'Health', '/dashboard/health', 'heart', 'family', 'basic'),
  F('vacation', 'Vacations', '/dashboard/vacations', 'plane', 'family', 'basic'),
  F('weekend', 'Weekend', '/dashboard/weekend', 'calendar-range', 'family', 'basic'),
  F('readiness', 'Readiness', '/dashboard/readiness', 'gauge', 'family', 'basic'),
  // ── Plus ──
  F('sports', 'Sports', '/dashboard/sports', 'trophy', 'family', 'plus'),
  F('rewards', 'Rewards', '/dashboard/rewards', 'gift', 'family', 'plus'),
  F('briefing', 'Daily Briefing', '/dashboard/briefing', 'sun', 'ai', 'plus'),
  F('command_center', 'Command Center', '/dashboard/command-center', 'command', 'ai', 'plus'),
  F('autopilot', 'Autopilot', '/dashboard/autopilot', 'rocket', 'ai', 'plus'),
  F('emergency', 'Emergency', '/dashboard/family-emergency', 'shield', 'family', 'plus'),
];

export const ALL_FEATURES: DashFeature[] = [...FIXED_FEATURES, ...DASH_FEATURES];
export const FEATURE_BY_KEY: Record<string, DashFeature> = Object.fromEntries(ALL_FEATURES.map((f) => [f.key, f]));

export const MAX_DASH_BUTTONS = 8;

export const TIER_RANK: Record<DashTier, number> = { free: 0, basic: 1, plus: 2 };

export function tierForPlanLevel(level: number): DashTier {
  return level >= 2 ? 'plus' : level === 1 ? 'basic' : 'free';
}

/** Tier-correct default layouts (free defaults are free-only, etc.). */
export const DEFAULT_LAYOUT_BY_TIER: Record<DashTier, string[]> = {
  free: ['calendar', 'grocery', 'tasks', 'messages', 'notes', 'photos', 'contacts', 'wallet'],
  basic: ['calendar', 'grocery', 'chores', 'school', 'meals', 'goals', 'recipes', 'documents'],
  plus: ['command_center', 'briefing', 'calendar', 'chores', 'meals', 'sports', 'readiness', 'autopilot'],
};
