import {
  LayoutDashboard, Calendar, CheckSquare, UtensilsCrossed, ShoppingCart,
  GraduationCap, Trophy, HeartPulse, Home, FolderLock, StickyNote,
  Target, Sparkles, Bell, Settings, CreditCard, type LucideIcon,
} from 'lucide-react';

export type NavItem = { href: string; label: string; icon: LucideIcon };

/** Marketing top-nav. */
export const MARKETING_NAV = [
  { href: '/features', label: 'Features' },
  { href: '/how-it-works', label: 'How it works' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/security', label: 'Security' },
  { href: '/ai', label: 'AI Assistant' },
  { href: '/mobile', label: 'Mobile' },
  { href: '/faq', label: 'FAQ' },
] as const;

/** Authenticated app sidebar / mobile tab navigation. */
export const APP_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/dashboard/calendar', label: 'Calendar', icon: Calendar },
  { href: '/dashboard/chores', label: 'Chores', icon: CheckSquare },
  { href: '/dashboard/meals', label: 'Meals', icon: UtensilsCrossed },
  { href: '/dashboard/grocery', label: 'Grocery', icon: ShoppingCart },
  { href: '/dashboard/school', label: 'School', icon: GraduationCap },
  { href: '/dashboard/sports', label: 'Sports', icon: Trophy },
  { href: '/dashboard/health', label: 'Health', icon: HeartPulse },
  { href: '/dashboard/home', label: 'Home', icon: Home },
  { href: '/dashboard/documents', label: 'Documents', icon: FolderLock },
  { href: '/dashboard/notes', label: 'Notes', icon: StickyNote },
  { href: '/dashboard/goals', label: 'Goals', icon: Target },
  { href: '/dashboard/assistant', label: 'AI Assistant', icon: Sparkles },
  { href: '/dashboard/notifications', label: 'Notifications', icon: Bell },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
  { href: '/dashboard/billing', label: 'Billing', icon: CreditCard },
];

/** Bottom tab bar on mobile web — the 5 highest-frequency destinations. */
export const MOBILE_TABS: NavItem[] = [
  { href: '/dashboard', label: 'Home', icon: LayoutDashboard },
  { href: '/dashboard/calendar', label: 'Calendar', icon: Calendar },
  { href: '/dashboard/chores', label: 'Chores', icon: CheckSquare },
  { href: '/dashboard/grocery', label: 'Grocery', icon: ShoppingCart },
  { href: '/dashboard/assistant', label: 'Assistant', icon: Sparkles },
];
