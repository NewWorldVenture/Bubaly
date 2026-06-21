'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Bell, ChevronDown, Home, LayoutDashboard, LogOut, Search, ShieldCheck } from 'lucide-react';
import { Logo, LogoMark } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Avatar } from '@/components/ui/avatar';
import { ADMIN_NAV } from '@/lib/constants/navigation';
import { cn } from '@/lib/utils/cn';

function isActive(pathname: string, href: string) {
  if (href === '/admin') return pathname === '/admin';
  return pathname === href || pathname.startsWith(href + '/');
}

function AdminProfile({ name, email }: { name: string; email: string | null }) {
  return (
    <div className="sidebar-card">
      <div className="flex items-center gap-3">
        <Avatar name={name} size={36} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{name}</p>
          <p className="truncate text-xs text-brand">Super Administrator</p>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">{email}</p>
      <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
        Full Access
      </span>
      <Link href="/dashboard/settings" className="mt-3 block w-full rounded-lg border border-border py-2 text-center text-xs font-medium hover:bg-elevated">
        View Profile
      </Link>
    </div>
  );
}

export function AdminShell({
  children,
  adminName,
  adminEmail,
  pendingInviteCount,
}: {
  children: React.ReactNode;
  adminName: string;
  adminEmail: string | null;
  pendingInviteCount: number;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-dvh lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-sidebar shrink-0 flex-col border-r border-border/60 bg-surface/30 lg:flex">
        <div className="px-5 py-5">
          <Logo href="/admin" />
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-4">
          {ADMIN_NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition',
                  active ? 'bg-brand/15 text-brand shadow-sm' : 'text-muted hover:bg-elevated hover:text-fg',
                )}
              >
                <item.icon className="h-5 w-5 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="space-y-3 px-3 pb-4">
          <div className="space-y-1.5">
            <Link href="/dashboard/briefing" className="flex items-center gap-1.5 px-1 text-xs text-muted hover:text-fg">
              <LayoutDashboard className="h-3.5 w-3.5" /> Go to Parent Dashboard
            </Link>
            <Link href="/dashboard" className="flex items-center gap-1.5 px-1 text-xs text-muted hover:text-fg">
              <Home className="h-3.5 w-3.5" /> Go to Family Dashboard
            </Link>
          </div>
          <AdminProfile name={adminName} email={adminEmail} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex h-topbar items-center gap-3 border-b border-border/60 bg-bg/85 px-4 backdrop-blur-xl sm:gap-4 sm:px-6">
          <Link href="/admin" className="lg:hidden">
            <LogoMark className="h-9 w-16" />
          </Link>
          <span className="hidden items-center gap-1 rounded-full border border-brand/25 bg-brand/10 px-2.5 py-0.5 text-xs font-medium text-brand sm:inline-flex">
            <ShieldCheck className="h-3.5 w-3.5" /> Super Admin
          </span>
          <form action="/admin/users" method="GET" className="hidden flex-1 max-w-md md:flex">
            <label className="flex h-10 w-full items-center gap-2 rounded-xl border border-border bg-surface/40 px-3 text-muted">
              <Search className="h-4 w-4 shrink-0" />
              <input
                name="q"
                placeholder="Search users, families, settings..."
                className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted"
              />
            </label>
          </form>
          <div className="flex-1 md:hidden" />
          <ThemeToggle />
          <Link
            href="/admin/users?tab=invitations"
            className="relative inline-flex h-10 w-10 items-center justify-center rounded-full glass hover:bg-elevated focus-ring"
            aria-label={`${pendingInviteCount} pending invites`}
          >
            <Bell className="h-5 w-5" />
            {pendingInviteCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
                {pendingInviteCount > 9 ? '9+' : pendingInviteCount}
              </span>
            )}
          </Link>
          <div className="relative">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-2 rounded-full pl-1 pr-2 hover:bg-elevated focus-ring"
            >
              <Avatar name={adminName} size={32} />
              <span className="hidden text-sm font-medium sm:inline">{adminName.split(' ')[0]}</span>
              <ChevronDown className="h-4 w-4 text-muted" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-full z-20 mt-2 w-56 rounded-xl popover-surface p-1 shadow-glass animate-fade-in">
                  <Link href="/dashboard/briefing" onClick={() => setMenuOpen(false)} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-elevated">
                    <LayoutDashboard className="h-4 w-4" /> Go to Parent Dashboard
                  </Link>
                  <Link href="/dashboard" onClick={() => setMenuOpen(false)} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-elevated">
                    <Home className="h-4 w-4" /> Go to Family Dashboard
                  </Link>
                  <div className="my-1 h-px bg-border" />
                  <form action="/auth/signout" method="post">
                    <button type="submit" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-elevated">
                      <LogOut className="h-4 w-4" /> Sign out
                    </button>
                  </form>
                </div>
              </>
            )}
          </div>
        </header>

        {/* Mobile nav: horizontal tab bar (sidebar is desktop-only) */}
        <div className="border-b border-border/60 px-4 py-2 lg:hidden">
          <div className="tab-bar">
            {ADMIN_NAV.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link key={item.href} href={item.href} className={cn('tab-item', active ? 'tab-item-active' : 'tab-item-inactive')}>
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
