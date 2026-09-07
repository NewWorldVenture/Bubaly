import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APP_NAV_GROUPS, DASHBOARD_NAV, DEFAULT_SIDEBAR_NAV_KEYS, MARKETING_NAV, MOBILE_TABS, NAV_CATALOG_KEYS,
  PRIMARY_NAV, SIDEBAR_FOOTER_NAV, type NavItem,
} from '@/lib/constants/navigation';

const en = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const footer = readFileSync('components/marketing/site-footer.tsx', 'utf8');

describe('the marketing nav is outcome-first', () => {
  it('has at most six items and leads with what Bubaly handles', () => {
    expect(MARKETING_NAV.length).toBeLessThanOrEqual(6);
    expect(MARKETING_NAV[0]).toEqual({ href: '/features', label: 'What Bubaly handles', labelKey: 'marketing.nav.whatBubalyHandles' });
  });

  it('calls /security the Trust Center', () => {
    const security = MARKETING_NAV.find((i) => i.href === '/security');
    expect(security?.label).toBe('Trust Center');
    expect(security?.labelKey).toBe('marketing.nav.trustCenter');
  });

  it('never says "AI" in a nav label', () => {
    for (const item of MARKETING_NAV) expect(item.label).not.toMatch(/\bAI\b/);
  });

  it('resolves every label through a catalogue key that holds that label', () => {
    for (const item of MARKETING_NAV) {
      expect(en[item.labelKey], item.labelKey).toBe(item.label);
    }
  });
});

describe('the footer carries the routes the nav dropped', () => {
  it.each(['/security', '/dashboard/migrate', '/ai', '/features#kitchen-mode', '/features'])('links %s', (href) => {
    expect(footer).toContain(`href: '${href}'`);
  });

  it('resolves every group title and link through a catalogue key that holds real text', () => {
    // The footer's entries are keys only — no English `label` beside them —
    // because a key parked in a field called `label` once rendered verbatim to
    // every visitor. So the check is that each key RESOLVES, and that both the
    // titles and the links go through t().
    const keys = [...footer.matchAll(/(?:label|title)Key: '([^']+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(20);
    for (const key of keys) expect(en[key], key).toBeTruthy();
    expect(footer).toContain('{t(l.labelKey)}');
    expect(footer).toContain('{t(g.titleKey)}');
    expect(footer).not.toMatch(/\blabel: '/);
  });
});

// memory.md: the shared app sidebar must not change without an explicit
// request. lib/constants/navigation.ts is edited by this tranche (the
// MARKETING_NAV block), so the sidebar exports are pinned here, mechanically:
// any change to an item, its order, its icon, its tier or its role flag fails
// this test, and the reviewer sees exactly which line moved.
const icon = (item: NavItem) => (item.icon as unknown as { displayName?: string }).displayName ?? item.icon.name;
const line = (item: NavItem) =>
  `${item.href} | ${item.label} | ${icon(item)}${item.minLevel != null ? ` | L${item.minLevel}` : ''}${item.manage ? ' | manage' : ''}`;
const tree = (items: NavItem[], indent = ''): string[] =>
  items.flatMap((item) => [indent + line(item), ...(item.children ? tree(item.children, `${indent}  `) : [])]);

describe('the app sidebar exports are byte-for-byte what memory.md protects', () => {
  it('PRIMARY_NAV', () => {
    expect(tree(PRIMARY_NAV).join('\n')).toMatchInlineSnapshot(`
      "/home | Home | House
      /dashboard/calendar | Calendar | Calendar
      /dashboard/todos | Tasks | SquareCheckBig
      /dashboard/meals | Meals | UtensilsCrossed
        /dashboard/meals | Meal Planner | CalendarRange
        /dashboard/recipes | Recipes | ChefHat
        /dashboard/grocery | Grocery List | ShoppingCart
        /dashboard/pantry | Pantry Inventory | Boxes
        /dashboard/favorites | Family Favorites | Heart
        /dashboard/nutrition | Nutrition Tracker | Apple
        /dashboard/dining | Dining Out | Utensils
      /dashboard/chores | Chores | ListChecks
      /dashboard/billing | Finances | CreditCard
        /dashboard/budgets | Budget Planner | PiggyBank
        /wallet | My Wallet | Wallet
        /wallet/allowance | Allowances | Coins
        /dashboard/expenses | Expense Tracker | Receipt
        /dashboard/savings | Savings Goals | Target
        /dashboard/bills | Bill Manager | FileText
        /dashboard/subscriptions | Subscriptions | RefreshCw
        /dashboard/payments | Payment History | History
        /dashboard/autopay | Auto Pay | Repeat
        /dashboard/due | Due Reminders | Bell
      /dashboard/memories | Memories | Image
      /dashboard/messages | Messages | MessageCircle
      /dashboard/documents | Files | FolderLock
        /dashboard/documents | File Manager | FileText
        /dashboard/files/cloud | Cloud Storage | Cloud
        /dashboard/files/vault | Secure Vault | Lock
        /dashboard/files/shared | Shared Files | Share2
        /dashboard/scan | Document Scanner | ScanLine
      /wallet | Wallet | Wallet
      /dashboard/locator | Location | MapPin
      /dashboard/family | Family | Users
        /dashboard/family/check-in | Check In | ShieldCheck
        /dashboard/family/find-phone | Find Phone | Smartphone
        /dashboard/family/driving-safety | Driving Safety | Car
        /dashboard/family/play-dates | Play Dates | Heart"
    `);
  });

  it('APP_NAV_GROUPS', () => {
    const lines = APP_NAV_GROUPS.flatMap((g) => [`# ${g.title} (${g.layout})`, ...tree(g.items, '  ')]);
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "# Suggested (list)
        /dashboard/autopilot | Family Autopilot | Rocket | L2
        /dashboard/briefing | Daily Briefing | Sun | L1
        /dashboard/weekly-briefing | Weekly Briefing | CalendarDays | L2
        /dashboard/command-center | Command Center | Gauge | L2
        /dashboard/assistant | AI Assistant | Sparkles | L0
        /dashboard/moments | Moments | CalendarClock | L0
        /dashboard/next-best-actions | Next Best Actions | Target | L0
        /dashboard/family-operating-index | Operating Index | Gauge | L0
        /dashboard/outcomes | Outcomes | WandSparkles | L0
        /dashboard/agents | Family Assistant | Bot | L0
        /dashboard/graph | Reasoning Graph | GitBranch | L0
        /dashboard/decisions | Decision Engine | Scale | L0
        /dashboard/prep-plans | Prep Plans | CalendarClock | L0
        /dashboard/intelligence | Intelligence Network | Radar | L0
        /dashboard/family-signals | Family Intelligence | Brain | L0
        /dashboard/reasoning | Family Reasoning | Compass | L0
        /dashboard/calm | Calm | Leaf | L0
        /dashboard/connections | Connections | Network | L0
        /dashboard/trust | Trust & Permissions | ShieldCheck | L0
        /dashboard/concierge | AI Concierge | Plane | L1
        /dashboard/trip-intel | Trip Intelligence | MapPin | L1
        /dashboard/front-desk | AI Front Desk | PhoneCall | L1
        /dashboard/contact-center | Operations Center | Headset | L2
        /guardian | AI Call Guardian | ShieldCheck | L1
        /dashboard/inbox | Communications Hub | Inbox | L1
        /dashboard/calendar | Calendar | Calendar | L0
        /wallet | Family Wallet | Wallet | L0
        /dashboard/chores | Tasks & Chores | SquareCheckBig | L1
        /missions | Family Missions | Trophy | L1
        /dashboard/rewards | Rewards | Gift | L1
        /dashboard/behavior | Behavior | Smile | L1
        /dashboard/screen-time | Screen Time | Monitor | L1
      # Daily Life (grid)
        /dashboard/kitchen | Smart Kitchen | ChefHat | L1
        /dashboard/meals | Meals | UtensilsCrossed | L1
        /dashboard/pantry | Pantry | Boxes | L1
        /dashboard/messages | Messages | MessageCircle | L0
        /dashboard/announcements | Announcements | Megaphone | L0
        /dashboard/activity | Activity Feed | Activity | L0
        /dashboard/celebrations | Celebrations | Cake | L0
        /dashboard/relationship | Relationship Helper | HeartHandshake | L0
        /dashboard/readiness | Readiness | Gauge | L0
        /dashboard/memories | Memories | BookHeart | L0
        /dashboard/family-tree | Family Tree | GitBranch | L0
        /dashboard/grandparent-portal | Grandparent Portal | Heart | L0
        /dashboard/pets | Pets | PawPrint | L0
        /dashboard/closet | Closet & Outfits | Shirt | L0
        /dashboard/watchlist | Family Watchlist | Clapperboard | L0
        /dashboard/locator | Family Map | MapPin | L1
        /dashboard/social | Social Command | Share2 | L1
        /dashboard/social-feed | Social Feed | Rss | L0
        /dashboard/grocery | Groceries | ShoppingCart | L0
        /dashboard/reminders | Reminders | Bell | L0
        /dashboard/weather | Weather | CloudSun | L0
        /dashboard/recipes | Recipes | ChefHat | L0
        /dashboard/photos | Photos | Image | L0
        /dashboard/todos | To-Do Lists | ListChecks | L0
        /dashboard/wishlists | Wish Lists | Gift | L0
        /dashboard/documents | Documents | FolderLock | L0
        /dashboard/notes | Notes | StickyNote | L0
        /dashboard/habits | Habits | Repeat | L0
        /dashboard/journal | Journal | NotebookPen | L0
        /dashboard/focus | Focus Mode | Focus | L0
        /dashboard/contacts | Contacts | Users | L0
      # Family & Home (grid)
        /dashboard/school | School | GraduationCap | L1
        /dashboard/timetable | Timetable | CalendarRange | L1
        /dashboard/homework | Homework | BookOpen | L1
        /dashboard/language | Language Practice | Languages | L0
        /dashboard/signups | Signups | CalendarClock | L1
        /dashboard/home | Home & Maintenance | House | L1
        /dashboard/inventory | Home Inventory | PackageSearch | L0
        /dashboard/declutter | Declutter Missions | Sparkle | L0
        /dashboard/moving | Move Planner | Truck | L1
        /dashboard/projects | Home Projects | Hammer | L1
        /dashboard/utilities | Utilities | Gauge | L1
        /dashboard/binder | Household Binder | FolderLock | L1
        /dashboard/security | Security Alerts | ShieldAlert | L1
        /dashboard/devices | Smart Home | Plug | L1
        /dashboard/auto | Auto & Vehicles | Car | L1
        /dashboard/renewals | Renewals | ShieldCheck | L1
        /dashboard/trips | Trip Planner | Plane | L1
        /dashboard/vacations | Vacation Planner | Sun | L1
        /dashboard/weekend | Weekend Planner | CalendarRange | L1
        /dashboard/voting | Group Voting | ListChecks | L1
        /dashboard/life-events | Life & Milestones | Milestone | L0
        /dashboard/trip-memories | Trip Memories | BookHeart | L1
        /dashboard/sports | Sports | Trophy | L1
        /dashboard/rides | Rides & Carpool | Car | L1
        /marketplace | Marketplace | Store | L0
        /display | Kitchen Display | Monitor | L1
        /dashboard/health | Health | HeartPulse | L1
        /dashboard/sleep | Sleep Coach | MoonStar | L0
        /dashboard/scan | Scan Flyer | ScanLine | L1
        /dashboard/medical | Medical | Stethoscope | L1
        /dashboard/medications | Medications | Pill | L1
        /dashboard/care | Care Log | HeartHandshake | L1
        /dashboard/inbox | Communications Hub | Inbox | L1
        /dashboard/dental | Dental | Smile | L1
        /dashboard/family-access | Kid Logins | UserCog | L0 | manage
        /dashboard/settings | Settings | Settings | L0
      # Finances & Admin (grid)
        /dashboard/billing | Finances | CreditCard | L0
        /wallet | Family Wallet | Wallet | L0
        /economy | Family Economy | Coins | L0
        /dashboard/expenses | Expense Splitting | DollarSign | L1
        /dashboard/subscriptions | Subscriptions | RefreshCw | L1
        /dashboard/insurance | Insurance Hub | ShieldAlert | L1
        /dashboard/tax-vault | Tax Vault | FolderLock | L1
        /dashboard/career | Career Hub | Briefcase | L1
        /dashboard/sync | Calendar Sync | RefreshCw | L0
        /dashboard/settings#members | Family Members | UsersRound | L0
        /dashboard/migrate | Switch to Bubaly | Import | L0
        /referrals | Refer a Family | Gift | L0
      # Family AI OS (grid)
        /dashboard/family-operations | Operations | Command | L2
        /dashboard/conflicts | AI Conflict Resolution | CalendarClock | L2
        /dashboard/autonomous-family-management | Autonomous AI | Bot | L2
        /dashboard/voice | Voice Control | Mic | L0
        /dashboard/family-digital-twin | Digital Twin | Brain | L2
        /dashboard/family-cfo | Family CFO | Wallet | L2
        /dashboard/family-coo | Family COO | ClipboardList | L2
        /dashboard/family-health | Health Coordinator | HeartPulse | L2
        /dashboard/family-school | School Hub | GraduationCap | L2
        /dashboard/family-sports | Sports Hub | Trophy | L2
        /dashboard/knowledge | Knowledge Base | Brain | L0
        /dashboard/playbook | Family Playbook | WandSparkles | L0
        /dashboard/experience | Experience Scorecard | ClipboardCheck | L0
        /dashboard/family-emergency | Emergency Hub | ShieldAlert | L2
        /dashboard/family-stress | Stress Prediction | Gauge | L2
        /dashboard/family-automation | Life Automation | Zap | L2"
    `);
  });

  it('SIDEBAR_FOOTER_NAV, DASHBOARD_NAV and MOBILE_TABS', () => {
    expect([...tree(SIDEBAR_FOOTER_NAV), '--', ...tree(DASHBOARD_NAV), '--', ...tree(MOBILE_TABS)].join('\n')).toMatchInlineSnapshot(`
      "/dashboard/settings | Settings | Settings
      /dashboard/more | Help & Support | CircleHelp
      --
      /dashboard | Parent Dashboard | LayoutDashboard
      /dashboard?view=family | Family Dashboard | UsersRound
      --
      /home | Home | House | L0
      /dashboard/assistant | Assistant | Sparkles | L0
      /capture | Capture | Plus | L0
      /dashboard/inbox | Inbox | Inbox | L0
      /services | Services | LayoutGrid | L0"
    `);
  });

  it('DEFAULT_SIDEBAR_NAV_KEYS and NAV_CATALOG_KEYS', () => {
    expect(DEFAULT_SIDEBAR_NAV_KEYS.join('\n')).toMatchInlineSnapshot(`
      "/home
      /dashboard/calendar
      /dashboard/todos
      /dashboard/meals
      /dashboard/chores
      /dashboard/billing
      /dashboard/memories
      /dashboard/messages
      /dashboard/documents
      /wallet
      /dashboard/locator
      /dashboard/family"
    `);
    expect(NAV_CATALOG_KEYS.join('\n')).toMatchInlineSnapshot(`
      "/home
      /dashboard/calendar
      /dashboard/todos
      /dashboard/meals
      /dashboard/chores
      /dashboard/billing
      /dashboard/memories
      /dashboard/messages
      /dashboard/documents
      /wallet
      /dashboard/locator
      /dashboard/family
      /dashboard/moments
      /dashboard/next-best-actions
      /dashboard/family-operating-index
      /dashboard/outcomes
      /dashboard/agents
      /dashboard/graph
      /dashboard/decisions
      /dashboard/prep-plans
      /dashboard/intelligence
      /dashboard/family-signals
      /dashboard/reasoning
      /dashboard/calm
      /dashboard/connections
      /dashboard/trust
      /dashboard/announcements
      /dashboard/activity
      /dashboard/celebrations
      /dashboard/relationship
      /dashboard/readiness
      /dashboard/family-tree
      /dashboard/grandparent-portal
      /dashboard/pets
      /dashboard/closet
      /dashboard/watchlist
      /dashboard/social-feed
      /dashboard/grocery
      /dashboard/reminders
      /dashboard/weather
      /dashboard/recipes
      /dashboard/photos
      /dashboard/wishlists
      /dashboard/notes
      /dashboard/habits
      /dashboard/journal
      /dashboard/focus
      /dashboard/contacts
      /dashboard/language
      /dashboard/inventory
      /dashboard/declutter
      /dashboard/life-events
      /marketplace
      /dashboard/sleep
      /dashboard/family-access
      /economy
      /dashboard/sync
      /dashboard/settings#members
      /dashboard/migrate
      /referrals
      /dashboard/voice
      /dashboard/knowledge
      /dashboard/playbook
      /dashboard/experience"
    `);
  });
});
