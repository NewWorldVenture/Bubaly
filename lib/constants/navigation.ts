import {
  LayoutDashboard, Calendar, CheckSquare, UtensilsCrossed, ShoppingCart,
  GraduationCap, Trophy, HeartPulse, Home, FolderLock, StickyNote,
  Sparkles, Settings, CreditCard, UsersRound, ShieldCheck, Activity,
  FolderKanban, Plug, BarChart3, Sun, Stethoscope, Smile, TicketCheck,
  UserCog, ClipboardList, DatabaseBackup, type LucideIcon,
} from 'lucide-react';

export type NavItem = { href: string; label: string; icon: LucideIcon };

/** Marketing top-nav. */
export const MARKETING_NAV = [
  { href: '/features', label: 'Features' },
  { href: '/how-it-works', label: 'How It Works' },
  { href: '/ai', label: 'AI Assistant' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/security', label: 'Security' },
  { href: '/blog', label: 'Blog' },
] as const;

/** Authenticated app sidebar / mobile tab navigation. */
export const APP_NAV: NavItem[] = [
  { href: '/dashboard/briefing', label: 'Daily Briefing', icon: Sun },
  { href: '/dashboard/assistant', label: 'AI Assistant', icon: Sparkles },
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/dashboard/calendar', label: 'Calendar', icon: Calendar },
  { href: '/dashboard/chores', label: 'Tasks & Chores', icon: CheckSquare },
  { href: '/dashboard/meals', label: 'Meals', icon: UtensilsCrossed },
  { href: '/dashboard/grocery', label: 'Groceries', icon: ShoppingCart },
  { href: '/dashboard/school', label: 'School', icon: GraduationCap },
  { href: '/dashboard/sports', label: 'Sports', icon: Trophy },
  { href: '/dashboard/health', label: 'Health', icon: HeartPulse },
  { href: '/dashboard/medical', label: 'Medical', icon: Stethoscope },
  { href: '/dashboard/dental', label: 'Dental', icon: Smile },
  { href: '/dashboard/documents', label: 'Documents', icon: FolderLock },
  { href: '/dashboard/home', label: 'Home & Maintenance', icon: Home },
  { href: '/dashboard/notes', label: 'Notes', icon: StickyNote },
  { href: '/dashboard/billing', label: 'Finances', icon: CreditCard },
  { href: '/dashboard/settings#members', label: 'Family Members', icon: UsersRound },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
];

/**
 * Site Admin sidebar — every entry here must point at a real, working page.
 * No "coming soon" stubs: if a console section isn't built yet, it isn't listed.
 */
export const ADMIN_NAV: NavItem[] = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/users', label: 'Users & Families', icon: UsersRound },
  { href: '/admin/subscriptions', label: 'Subscriptions', icon: CreditCard },
  { href: '/admin/system', label: 'System Overview', icon: Activity },
  { href: '/admin/content', label: 'Content Management', icon: FolderKanban },
  { href: '/admin/security', label: 'Security', icon: ShieldCheck },
  { href: '/admin/reports', label: 'Reports & Analytics', icon: BarChart3 },
  { href: '/admin/integrations', label: 'Integrations', icon: Plug },
  { href: '/admin/audit-logs', label: 'Audit Logs', icon: ClipboardList },
  { href: '/admin/support-tickets', label: 'Support Tickets', icon: TicketCheck },
  { href: '/admin/admins', label: 'Admin', icon: UserCog },
];

/** Bottom tab bar on mobile web — the 5 highest-frequency destinations. */
export const MOBILE_TABS: NavItem[] = [
  { href: '/dashboard', label: 'Home', icon: LayoutDashboard },
  { href: '/dashboard/calendar', label: 'Calendar', icon: Calendar },
  { href: '/dashboard/chores', label: 'Chores', icon: CheckSquare },
  { href: '/dashboard/grocery', label: 'Grocery', icon: ShoppingCart },
  { href: '/dashboard/assistant', label: 'Assistant', icon: Sparkles },
];
