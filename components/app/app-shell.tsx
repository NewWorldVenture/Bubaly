'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { ChevronDown, Check, Gift, Home, Lock, LogOut, Menu, Mic, Plus, Search, Send, Settings as SettingsIcon, ShieldCheck, UserCog, X } from 'lucide-react';
import { Logo, LogoMark } from '@/components/brand/logo';
import { Avatar } from '@/components/ui/avatar';
import { APP_NAV_GROUPS, MOBILE_TABS, CAPTURE_TAB_INDEX, type NavItem } from '@/lib/constants/navigation';
import { ROLE_LABELS } from '@/lib/constants/roles';
import { tierLabelForLevel } from '@/lib/constants/plans';
import { DASHBOARD_VIEWS, dashboardLabel, dashboardIcon, isDashboardView, type DashboardView } from '@/lib/constants/dashboards';
import { cn } from '@/lib/utils/cn';
import { useApp } from './app-context';
import { ThemeSwitch } from './theme-switch';
import { SidebarAccount } from './sidebar-account';
import { isActive, resolveItems, NavEntry, AiAssistantNavButton } from './nav-shared';
import { FreeTierSidebar } from './free-tier-sidebar';
import { NotificationBell } from './notification-bell';
import { UpgradeModal } from './upgrade-modal';
import { QuickCapture } from './quick-capture';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { AIOrb } from './ai-orb';
import { setActiveFamilyAction } from '@/app/(app)/actions';

function FamilySwitcher() {
  const { family, families, role, planLevel } = useApp();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function switchTo(familyId: string) {
    setOpen(false);
    if (familyId === family.id) return;
    startTransition(async () => {
      await setActiveFamilyAction(familyId);
      window.location.assign('/home');
    });
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-elevated focus-ring"
        disabled={pending}
      >
        <Avatar name={family.name} size={32} className="rounded-lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{family.name}</p>
          <p className="truncate text-xs text-muted">{ROLE_LABELS[role]} / {tierLabelForLevel(planLevel)}</p>
        </div>
        <ChevronDown className="h-4 w-4 text-muted" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-xl popover-surface p-1 shadow-glass animate-fade-in">
            {families.map((f) => (
              <button
                key={f.familyId}
                onClick={() => switchTo(f.familyId)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-elevated"
              >
                <Avatar name={f.name} size={24} className="rounded-md" />
                <span className="flex-1 truncate">{f.name}</span>
                {f.familyId === family.id && <Check className="h-4 w-4 text-brand" />}
              </button>
            ))}
            <Link
              href="/dashboard/settings#families"
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-muted hover:bg-elevated"
            >
              <Plus className="h-4 w-4" /> New family
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function UserMenu() {
  const { userEmail, selfMember, isSuperAdmin, role, defaultDashboard, family, families } = useApp();
  const [open, setOpen] = useState(false);
  const [switching, startSwitch] = useTransition();
  const name = selfMember?.display_name ?? userEmail ?? 'You';

  function switchFamily(familyId: string) {
    setOpen(false);
    if (familyId === family.id) return;
    startSwitch(async () => {
      await setActiveFamilyAction(familyId);
      window.location.assign('/home');
    });
  }

  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Which dashboard the user is currently looking at (only meaningful on /dashboard).
  const onDashboard = pathname === '/dashboard';
  const viewParam = searchParams.get('view');
  const currentView: DashboardView = isDashboardView(viewParam) ? viewParam : defaultDashboard;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center rounded-full focus-ring"
        aria-label="Account menu"
      >
        <Avatar name={name} color={selfMember?.color} size={36} className="sm:h-10 sm:w-10" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-2 w-60 rounded-xl popover-surface p-1 shadow-glass animate-fade-in">
            <div className="px-3 py-2">
              <p className="truncate text-sm font-medium">{name}</p>
              <p className="truncate text-xs text-muted">{userEmail}</p>
            </div>
            <div className="my-1 h-px bg-border" />
            <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Dashboard</p>
            {/* Home is the default post-login landing. */}
            <Link
              href="/home"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-elevated"
            >
              <Home className="h-4 w-4 text-muted" />
              <span className="flex-1 truncate">Home</span>
              <span className="text-[10px] font-semibold uppercase text-muted">Default</span>
              {pathname === '/home' && <Check className="h-4 w-4 text-brand" />}
            </Link>
            {DASHBOARD_VIEWS.map((view) => {
              const Icon = dashboardIcon[view];
              const active = onDashboard && currentView === view;
              return (
                <Link
                  key={view}
                  href={view === defaultDashboard ? '/dashboard' : `/dashboard?view=${view}`}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-elevated"
                >
                  <Icon className="h-4 w-4 text-muted" />
                  <span className="flex-1 truncate">{dashboardLabel(view, role)}</span>
                  {active && <Check className="h-4 w-4 text-brand" />}
                </Link>
              );
            })}
            <div className="my-1 h-px bg-border" />
            {families.length > 1 && (
              <>
                <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Family</p>
                {families.map((f) => (
                  <button
                    key={f.familyId}
                    onClick={() => switchFamily(f.familyId)}
                    disabled={switching}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-elevated disabled:opacity-50"
                  >
                    <Avatar name={f.name} size={20} className="rounded-md" />
                    <span className="flex-1 truncate">{f.name}</span>
                    {f.familyId === family.id && <Check className="h-4 w-4 text-brand" />}
                  </button>
                ))}
                <Link href="/dashboard/settings#families" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted hover:bg-elevated">
                  <Plus className="h-4 w-4" /> New family
                </Link>
                <div className="my-1 h-px bg-border" />
              </>
            )}
            {isSuperAdmin && (
              <Link href="/admin" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-brand hover:bg-elevated">
                <ShieldCheck className="h-4 w-4" /> Site Admin
              </Link>
            )}
            <Link href="/dashboard/profile" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-elevated">
              <UserCog className="h-4 w-4" /> Profile
            </Link>
            <Link href="/dashboard/settings" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-elevated">
              <SettingsIcon className="h-4 w-4" /> Settings
            </Link>
            <div className="my-1 h-px bg-border" />
            <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Theme</p>
            <div className="px-2 pb-1">
              <ThemeSwitch />
            </div>
            <div className="my-1 h-px bg-border" />
            <SignOutButton className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-elevated">
              <LogOut className="h-4 w-4" /> Sign out
            </SignOutButton>
          </div>
        </>
      )}
    </div>
  );
}

/** The two dashboards (personal + family Command Center), rendered role-aware
 *  at the top of the sidebar with view-aware active highlighting. */
function SidebarDashboardLinks() {
  const { role, defaultDashboard } = useApp();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const onDashboard = pathname === '/dashboard';
  const viewParam = searchParams.get('view');
  const currentView: DashboardView = isDashboardView(viewParam) ? viewParam : defaultDashboard;

  return (
    <>
      {DASHBOARD_VIEWS.map((view) => {
        const Icon = dashboardIcon[view];
        const active = onDashboard && currentView === view;
        return (
          <Link
            key={view}
            href={view === defaultDashboard ? '/dashboard' : `/dashboard?view=${view}`}
            className={cn(
              'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition xl:px-4 xl:py-3 xl:text-base',
              active ? 'bg-brand/15 text-brand shadow-sm' : 'text-muted hover:bg-elevated hover:text-fg',
            )}
          >
            <Icon className="h-5 w-5 shrink-0" />
            {dashboardLabel(view, role)}
          </Link>
        );
      })}
    </>
  );
}

/** Grouped, plan-gated sidebar navigation. */
function SidebarNav({ onLocked }: { onLocked: (item: NavItem) => void }) {
  const { planLevel, isSuperAdmin, featureTiers } = useApp();
  return (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4 xl:px-4">
      {/* AI Assistant — pinned at the very top */}
      <AiAssistantNavButton />
      {APP_NAV_GROUPS.map((group) => {
        const resolved = resolveItems(group.items, featureTiers, planLevel, isSuperAdmin);
        const isSuggested = group.title === 'Suggested';
        // Drop a group whose every feature is Off (the Suggested group always
        // keeps the two dashboard links, so it never disappears).
        if (resolved.length === 0 && !isSuggested) return null;
        return (
          <div key={group.title} className="space-y-1">
            <p className="px-2 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted/70">
              {group.title}
            </p>
            {isSuggested && <SidebarDashboardLinks />}
            {group.layout === 'grid' ? (
              <div className="grid grid-cols-2 gap-1">
                {resolved.map(({ item, locked }) => (
                  <NavEntry key={item.href} item={item} variant="grid" locked={locked} onLocked={onLocked} />
                ))}
              </div>
            ) : (
              <div className="space-y-0.5">
                {resolved.map(({ item, locked }) => (
                  <NavEntry key={item.href} item={item} variant="list" locked={locked} onLocked={onLocked} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

/** The sidebar navigation body, shared by the desktop rail and the mobile drawer.
 *  Free-tier members (but NOT super admins, who always get the full catalog) get
 *  the curated sidebar; everyone else gets the full grouped nav + AI-coach footer. */
function SidebarBody({ onLocked }: { onLocked: (item: NavItem) => void }) {
  const { planLevel, isSuperAdmin } = useApp();
  if (planLevel === 0 && !isSuperAdmin) {
    // Free tier → curated sidebar (primary list + shortcuts + All Services + footer).
    return <FreeTierSidebar onLocked={onLocked} />;
  }
  // Paid tiers + super admins → full grouped navigation + account/theme footer.
  return (
    <>
      <SidebarNav onLocked={onLocked} />
      <div className="space-y-3 px-3 pb-4 xl:px-4 xl:pb-5">
        <FamilySwitcher />
        <SidebarAccount />
      </div>
    </>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { planLevel, isSuperAdmin, featureTiers } = useApp();
  const [upgradeFor, setUpgradeFor] = useState<NavItem | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileTabs = resolveItems(MOBILE_TABS, featureTiers, planLevel, isSuperAdmin);
  const upgradeLevel: 1 | 2 = upgradeFor
    ? (featureTiers[upgradeFor.href] === 'plus' ? 2 : 1)
    : 1;

  // Close the mobile nav drawer whenever the route changes.
  useEffect(() => { setMobileNavOpen(false); }, [pathname]);

  return (
    <div className="min-h-dvh bg-bg text-fg lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-sidebar shrink-0 flex-col border-r border-border/60 bg-surface/30 lg:flex">
        <div className="px-5 py-5 xl:px-7 xl:py-7">
          <Logo href="/home" markVariant="home" />
        </div>
        <SidebarBody onLocked={setUpgradeFor} />
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border/60 bg-bg/85 px-3 backdrop-blur-xl sm:h-topbar sm:gap-5 sm:px-5 lg:px-7">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open menu"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-fg transition hover:bg-elevated lg:hidden"
          >
            <Menu className="h-6 w-6" />
          </button>
          <Link href="/home" className="lg:hidden">
            <LogoMark className="h-8 w-14 sm:h-9 sm:w-16" variant="home" />
          </Link>
          <div className="flex-1" />
          <label className="hidden h-10 w-full max-w-[320px] items-center gap-2 rounded-xl border border-border bg-surface/40 px-3 text-muted md:flex lg:max-w-[360px] xl:h-12 xl:gap-3 xl:px-4">
            <Search className="h-4 w-4 shrink-0" />
            <input className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted" placeholder="Ask anything..." />
          </label>
          <Link href="/dashboard/notifications" className="hidden h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-elevated hover:text-fg md:inline-flex">
            <Gift className="h-5 w-5" />
          </Link>
          <NotificationBell />
          <UserMenu />
        </header>

        <main className="flex-1 px-3 pb-24 pt-4 sm:px-5 sm:pt-6 lg:px-7 lg:pb-8">
          <div className="mx-auto max-w-[1480px]">{children}</div>
        </main>
      </div>

      <QuickCapture />
      <AIOrb />

      {/* Mobile nav drawer — the full sidebar (curated nav + Shortcuts + All
          Services, or the full catalog for paid/super-admin) on a slide-over, so
          mobile reaches everything beyond the 5 bottom tabs. Mobile-first parity
          with desktop. Closes on navigation (route-change effect above). */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => setMobileNavOpen(false)} aria-hidden />
          <div className="absolute inset-y-0 left-0 flex w-[300px] max-w-[86%] flex-col border-r border-border/60 bg-surface animate-slide-in-left">
            <div className="flex items-center justify-between px-4 py-4">
              <Logo href="/home" markVariant="home" />
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close menu"
                className="grid h-9 w-9 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-fg"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <SidebarBody onLocked={(item) => { setMobileNavOpen(false); setUpgradeFor(item); }} />
          </div>
        </div>
      )}

      {/* Mobile bottom tabs — 5-tab AI-first nav */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-bg/90 backdrop-blur-xl lg:hidden">
        <div className="mx-auto flex max-w-lg items-end justify-around px-1">
          {mobileTabs.map(({ item, locked }, idx) => {
            const isCapture = idx === CAPTURE_TAB_INDEX;
            const active = !locked && isActive(pathname, item.href);

            if (isCapture) {
              // Raised center FAB-style Capture button
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-label="Capture"
                  className="relative -mt-5 flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-full bg-brand shadow-lg shadow-brand/30 text-white transition hover:scale-105 active:scale-95"
                >
                  <item.icon className="h-6 w-6" />
                </Link>
              );
            }

            const tabClass = cn(
              'relative flex flex-1 flex-col items-center gap-0.5 pb-1 pt-2 text-[11px] font-medium transition',
              locked ? 'text-muted/45' : active ? 'text-brand' : 'text-muted',
            );
            const inner = (
              <>
                <item.icon className={cn('h-6 w-6', active && 'scale-110')} />
                {item.label}
                {locked && <Lock className="absolute right-1/2 top-1.5 h-3 w-3 translate-x-3" />}
              </>
            );
            return locked ? (
              <button key={item.href} type="button" onClick={() => setUpgradeFor(item)} className={tabClass}>
                {inner}
              </button>
            ) : (
              <Link key={item.href} href={item.href} className={tabClass}>
                {inner}
              </Link>
            );
          })}
        </div>
      </nav>

      <UpgradeModal
        open={upgradeFor !== null}
        onClose={() => setUpgradeFor(null)}
        featureLabel={upgradeFor?.label}
        requiredLevel={upgradeLevel}
      />
    </div>
  );
}

export function AssistantInputBar() {
  return (
    <div className="flex min-h-20 items-center gap-2 rounded-2xl border border-border bg-surface/40 px-3 sm:min-h-24 sm:gap-3 sm:px-4">
      <Plus className="h-5 w-5 text-muted sm:h-6 sm:w-6" />
      <input
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted sm:text-base"
        placeholder="Ask anything or give a command..."
      />
      <button className="grid h-10 w-10 place-items-center rounded-full bg-brand sm:h-12 sm:w-12">
        <Mic className="h-5 w-5 text-brand-fg sm:h-6 sm:w-6" />
      </button>
      <button className="grid h-10 w-10 place-items-center rounded-full bg-elevated sm:h-12 sm:w-12">
        <Send className="h-5 w-5 sm:h-6 sm:w-6" />
      </button>
    </div>
  );
}
