import {
  LayoutDashboard, Calendar, CheckSquare, UtensilsCrossed, ShoppingCart,
  GraduationCap, Trophy, HeartPulse, Home, FolderLock, StickyNote,
  Sparkles, Settings, CreditCard, UsersRound, ShieldCheck, Activity,
  FolderKanban, Plug, BarChart3, Sun, CalendarDays, Stethoscope, Smile, TicketCheck,
  UserCog, ClipboardList, Inbox, ScanLine, Monitor, Megaphone,
  MessageCircle, Image as ImageGallery, Users, Bell, ChefHat, ListChecks,
  DollarSign, HardDrive, RefreshCw, Gauge, Command, Bot, Brain, Wallet, Coins, Rss,
  Zap, Network, ShieldAlert, BookHeart, Import, Share2, CloudSun, Car, Pill, Gift, Plane, BookOpen, HeartHandshake, CalendarClock, MapPin, CalendarRange, Cake, SlidersHorizontal, Boxes, GitBranch, Heart, PawPrint, Plus, Repeat, Rocket, NotebookPen, Focus, PhoneCall, LayoutGrid, HelpCircle, Smartphone, Apple, Utensils, PiggyBank, Receipt, Target, FileText, History, Cloud, Lock, Store, Mic, Wand2, Leaf, Scale, Radar, Milestone, ClipboardCheck, Compass, type LucideIcon,
} from 'lucide-react';
import { AllServicesIcon } from '@/components/app/icons/all-services-icon';

/** A single nav destination. `minLevel` is the lowest plan that can use it:
 *  0 = Free (everyone), 1 = Family Basic+, 2 = Family+. Omitted = 0 (free).
 *  `manage: true` marks a manager-only destination (parent/adult) — hidden from
 *  kids/teens/guests, who a `isManager` page guard would redirect away anyway.
 *  `children` makes the item an expandable group whose sub-items navigate. */
export type NavItem = { href: string; label: string; icon: LucideIcon; minLevel?: number; manage?: boolean; children?: NavItem[] };

/** Role visibility for a nav destination (Friction #8, role-tailored surfaces):
 *  `manage`-only items are hidden from non-managers (kids/teens/guests) since the
 *  page's `isManager` guard redirects them away anyway — so showing the link is a
 *  dead-end. Super-admins always see everything. Plan/tier gating is separate
 *  (see `resolveItems`). Pure + deterministic so it's unit-testable. */
export function isNavItemVisibleToRole(
  item: NavItem,
  opts: { isManager: boolean; isSuperAdmin?: boolean },
): boolean {
  if (item.manage && !opts.isManager && !opts.isSuperAdmin) return false;
  return true;
}

/** A titled section of the app sidebar. */
export type NavGroup = { title: string; layout: 'list' | 'grid'; items: NavItem[] };

/** Marketing top-nav. */
export const MARKETING_NAV = [
  { href: '/features', label: 'Features' },
  { href: '/how-it-works', label: 'How It Works' },
  { href: '/ai', label: 'AI Assistant' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/security', label: 'Security' },
  { href: '/blog', label: 'Blog' },
] as const;

/**
 * Authenticated app sidebar nav, grouped into sections. `minLevel` gates each
 * item by subscription plan — items above the family's plan render greyed-out
 * and open an upgrade prompt instead of navigating. The Free tier (level 0)
 * mirrors the published Free plan: calendar, lists, recipes, messenger,
 * contacts, notes, photos, documents, reminders, and the (metered) AI assistant.
 *
 * The two dashboard entries (personal + family) are rendered separately and
 * role-aware at the top of the SUGGESTED group — see SidebarDashboardLinks.
 */
export const APP_NAV_GROUPS: NavGroup[] = [
  {
    title: 'Suggested',
    layout: 'list',
    items: [
      { href: '/dashboard/autopilot', label: 'Family Autopilot', icon: Rocket, minLevel: 2 },
      { href: '/dashboard/briefing', label: 'Daily Briefing', icon: Sun, minLevel: 1 },
      { href: '/dashboard/weekly-briefing', label: 'Weekly Briefing', icon: CalendarDays, minLevel: 2 },
      { href: '/dashboard/command-center', label: 'Command Center', icon: Gauge, minLevel: 2 },
      { href: '/dashboard/assistant', label: 'AI Assistant', icon: Sparkles, minLevel: 0 },
      { href: '/dashboard/moments', label: 'Moments', icon: CalendarClock, minLevel: 0 },
      { href: '/dashboard/next-best-actions', label: 'Next Best Actions', icon: Target, minLevel: 0 },
      { href: '/dashboard/family-operating-index', label: 'Operating Index', icon: Gauge, minLevel: 0 },
      { href: '/dashboard/outcomes', label: 'Outcomes', icon: Wand2, minLevel: 0 },
      { href: '/dashboard/agents', label: 'Family Assistant', icon: Bot, minLevel: 0 },
      { href: '/dashboard/graph', label: 'Reasoning Graph', icon: GitBranch, minLevel: 0 },
      { href: '/dashboard/decisions', label: 'Decision Engine', icon: Scale, minLevel: 0 },
      { href: '/dashboard/prep-plans', label: 'Prep Plans', icon: CalendarClock, minLevel: 0 },
      { href: '/dashboard/intelligence', label: 'Intelligence Network', icon: Radar, minLevel: 0 },
      { href: '/dashboard/family-signals', label: 'Family Intelligence', icon: Brain, minLevel: 0 },
      { href: '/dashboard/reasoning', label: 'Family Reasoning', icon: Compass, minLevel: 0 },
      { href: '/dashboard/calm', label: 'Calm', icon: Leaf, minLevel: 0 },
      { href: '/dashboard/connections', label: 'Connections', icon: Network, minLevel: 0 },
      { href: '/dashboard/trust', label: 'Trust & Permissions', icon: ShieldCheck, minLevel: 0 },
      { href: '/dashboard/concierge', label: 'AI Concierge', icon: Plane, minLevel: 1 },
      { href: '/dashboard/trip-intel', label: 'Trip Intelligence', icon: MapPin, minLevel: 1 },
      { href: '/dashboard/front-desk', label: 'AI Front Desk', icon: PhoneCall, minLevel: 1 },
      { href: '/guardian', label: 'AI Call Guardian', icon: ShieldCheck, minLevel: 1 },
      { href: '/dashboard/inbox', label: 'Communications Hub', icon: Inbox, minLevel: 1 },
      { href: '/dashboard/calendar', label: 'Calendar', icon: Calendar, minLevel: 0 },
      { href: '/wallet', label: 'Family Wallet', icon: Wallet, minLevel: 0 },
      { href: '/dashboard/chores', label: 'Tasks & Chores', icon: CheckSquare, minLevel: 1 },
      { href: '/missions', label: 'Family Missions', icon: Trophy, minLevel: 1 },
      { href: '/dashboard/rewards', label: 'Rewards', icon: Gift, minLevel: 1 },
      { href: '/dashboard/behavior', label: 'Behavior', icon: Smile, minLevel: 1 },
      { href: '/dashboard/screen-time', label: 'Screen Time', icon: Monitor, minLevel: 1 },
    ],
  },
  {
    title: 'Daily Life',
    layout: 'grid',
    items: [
      { href: '/dashboard/kitchen', label: 'Smart Kitchen', icon: ChefHat, minLevel: 1 },
      { href: '/dashboard/meals', label: 'Meals', icon: UtensilsCrossed, minLevel: 1 },
      { href: '/dashboard/pantry', label: 'Pantry', icon: Boxes, minLevel: 1 },
      { href: '/dashboard/messages', label: 'Messages', icon: MessageCircle, minLevel: 0 },
      { href: '/dashboard/announcements', label: 'Announcements', icon: Megaphone, minLevel: 0 },
      { href: '/dashboard/activity', label: 'Activity Feed', icon: Activity, minLevel: 0 },
      { href: '/dashboard/celebrations', label: 'Celebrations', icon: Cake, minLevel: 0 },
      { href: '/dashboard/relationship', label: 'Relationship Helper', icon: HeartHandshake, minLevel: 0 },
      { href: '/dashboard/readiness', label: 'Readiness', icon: Gauge, minLevel: 0 },
      { href: '/dashboard/memories', label: 'Memories', icon: BookHeart, minLevel: 0 },
      { href: '/dashboard/family-tree', label: 'Family Tree', icon: GitBranch, minLevel: 0 },
      { href: '/dashboard/grandparent-portal', label: 'Grandparent Portal', icon: Heart, minLevel: 0 },
      { href: '/dashboard/pets', label: 'Pets', icon: PawPrint, minLevel: 0 },
      { href: '/dashboard/locator', label: 'Family Map', icon: MapPin, minLevel: 1 },
      { href: '/dashboard/social', label: 'Social Command', icon: Share2, minLevel: 1 },
      { href: '/dashboard/social-feed', label: 'Social Feed', icon: Rss, minLevel: 0 },
      { href: '/dashboard/grocery', label: 'Groceries', icon: ShoppingCart, minLevel: 0 },
      { href: '/dashboard/reminders', label: 'Reminders', icon: Bell, minLevel: 0 },
      { href: '/dashboard/weather', label: 'Weather', icon: CloudSun, minLevel: 0 },
      { href: '/dashboard/recipes', label: 'Recipes', icon: ChefHat, minLevel: 0 },
      { href: '/dashboard/photos', label: 'Photos', icon: ImageGallery, minLevel: 0 },
      { href: '/dashboard/todos', label: 'To-Do Lists', icon: ListChecks, minLevel: 0 },
      { href: '/dashboard/wishlists', label: 'Wish Lists', icon: Gift, minLevel: 0 },
      { href: '/dashboard/documents', label: 'Documents', icon: FolderLock, minLevel: 0 },
      { href: '/dashboard/notes', label: 'Notes', icon: StickyNote, minLevel: 0 },
      { href: '/dashboard/habits', label: 'Habits', icon: Repeat, minLevel: 0 },
      { href: '/dashboard/journal', label: 'Journal', icon: NotebookPen, minLevel: 0 },
      { href: '/dashboard/focus', label: 'Focus Mode', icon: Focus, minLevel: 0 },
      { href: '/dashboard/contacts', label: 'Contacts', icon: Users, minLevel: 0 },
    ],
  },
  {
    title: 'Family & Home',
    layout: 'grid',
    items: [
      { href: '/dashboard/school', label: 'School', icon: GraduationCap, minLevel: 1 },
      { href: '/dashboard/timetable', label: 'Timetable', icon: CalendarRange, minLevel: 1 },
      { href: '/dashboard/homework', label: 'Homework', icon: BookOpen, minLevel: 1 },
      { href: '/dashboard/signups', label: 'Signups', icon: CalendarClock, minLevel: 1 },
      { href: '/dashboard/home', label: 'Home & Maintenance', icon: Home, minLevel: 1 },
      { href: '/dashboard/utilities', label: 'Utilities', icon: Gauge, minLevel: 1 },
      { href: '/dashboard/binder', label: 'Household Binder', icon: FolderLock, minLevel: 1 },
      { href: '/dashboard/security', label: 'Security Alerts', icon: ShieldAlert, minLevel: 1 },
      { href: '/dashboard/devices', label: 'Smart Home', icon: Plug, minLevel: 1 },
      { href: '/dashboard/auto', label: 'Auto & Vehicles', icon: Car, minLevel: 1 },
      { href: '/dashboard/renewals', label: 'Renewals', icon: ShieldCheck, minLevel: 1 },
      { href: '/dashboard/trips', label: 'Trip Planner', icon: Plane, minLevel: 1 },
      { href: '/dashboard/vacations', label: 'Vacation Planner', icon: Sun, minLevel: 1 },
      { href: '/dashboard/weekend', label: 'Weekend Planner', icon: CalendarRange, minLevel: 1 },
      { href: '/dashboard/voting', label: 'Group Voting', icon: ListChecks, minLevel: 1 },
      { href: '/dashboard/life-events', label: 'Life & Milestones', icon: Milestone, minLevel: 0 },
      { href: '/dashboard/trip-memories', label: 'Trip Memories', icon: BookHeart, minLevel: 1 },
      { href: '/dashboard/sports', label: 'Sports', icon: Trophy, minLevel: 1 },
      { href: '/dashboard/rides', label: 'Rides & Carpool', icon: Car, minLevel: 1 },
      { href: '/marketplace', label: 'Marketplace', icon: Store, minLevel: 0 },
      { href: '/display', label: 'Kitchen Display', icon: Monitor, minLevel: 1 },
      { href: '/dashboard/health', label: 'Health', icon: HeartPulse, minLevel: 1 },
      { href: '/dashboard/scan', label: 'Scan Flyer', icon: ScanLine, minLevel: 1 },
      { href: '/dashboard/medical', label: 'Medical', icon: Stethoscope, minLevel: 1 },
      { href: '/dashboard/medications', label: 'Medications', icon: Pill, minLevel: 1 },
      { href: '/dashboard/care', label: 'Care Log', icon: HeartHandshake, minLevel: 1 },
      { href: '/dashboard/inbox', label: 'Communications Hub', icon: Inbox, minLevel: 1 },
      { href: '/dashboard/dental', label: 'Dental', icon: Smile, minLevel: 1 },
      { href: '/dashboard/family-access', label: 'Kid Logins', icon: UserCog, minLevel: 0, manage: true },
      { href: '/dashboard/settings', label: 'Settings', icon: Settings, minLevel: 0 },
    ],
  },
  {
    title: 'Finances & Admin',
    layout: 'grid',
    items: [
      { href: '/dashboard/billing', label: 'Finances', icon: CreditCard, minLevel: 0 },
      { href: '/wallet', label: 'Family Wallet', icon: Wallet, minLevel: 0 },
      { href: '/economy', label: 'Family Economy', icon: Coins, minLevel: 0 },
      { href: '/dashboard/expenses', label: 'Expense Splitting', icon: DollarSign, minLevel: 1 },
      { href: '/dashboard/subscriptions', label: 'Subscriptions', icon: RefreshCw, minLevel: 1 },
      { href: '/dashboard/insurance', label: 'Insurance Hub', icon: ShieldAlert, minLevel: 1 },
      { href: '/dashboard/tax-vault', label: 'Tax Vault', icon: FolderLock, minLevel: 1 },
      { href: '/dashboard/sync', label: 'Calendar Sync', icon: RefreshCw, minLevel: 0 },
      { href: '/dashboard/settings#members', label: 'Family Members', icon: UsersRound, minLevel: 0 },
      { href: '/dashboard/migrate', label: 'Switch to Bubaly', icon: Import, minLevel: 0 },
      { href: '/referrals', label: 'Refer a Family', icon: Gift, minLevel: 0 },
    ],
  },
  {
    // The differentiated Family AI Operating System surfaces (Family+ tier).
    title: 'Family AI OS',
    layout: 'grid',
    items: [
      { href: '/dashboard/family-operations', label: 'Operations', icon: Command, minLevel: 2 },
      { href: '/dashboard/conflicts', label: 'AI Conflict Resolution', icon: CalendarClock, minLevel: 2 },
      { href: '/dashboard/autonomous-family-management', label: 'Autonomous AI', icon: Bot, minLevel: 2 },
      { href: '/dashboard/voice', label: 'Voice Control', icon: Mic, minLevel: 0 },
      { href: '/dashboard/family-digital-twin', label: 'Digital Twin', icon: Brain, minLevel: 2 },
      { href: '/dashboard/family-cfo', label: 'Family CFO', icon: Wallet, minLevel: 2 },
      { href: '/dashboard/family-coo', label: 'Family COO', icon: ClipboardList, minLevel: 2 },
      { href: '/dashboard/family-health', label: 'Health Coordinator', icon: HeartPulse, minLevel: 2 },
      { href: '/dashboard/family-school', label: 'School Hub', icon: GraduationCap, minLevel: 2 },
      { href: '/dashboard/family-sports', label: 'Sports Hub', icon: Trophy, minLevel: 2 },
      { href: '/dashboard/knowledge', label: 'Knowledge Base', icon: Brain, minLevel: 0 },
      { href: '/dashboard/playbook', label: 'Family Playbook', icon: Wand2, minLevel: 0 },
      { href: '/dashboard/experience', label: 'Experience Scorecard', icon: ClipboardCheck, minLevel: 0 },
      { href: '/dashboard/family-emergency', label: 'Emergency Hub', icon: ShieldAlert, minLevel: 2 },
      { href: '/dashboard/family-stress', label: 'Stress Prediction', icon: Gauge, minLevel: 2 },
      { href: '/dashboard/family-automation', label: 'Life Automation', icon: Zap, minLevel: 2 },
    ],
  },
];

/**
 * Site Admin sidebar — every entry here must point at a real, working page.
 * No "coming soon" stubs: if a console section isn't built yet, it isn't listed.
 */
export const ADMIN_NAV: NavItem[] = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/users', label: 'Users & Families', icon: UsersRound },
  { href: '/admin/marketing', label: 'Marketing', icon: Megaphone },
  { href: '/admin/subscriptions', label: 'Subscriptions', icon: CreditCard },
  { href: '/admin/tier-features', label: 'Tier & Features', icon: SlidersHorizontal },
  { href: '/admin/system', label: 'System Overview', icon: Activity },
  { href: '/admin/content', label: 'Content Management', icon: FolderKanban },
  { href: '/admin/services', label: 'Service Catalog', icon: LayoutGrid },
  { href: '/admin/security', label: 'Security', icon: ShieldCheck },
  { href: '/admin/reports', label: 'Reports & Analytics', icon: BarChart3 },
  { href: '/admin/onboarding', label: 'Onboarding Audit', icon: Rocket },
  { href: '/admin/billing', label: 'Billing & Payments', icon: DollarSign },
  { href: '/admin/wallet', label: 'Family Wallet', icon: Wallet },
  { href: '/admin/stripe', label: 'Money (Stripe)', icon: CreditCard },
  { href: '/admin/integrations', label: 'Integrations', icon: Plug },
  { href: '/admin/sync', label: 'Sync Platform', icon: RefreshCw },
  { href: '/admin/social', label: 'Social Platform', icon: Share2 },
  { href: '/admin/backup', label: 'Backup & Restore', icon: HardDrive },
  { href: '/admin/audit-logs', label: 'Audit Logs', icon: ClipboardList },
  { href: '/admin/support-tickets', label: 'Support Tickets', icon: TicketCheck },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
  { href: '/admin/admins', label: 'Admin', icon: UserCog },
];

/**
 * Bottom tab bar on mobile web — 5 tabs: Home | Assistant | Capture | Inbox | Profile.
 * The Capture tab (index 2) is rendered as a raised FAB by the AppShell.
 * CAPTURE_TAB_INDEX marks which tab gets the special treatment.
 */
export const MOBILE_TABS: NavItem[] = [
  { href: '/home', label: 'Home', icon: Home, minLevel: 0 },
  { href: '/dashboard/assistant', label: 'Assistant', icon: Sparkles, minLevel: 0 },
  { href: '/capture', label: 'Capture', icon: Plus, minLevel: 0 },
  { href: '/dashboard/inbox', label: 'Inbox', icon: Inbox, minLevel: 0 },
  // Profile moved to the top-bar avatar menu; the 5th tab is now the Services
  // hub (the full categorized catalog). See app/(app)/services.
  { href: '/services', label: 'Services', icon: LayoutGrid, minLevel: 0 },
];

/** Index of the special Capture tab in MOBILE_TABS (rendered as a raised FAB). */
export const CAPTURE_TAB_INDEX = 2;

/**
 * Curated PRIMARY desktop sidebar for the **Free tier** — a calm, focused set of
 * everyday destinations (the full ~70-module catalog lives behind "All Services").
 * All free (minLevel 0). The Messages entry shows a live unread badge.
 */
export const PRIMARY_NAV: NavItem[] = [
  { href: '/home', label: 'Home', icon: Home },
  { href: '/dashboard/calendar', label: 'Calendar', icon: Calendar },
  { href: '/dashboard/todos', label: 'Tasks', icon: CheckSquare },
  {
    href: '/dashboard/meals', label: 'Meals', icon: UtensilsCrossed,
    children: [
      { href: '/dashboard/meals', label: 'Meal Planner', icon: CalendarRange },
      { href: '/dashboard/recipes', label: 'Recipes', icon: ChefHat },
      { href: '/dashboard/grocery', label: 'Grocery List', icon: ShoppingCart },
      { href: '/dashboard/pantry', label: 'Pantry Inventory', icon: Boxes },
      { href: '/dashboard/favorites', label: 'Family Favorites', icon: Heart },
      { href: '/dashboard/nutrition', label: 'Nutrition Tracker', icon: Apple },
      { href: '/dashboard/dining', label: 'Dining Out', icon: Utensils },
    ],
  },
  { href: '/dashboard/chores', label: 'Chores', icon: ListChecks },
  {
    href: '/dashboard/billing', label: 'Finances', icon: CreditCard,
    children: [
      { href: '/dashboard/budgets', label: 'Budget Planner', icon: PiggyBank },
      { href: '/wallet', label: 'My Wallet', icon: Wallet },
      { href: '/wallet/allowance', label: 'Allowances', icon: Coins },
      { href: '/dashboard/expenses', label: 'Expense Tracker', icon: Receipt },
      { href: '/dashboard/savings', label: 'Savings Goals', icon: Target },
      { href: '/dashboard/bills', label: 'Bill Manager', icon: FileText },
      { href: '/dashboard/subscriptions', label: 'Subscriptions', icon: RefreshCw },
      { href: '/dashboard/payments', label: 'Payment History', icon: History },
      { href: '/dashboard/autopay', label: 'Auto Pay', icon: Repeat },
      { href: '/dashboard/due', label: 'Due Reminders', icon: Bell },
    ],
  },
  { href: '/dashboard/memories', label: 'Memories', icon: ImageGallery },
  { href: '/dashboard/messages', label: 'Messages', icon: MessageCircle },
  {
    href: '/dashboard/documents', label: 'Files', icon: FolderLock,
    children: [
      { href: '/dashboard/documents', label: 'File Manager', icon: FileText },
      { href: '/dashboard/files/cloud', label: 'Cloud Storage', icon: Cloud },
      { href: '/dashboard/files/vault', label: 'Secure Vault', icon: Lock },
      { href: '/dashboard/files/shared', label: 'Shared Files', icon: Share2 },
      { href: '/dashboard/scan', label: 'Document Scanner', icon: ScanLine },
    ],
  },
  { href: '/wallet', label: 'Wallet', icon: Wallet },
  { href: '/dashboard/locator', label: 'Location', icon: MapPin },
  {
    href: '/dashboard/family', label: 'Family', icon: Users,
    children: [
      { href: '/dashboard/family/check-in', label: 'Check In', icon: ShieldCheck },
      { href: '/dashboard/family/find-phone', label: 'Find Phone', icon: Smartphone },
      { href: '/dashboard/family/driving-safety', label: 'Driving Safety', icon: Car },
      { href: '/dashboard/family/play-dates', label: 'Play Dates', icon: Heart },
    ],
  },
];

/**
 * Routes that are fixed sidebar chrome — never part of the customizable primary
 * list. AI Assistant is the top pill; Settings + Help & Support are the footer.
 */
const FIXED_SIDEBAR_ROUTES = new Set<string>(['/dashboard/assistant', '/dashboard/settings', '/dashboard/more']);

/**
 * The pool of destinations a member can put in their curated sidebar. It's the
 * curated PRIMARY_NAV (which carries the expandable Meals/Finances/Family groups)
 * plus every other **free** (minLevel 0) module from the full catalog, deduped by
 * route, minus the fixed chrome. Ordering here is the order they appear in the
 * "add a destination" picker. Built once at module load.
 */
export const NAV_CATALOG: NavItem[] = (() => {
  const out: NavItem[] = [];
  const seen = new Set<string>();
  const push = (item: NavItem) => {
    if (seen.has(item.href) || FIXED_SIDEBAR_ROUTES.has(item.href)) return;
    seen.add(item.href);
    out.push(item);
  };
  for (const item of PRIMARY_NAV) push(item);
  for (const group of APP_NAV_GROUPS) {
    for (const item of group.items) {
      if ((item.minLevel ?? 0) === 0) push({ href: item.href, label: item.label, icon: item.icon, manage: item.manage });
    }
  }
  return out;
})();

/** Fast route → catalog item lookup for resolving a saved layout to real items. */
export const NAV_CATALOG_BY_HREF: Map<string, NavItem> = new Map(NAV_CATALOG.map((i) => [i.href, i]));

/** Every selectable route (the customization allowlist). */
export const NAV_CATALOG_KEYS: string[] = NAV_CATALOG.map((i) => i.href);

/**
 * The FULL pin catalog: every role-appropriate service across ALL plan tiers
 * (superset of NAV_CATALOG, which is free-only). Powers "pin any service in your
 * plan to the sidebar" — a member can pin higher-tier modules their plan
 * unlocks. Built exactly like NAV_CATALOG (PRIMARY_NAV keeps its expandable
 * children; group items are leaves) but WITHOUT the free-only filter. Payment-
 * tier gating happens at render time, so a pinned above-plan item shows locked.
 */
export const ALL_SERVICES_CATALOG: NavItem[] = (() => {
  const out: NavItem[] = [];
  const seen = new Set<string>();
  const push = (item: NavItem) => {
    if (seen.has(item.href) || FIXED_SIDEBAR_ROUTES.has(item.href)) return;
    seen.add(item.href);
    out.push(item);
  };
  for (const item of PRIMARY_NAV) push(item);
  for (const group of APP_NAV_GROUPS) {
    for (const item of group.items) push({ href: item.href, label: item.label, icon: item.icon, manage: item.manage, minLevel: item.minLevel });
  }
  return out;
})();

/** Route → item lookup across all tiers (for resolving pinned sidebar entries). */
export const ALL_SERVICES_BY_HREF: Map<string, NavItem> = new Map(ALL_SERVICES_CATALOG.map((i) => [i.href, i]));

/** Every pinnable route across all tiers (the sidebar-pin allowlist). */
export const ALL_SERVICES_KEYS: string[] = ALL_SERVICES_CATALOG.map((i) => i.href);

/** Default primary-sidebar layout (the curated order) as a list of routes. */
export const DEFAULT_SIDEBAR_NAV_KEYS: string[] = PRIMARY_NAV.map((i) => i.href);

/** Per-parent catalog of sub-pages (only for the expandable groups). The full
 *  set a member can reorder/remove/re-add under each group. */
export const NAV_CHILD_CATALOG_BY_PARENT: Map<string, NavItem[]> = new Map(
  NAV_CATALOG.filter((i) => i.children && i.children.length > 0).map((i) => [i.href, i.children as NavItem[]]),
);

/** Per-parent default (and valid) sub-page routes, in catalog order. */
export const NAV_CHILD_KEYS_BY_PARENT: Map<string, string[]> = new Map(
  [...NAV_CHILD_CATALOG_BY_PARENT.entries()].map(([parent, kids]) => [parent, kids.map((k) => k.href)]),
);

/**
 * The two role-aware dashboards, listed BELOW the primary destinations (above
 * Shortcuts) in the curated sidebar. Parent → the personal/parent home view;
 * Family → the shared family view. Both are free (everyone).
 */
export const DASHBOARD_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Parent Dashboard', icon: LayoutDashboard },
  { href: '/dashboard?view=family', label: 'Family Dashboard', icon: UsersRound },
];

/** Pinned footer of the Free-tier sidebar — always reachable, below All Services. */
export const SIDEBAR_FOOTER_NAV: NavItem[] = [
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
  { href: '/dashboard/more', label: 'Help & Support', icon: HelpCircle },
];

/** Icon for the "All Services" launcher that opens the full catalog. */
export const ALL_SERVICES_ICON = AllServicesIcon;
