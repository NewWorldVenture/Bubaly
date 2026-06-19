'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ChevronDown, Check, Gift, LogOut, Mic, Moon, Plus, Search, Send, Settings as SettingsIcon, Sparkles, SunMedium } from 'lucide-react';
import { Logo, LogoMark } from '@/components/brand/logo';
import { Avatar } from '@/components/ui/avatar';
import { APP_NAV, MOBILE_TABS } from '@/lib/constants/navigation';
import { ROLE_LABELS } from '@/lib/constants/roles';
import { cn } from '@/lib/utils/cn';
import { useApp } from './app-context';
import { NotificationBell } from './notification-bell';
import { setActiveFamilyAction } from '@/app/(app)/actions';

function isActive(pathname: string, href: string) {
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(href + '/');
}

function FamilySwitcher() {
  const { family, families, role } = useApp();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function switchTo(familyId: string) {
    setOpen(false);
    if (familyId === family.id) return;
    startTransition(async () => {
      await setActiveFamilyAction(familyId);
      window.location.assign('/dashboard');
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
          <p className="truncate text-xs text-muted">{ROLE_LABELS[role]}</p>
        </div>
        <ChevronDown className="h-4 w-4 text-muted" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-xl glass-card p-1 shadow-glass animate-fade-in">
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
  const { userEmail, selfMember } = useApp();
  const [open, setOpen] = useState(false);
  const name = selfMember?.display_name ?? userEmail ?? 'You';

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
          <div className="absolute right-0 top-full z-20 mt-2 w-56 rounded-xl glass-card p-1 shadow-glass animate-fade-in">
            <div className="px-3 py-2">
              <p className="truncate text-sm font-medium">{name}</p>
              <p className="truncate text-xs text-muted">{userEmail}</p>
            </div>
            <div className="my-1 h-px bg-border" />
            <Link href="/dashboard/settings" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-elevated">
              <SettingsIcon className="h-4 w-4" /> Settings
            </Link>
            <form action="/auth/signout" method="post">
              <button type="submit" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-elevated">
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-dvh bg-bg text-fg lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-sidebar shrink-0 flex-col border-r border-border/60 bg-surface/30 lg:flex">
        <div className="px-5 py-5 xl:px-7 xl:py-7">
          <Logo href="/dashboard" markVariant="home" />
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-4 xl:px-4">
          {APP_NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition xl:px-4 xl:py-3 xl:text-base',
                  active ? 'bg-brand/15 text-brand shadow-sm' : 'text-muted hover:bg-elevated hover:text-fg',
                )}
              >
                <item.icon className="h-5 w-5 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="space-y-4 px-3 pb-4 xl:px-4 xl:pb-5">
          <FamilySwitcher />
          <div className="rounded-2xl border border-brand/20 bg-brand/5 p-4 text-center xl:p-5">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-brand/15 xl:h-20 xl:w-20">
              <Sparkles className="h-8 w-8 text-brand xl:h-10 xl:w-10" />
            </div>
            <h2 className="mt-3 text-sm font-bold xl:mt-4 xl:text-base">Your AI Chief of Staff</h2>
            <p className="mt-2 text-xs leading-5 text-muted xl:mt-3 xl:text-sm xl:leading-6">
              I&apos;m here to help your family stay organized, save time, and reduce stress.
            </p>
            <Link href="/ai" className="mt-3 inline-flex w-full justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-bold text-brand-fg transition hover:opacity-90 xl:mt-5 xl:py-3">
              Learn More
            </Link>
          </div>
          <div className="grid grid-cols-2 rounded-xl border border-border bg-surface/40 p-1 text-sm">
            <button className="flex items-center justify-center gap-2 rounded-lg bg-brand/15 py-2.5 font-semibold text-brand">
              <Moon className="h-4 w-4" /> Dark
            </button>
            <button className="flex items-center justify-center gap-2 rounded-lg py-2.5 text-muted">
              <SunMedium className="h-4 w-4" /> Light
            </button>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border/60 bg-bg/85 px-3 backdrop-blur-xl sm:h-topbar sm:gap-5 sm:px-5 lg:px-7">
          <Link href="/dashboard" className="lg:hidden">
            <LogoMark className="h-8 w-8 sm:h-9 sm:w-9" variant="home" />
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

      {/* Mobile bottom tabs */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-bg/90 backdrop-blur-xl lg:hidden">
        <div className="mx-auto flex max-w-lg items-stretch justify-around">
          {MOBILE_TABS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex flex-1 flex-col items-center gap-0.5 pb-1 pt-2 text-[11px] font-medium transition',
                  active ? 'text-brand' : 'text-muted',
                )}
              >
                <item.icon className={cn('h-6 w-6', active && 'scale-110')} />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
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
