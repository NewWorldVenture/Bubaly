import {
  LayoutDashboard, Calendar, CheckSquare, UtensilsCrossed, ShoppingCart,
  GraduationCap, Trophy, HeartPulse, Home, FolderLock, StickyNote,
  Sparkles, Settings, CreditCard, UsersRound, ShieldCheck, Activity,
  FolderKanban, Plug, BarChart3, Sun, CalendarDays, Stethoscope, Smile, TicketCheck,
  UserCog, ClipboardList, Inbox, ScanLine, Monitor, Megaphone,
  MessageCircle, Image as ImageGallery, Users, Bell, ChefHat, ListChecks,
  DollarSign, HardDrive, RefreshCw, Gauge, Command, Bot, Brain, Wallet,
  Zap, Network, ShieldAlert, BookHeart, Import, Share2, CloudSun, Car, Pill, Gift, Plane, BookOpen, HeartHandshake, CalendarClock, MapPin, CalendarRange, Cake, SlidersHorizontal, Boxes, GitBranch, Heart, PawPrint, ScrollText, type LucideIcon,
} from 'lucide-react';

/** A single nav destination. `minLevel` is the lowest plan that can use it:
 *  0 = Free (everyone), 1 = Family Basic+, 2 = Family+. Omitted = 0 (free). */
export type NavItem = { href: string; label: string; icon: LucideIcon; minLevel?: number };

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
      { href: '/dashboard/briefing', label: 'Daily Briefing', icon: Sun, minLevel: 1 },
      { href: '/dashboard/weekly-briefing', label: 'Weekly Briefing', icon: CalendarDays, minLevel: 2 },
      { href: '/dashboard/command-center', label: 'Command Center', icon: Gauge, minLevel: 2 },
      { href: '/dashboard/assistant', label: 'AI Assistant', icon: Sparkles, minLevel: 0 },
      { href: '/dashboard/calendar', label: 'Calendar', icon: Calendar, minLevel: 0 },
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
      { href: '/dashboard/meals', label: 'Meals', icon: UtensilsCrossed, minLevel: 1 },
      { href: '/dashboard/pantry', label: 'Pantry', icon: Boxes, minLevel: 1 },
      { href: '/dashboard/messages', label: 'Messages', icon: MessageCircle, minLevel: 0 },
      { href: '/dashboard/announcements', label: 'Announcements', icon: Megaphone, minLevel: 0 },
      { href: '/dashboard/activity', label: 'Activity Feed', icon: Activity, minLevel: 0 },
      { href: '/dashboard/celebrations', label: 'Celebrations', icon: Cake, minLevel: 0 },
      { href: '/dashboard/readiness', label: 'Readiness', icon: Gauge, minLevel: 0 },
      { href: '/dashboard/memories', label: 'Memories', icon: BookHeart, minLevel: 0 },
      { href: '/dashboard/family-tree', label: 'Family Tree', icon: GitBranch, minLevel: 0 },
      { href: '/dashboard/grandparent-portal', label: 'Grandparent Portal', icon: Heart, minLevel: 0 },
      { href: '/dashboard/pets', label: 'Pets', icon: PawPrint, minLevel: 0 },
      { href: '/dashboard/locator', label: 'Family Map', icon: MapPin, minLevel: 1 },
      { href: '/dashboard/social', label: 'Social Command', icon: Share2, minLevel: 0 },
      { href: '/dashboard/grocery', label: 'Groceries', icon: ShoppingCart, minLevel: 0 },
      { href: '/dashboard/reminders', label: 'Reminders', icon: Bell, minLevel: 0 },
      { href: '/dashboard/weather', label: 'Weather', icon: CloudSun, minLevel: 0 },
      { href: '/dashboard/recipes', label: 'Recipes', icon: ChefHat, minLevel: 0 },
      { href: '/dashboard/photos', label: 'Photos', icon: ImageGallery, minLevel: 0 },
      { href: '/dashboard/todos', label: 'To-Do Lists', icon: ListChecks, minLevel: 0 },
      { href: '/dashboard/wishlists', label: 'Wish Lists', icon: Gift, minLevel: 0 },
      { href: '/dashboard/documents', label: 'Documents', icon: FolderLock, minLevel: 0 },
      { href: '/dashboard/notes', label: 'Notes', icon: StickyNote, minLevel: 0 },
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
      { href: '/dashboard/trip-memories', label: 'Trip Memories', icon: BookHeart, minLevel: 1 },
      { href: '/dashboard/sports', label: 'Sports', icon: Trophy, minLevel: 1 },
      { href: '/dashboard/rides', label: 'Rides & Carpool', icon: Car, minLevel: 1 },
      { href: '/display', label: 'Kitchen Display', icon: Monitor, minLevel: 1 },
      { href: '/dashboard/health', label: 'Health', icon: HeartPulse, minLevel: 1 },
      { href: '/dashboard/scan', label: 'Scan Flyer', icon: ScanLine, minLevel: 1 },
      { href: '/dashboard/medical', label: 'Medical', icon: Stethoscope, minLevel: 1 },
      { href: '/dashboard/medications', label: 'Medications', icon: Pill, minLevel: 1 },
      { href: '/dashboard/care', label: 'Care Log', icon: HeartHandshake, minLevel: 1 },
      { href: '/dashboard/inbox', label: 'Magic Import', icon: Inbox, minLevel: 1 },
      { href: '/dashboard/dental', label: 'Dental', icon: Smile, minLevel: 1 },
      { href: '/dashboard/settings', label: 'Settings', icon: Settings, minLevel: 0 },
    ],
  },
  {
    title: 'Finances & Admin',
    layout: 'grid',
    items: [
      { href: '/dashboard/billing', label: 'Finances', icon: CreditCard, minLevel: 0 },
      { href: '/dashboard/expenses', label: 'Expense Splitting', icon: DollarSign, minLevel: 1 },
      { href: '/dashboard/subscriptions', label: 'Subscriptions', icon: RefreshCw, minLevel: 1 },
      { href: '/dashboard/insurance', label: 'Insurance Hub', icon: ShieldAlert, minLevel: 1 },
      { href: '/dashboard/tax-vault', label: 'Tax Vault', icon: FolderLock, minLevel: 1 },
      { href: '/dashboard/estate', label: 'Estate & Legacy', icon: ScrollText, minLevel: 1 },
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
      { href: '/dashboard/family-ai-assistant', label: 'AI Assistant', icon: Sparkles, minLevel: 2 },
      { href: '/dashboard/family-digital-twin', label: 'Digital Twin', icon: Brain, minLevel: 2 },
      { href: '/dashboard/family-cfo', label: 'Family CFO', icon: Wallet, minLevel: 2 },
      { href: '/dashboard/family-coo', label: 'Family COO', icon: ClipboardList, minLevel: 2 },
      { href: '/dashboard/family-health', label: 'Health Coordinator', icon: HeartPulse, minLevel: 2 },
      { href: '/dashboard/family-school', label: 'School Hub', icon: GraduationCap, minLevel: 2 },
      { href: '/dashboard/family-sports', label: 'Sports Hub', icon: Trophy, minLevel: 2 },
      { href: '/dashboard/family-memory', label: 'Memory Brain', icon: BookHeart, minLevel: 2 },
      { href: '/dashboard/family-emergency', label: 'Emergency Hub', icon: ShieldAlert, minLevel: 2 },
      { href: '/dashboard/family-stress', label: 'Stress Prediction', icon: Gauge, minLevel: 2 },
      { href: '/dashboard/family-automation', label: 'Life Automation', icon: Zap, minLevel: 2 },
      { href: '/dashboard/family-knowledge-graph', label: 'Knowledge Graph', icon: Network, minLevel: 2 },
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
  { href: '/admin/security', label: 'Security', icon: ShieldCheck },
  { href: '/admin/reports', label: 'Reports & Analytics', icon: BarChart3 },
  { href: '/admin/billing', label: 'Billing & Payments', icon: DollarSign },
  { href: '/admin/integrations', label: 'Integrations', icon: Plug },
  { href: '/admin/sync', label: 'Sync Platform', icon: RefreshCw },
  { href: '/admin/social', label: 'Social Platform', icon: Share2 },
  { href: '/admin/backup', label: 'Backup & Restore', icon: HardDrive },
  { href: '/admin/audit-logs', label: 'Audit Logs', icon: ClipboardList },
  { href: '/admin/support-tickets', label: 'Support Tickets', icon: TicketCheck },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
  { href: '/admin/admins', label: 'Admin', icon: UserCog },
];

/** Bottom tab bar on mobile web — the 5 highest-frequency destinations. */
export const MOBILE_TABS: NavItem[] = [
  { href: '/dashboard', label: 'Home', icon: LayoutDashboard, minLevel: 0 },
  { href: '/dashboard/calendar', label: 'Calendar', icon: Calendar, minLevel: 0 },
  { href: '/dashboard/chores', label: 'Chores', icon: CheckSquare, minLevel: 1 },
  { href: '/dashboard/grocery', label: 'Grocery', icon: ShoppingCart, minLevel: 0 },
  { href: '/dashboard/assistant', label: 'Assistant', icon: Sparkles, minLevel: 0 },
];
