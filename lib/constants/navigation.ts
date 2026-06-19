import {
  LayoutDashboard, Calendar, CheckSquare, UtensilsCrossed, ShoppingCart,
  GraduationCap, Trophy, HeartPulse, Home, FolderLock, StickyNote,
  Sparkles, Settings, CreditCard, UsersRound, type LucideIcon,
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
  { href: '/dashboard/assistant', label: 'AI Assistant', icon: Sparkles },
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/dashboard/calendar', label: 'Calendar', icon: Calendar },
  { href: '/dashboard/chores', label: 'Tasks & Chores', icon: CheckSquare },
  { href: '/dashboard/meals', label: 'Meals', icon: UtensilsCrossed },
  { href: '/dashboard/grocery', label: 'Groceries', icon: ShoppingCart },
  { href: '/dashboard/school', label: 'School', icon: GraduationCap },
  { href: '/dashboard/sports', label: 'Sports', icon: Trophy },
  { href: '/dashboard/health', label: 'Health', icon: HeartPulse },
  { href: '/dashboard/documents', label: 'Documents', icon: FolderLock },
  { href: '/dashboard/home', label: 'Home & Maintenance', icon: Home },
  { href: '/dashboard/notes', label: 'Notes', icon: StickyNote },
  { href: '/dashboard/billing', label: 'Finances', icon: CreditCard },
  { href: '/dashboard/settings#members', label: 'Family Members', icon: UsersRound },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
];

/** Bottom tab bar on mobile web — the 5 highest-frequency destinations. */
export const MOBILE_TABS: NavItem[] = [
  { href: '/dashboard', label: 'Home', icon: LayoutDashboard },
  { href: '/dashboard/calendar', label: 'Calendar', icon: Calendar },
  { href: '/dashboard/chores', label: 'Chores', icon: CheckSquare },
  { href: '/dashboard/grocery', label: 'Grocery', icon: ShoppingCart },
  { href: '/dashboard/assistant', label: 'Assistant', icon: Sparkles },
];
