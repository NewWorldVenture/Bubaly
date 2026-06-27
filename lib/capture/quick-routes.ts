// Catalog of quick-jump destinations for the Capture screen. Each carries the
// plan level it requires (0 = Free, 1 = Basic+, 2 = Plus+), mirroring the sidebar
// nav gating. The Capture screen shows only routes available at the family's tier
// by default, and lets the user customize which ones appear (and their order).
import {
  Calendar, CheckSquare, ShoppingCart, Home, HeartPulse, Plane, UtensilsCrossed,
  StickyNote, FolderLock, Bell, ListChecks, Image as ImageIcon, ChefHat, Gift, DollarSign,
  Sparkles, type LucideIcon,
} from 'lucide-react';

export type QuickRoute = {
  key: string;
  label: string;
  href: string;
  hint: string;
  icon: LucideIcon;
  minLevel: number;
};

// Order here is the default display order.
export const QUICK_ROUTE_CATALOG: QuickRoute[] = [
  { key: 'calendar', label: 'Calendar', href: '/dashboard/calendar', hint: 'Add event', icon: Calendar, minLevel: 0 },
  { key: 'tasks', label: 'Tasks', href: '/dashboard/chores', hint: 'Create task', icon: CheckSquare, minLevel: 1 },
  { key: 'grocery', label: 'Grocery', href: '/dashboard/grocery', hint: 'Add to list', icon: ShoppingCart, minLevel: 0 },
  { key: 'home', label: 'Home', href: '/dashboard/home', hint: 'Home task', icon: Home, minLevel: 1 },
  { key: 'health', label: 'Health', href: '/dashboard/health', hint: 'Log health', icon: HeartPulse, minLevel: 1 },
  { key: 'trip', label: 'Trip', href: '/dashboard/trips', hint: 'Plan trip', icon: Plane, minLevel: 1 },
  { key: 'meals', label: 'Meals', href: '/dashboard/meals', hint: 'Plan a meal', icon: UtensilsCrossed, minLevel: 1 },
  { key: 'reminders', label: 'Reminders', href: '/dashboard/reminders', hint: 'Set reminder', icon: Bell, minLevel: 0 },
  { key: 'todos', label: 'To-Dos', href: '/dashboard/todos', hint: 'Add to-do', icon: ListChecks, minLevel: 0 },
  { key: 'notes', label: 'Notes', href: '/dashboard/notes', hint: 'Jot a note', icon: StickyNote, minLevel: 0 },
  { key: 'documents', label: 'Documents', href: '/dashboard/documents', hint: 'Save a doc', icon: FolderLock, minLevel: 0 },
  { key: 'photos', label: 'Photos', href: '/dashboard/photos', hint: 'Add photo', icon: ImageIcon, minLevel: 0 },
  { key: 'recipes', label: 'Recipes', href: '/dashboard/recipes', hint: 'Save recipe', icon: ChefHat, minLevel: 0 },
  { key: 'wishlists', label: 'Wish Lists', href: '/dashboard/wishlists', hint: 'Add a wish', icon: Gift, minLevel: 0 },
  { key: 'expenses', label: 'Expenses', href: '/dashboard/expenses', hint: 'Log expense', icon: DollarSign, minLevel: 1 },
  { key: 'assistant', label: 'Assistant', href: '/dashboard/assistant', hint: 'Ask AI', icon: Sparkles, minLevel: 0 },
];

/** Routes the family's plan can actually use (locked ones excluded). */
export function availableQuickRoutes(planLevel: number): QuickRoute[] {
  return QUICK_ROUTE_CATALOG.filter((r) => r.minLevel <= planLevel);
}

/** The default keys shown for a tier: the first `count` available routes. */
export function defaultQuickRouteKeys(planLevel: number, count = 6): string[] {
  return availableQuickRoutes(planLevel).slice(0, count).map((r) => r.key);
}

/**
 * Resolve the routes to render from a saved customization. Saved keys are kept in
 * their saved order but filtered to ones still available at the tier (so a
 * downgrade or removed route never renders a locked/broken button). Falls back to
 * the tier default when there's no valid saved selection.
 */
export function resolveQuickRoutes(savedKeys: string[] | null, planLevel: number): QuickRoute[] {
  const byKey = new Map(availableQuickRoutes(planLevel).map((r) => [r.key, r]));
  if (savedKeys && savedKeys.length > 0) {
    const picked = savedKeys.map((k) => byKey.get(k)).filter((r): r is QuickRoute => Boolean(r));
    if (picked.length > 0) return picked;
  }
  return defaultQuickRouteKeys(planLevel).map((k) => byKey.get(k)!).filter(Boolean);
}
