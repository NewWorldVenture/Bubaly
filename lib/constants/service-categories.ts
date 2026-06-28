// lib/constants/service-categories.ts — the "All Services" taxonomy that powers
// the mobile Services hub (app/(app)/services). Every catalog route is bucketed
// into exactly one of the eight mockup categories. Each category page resolves
// its items through the SAME plan-gating the sidebar uses (resolveItems →
// featureAccessByTier), so Off features are hidden and above-plan features show
// locked with an upgrade prompt — never a dead end.
import type { LucideIcon } from 'lucide-react';
import {
  Heart, DollarSign, GraduationCap, HeartPulse, MessageSquare, Home, ShieldCheck, LayoutGrid,
} from 'lucide-react';
import { APP_NAV_GROUPS, type NavItem } from './navigation';

export type ServiceCategory = {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Icon chip tint: [background, foreground] tailwind classes. */
  tint: string;
  countLabel: 'tools' | 'integrations';
  hrefs: string[];
};

const ALL_ITEMS: NavItem[] = APP_NAV_GROUPS.flatMap((g) => g.items);
const BY_HREF = new Map(ALL_ITEMS.map((i) => [i.href, i] as const));

/** Resolve a list of hrefs to their NavItems (drops any unknown href, de-dupes). */
export function navItemsForHrefs(hrefs: string[]): NavItem[] {
  const seen = new Set<string>();
  const out: NavItem[] = [];
  for (const href of hrefs) {
    if (seen.has(href)) continue;
    const item = BY_HREF.get(href);
    if (item) { out.push(item); seen.add(href); }
  }
  return out;
}

export const SERVICE_CATEGORIES: ServiceCategory[] = [
  {
    id: 'family-life',
    label: 'Family Life',
    description: 'Connect, organize & cherish every moment.',
    icon: Heart,
    tint: 'bg-violet-500/15 text-violet-300',
    countLabel: 'tools',
    hrefs: [
      '/dashboard/memories', '/dashboard/family-tree', '/dashboard/grandparent-portal',
      '/dashboard/pets', '/dashboard/celebrations', '/dashboard/relationship',
      '/dashboard/journal', '/dashboard/photos', '/dashboard/wishlists',
      '/dashboard/activity', '/dashboard/voting', '/dashboard/family-memory',
      '/dashboard/family-digital-twin',
    ],
  },
  {
    id: 'finances',
    label: 'Finances',
    description: 'Manage money, budgets & financial goals.',
    icon: DollarSign,
    tint: 'bg-emerald-500/15 text-emerald-300',
    countLabel: 'tools',
    hrefs: [
      '/dashboard/billing', '/wallet', '/economy', '/dashboard/expenses',
      '/dashboard/subscriptions', '/dashboard/insurance', '/dashboard/tax-vault',
      '/dashboard/family-cfo', '/referrals',
    ],
  },
  {
    id: 'kids-education',
    label: 'Kids & Education',
    description: 'Support learning, school & development.',
    icon: GraduationCap,
    tint: 'bg-amber-500/15 text-amber-300',
    countLabel: 'tools',
    hrefs: [
      '/dashboard/school', '/dashboard/timetable', '/dashboard/homework',
      '/dashboard/signups', '/dashboard/sports', '/dashboard/behavior',
      '/dashboard/screen-time', '/dashboard/rewards', '/dashboard/chores',
      '/missions', '/dashboard/habits', '/dashboard/family-school',
      '/dashboard/family-sports',
    ],
  },
  {
    id: 'health-wellness',
    label: 'Health & Wellness',
    description: 'Track health, wellness & live better together.',
    icon: HeartPulse,
    tint: 'bg-blue-500/15 text-blue-300',
    countLabel: 'tools',
    hrefs: [
      '/dashboard/health', '/dashboard/medical', '/dashboard/medications',
      '/dashboard/dental', '/dashboard/care', '/dashboard/readiness',
      '/dashboard/focus', '/dashboard/family-health', '/dashboard/family-stress',
    ],
  },
  {
    id: 'communications',
    label: 'Communications',
    description: 'Stay connected across all channels.',
    icon: MessageSquare,
    tint: 'bg-cyan-500/15 text-cyan-300',
    countLabel: 'tools',
    hrefs: [
      '/dashboard/assistant', '/dashboard/messages', '/dashboard/announcements',
      '/dashboard/inbox', '/dashboard/front-desk', '/dashboard/social',
      '/dashboard/social-feed', '/dashboard/contacts', '/dashboard/notes',
    ],
  },
  {
    id: 'home-management',
    label: 'Home Management',
    description: 'Manage your home & daily essentials.',
    icon: Home,
    tint: 'bg-pink-500/15 text-pink-300',
    countLabel: 'tools',
    hrefs: [
      '/dashboard/calendar', '/dashboard/todos', '/dashboard/reminders',
      '/dashboard/grocery', '/dashboard/weather', '/dashboard/kitchen',
      '/dashboard/meals', '/dashboard/pantry', '/dashboard/recipes',
      '/dashboard/documents', '/dashboard/home', '/dashboard/utilities',
      '/dashboard/binder', '/dashboard/auto', '/dashboard/renewals',
      '/dashboard/trips', '/dashboard/vacations', '/dashboard/weekend',
      '/dashboard/rides', '/dashboard/trip-memories', '/display', '/dashboard/scan',
      '/dashboard/autopilot', '/dashboard/briefing', '/dashboard/weekly-briefing',
      '/dashboard/command-center', '/dashboard/concierge', '/dashboard/trip-intel',
      '/dashboard/conflicts', '/dashboard/family-operations', '/dashboard/family-coo',
      '/dashboard/family-automation', '/dashboard/family-knowledge-graph',
      '/dashboard/autonomous-family-management', '/dashboard/family-ai-assistant',
    ],
  },
  {
    id: 'home-safety',
    label: 'Home Safety',
    description: 'Protect your family & what matters most.',
    icon: ShieldCheck,
    tint: 'bg-red-500/15 text-red-300',
    countLabel: 'tools',
    hrefs: [
      '/dashboard/security', '/dashboard/locator', '/dashboard/family-emergency',
      '/dashboard/trust',
    ],
  },
  {
    id: 'integrations',
    label: 'All Integrations',
    description: 'Connected apps & smart integrations.',
    icon: LayoutGrid,
    tint: 'bg-violet-500/15 text-violet-300',
    countLabel: 'integrations',
    hrefs: ['/dashboard/sync', '/dashboard/devices', '/dashboard/migrate'],
  },
];

export const SERVICE_CATEGORY_BY_ID: Record<string, ServiceCategory> =
  Object.fromEntries(SERVICE_CATEGORIES.map((c) => [c.id, c]));
