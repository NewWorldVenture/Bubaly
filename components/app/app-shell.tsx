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
  const { userEmail, selfMember, family } = useApp();
  const [open, setOpen] = useState(false);
  const name = selfMember?.display_name ?? userEmail ?? 'You';

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center rounded-full focus-ring"
        aria-label="Account menu"
      >
        <Avatar name={name} color={selfMember?.color} size={40} />
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
    <div className="min-h-dvh bg-[#040a12] text-white lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-[280px] shrink-0 flex-col border-r border-white/8 bg-[#050c15] lg:flex">
        <div className="px-7 py-7">
          <Logo href="/dashboard" markVariant="home" />
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-4 pb-4">
          {APP_NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-4 py-3 text-base font-medium transition',
                  active ? 'bg-gradient-to-r from-violet-700 to-violet-950 text-white shadow-glow' : 'text-white/82 hover:bg-white/[0.06] hover:text-white',
                )}
              >
                <item.icon className="h-5 w-5 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="space-y-5 px-4 pb-5">
          <FamilySwitcher />
          <div className="rounded-2xl border border-violet-400/25 bg-gradient-to-b from-violet-500/15 to-white/[0.035] p-5 text-center">
            <div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-violet-600/20">
              <Sparkles className="h-10 w-10 text-violet-300" />
            </div>
            <h2 className="mt-4 font-bold">Your AI Chief of Staff</h2>
            <p className="mt-3 text-sm leading-6 text-white/68">
              I&apos;m here to help your family stay organized, save time, and reduce stress.
            </p>
            <Link href="/ai" className="mt-5 inline-flex w-full justify-center rounded-lg bg-violet-700 px-4 py-3 text-sm font-bold">
              Learn More
            </Link>
          </div>
          <div className="grid grid-cols-2 rounded-xl border border-white/8 bg-white/[0.035] p-1 text-sm">
            <button className="flex items-center justify-center gap-2 rounded-lg bg-blue-900/70 py-3 font-semibold">
              <Moon className="h-4 w-4" /> Dark
            </button>
            <button className="flex items-center justify-center gap-2 rounded-lg py-3 text-white/70">
              <SunMedium className="h-4 w-4" /> Light
            </button>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex h-[88px] items-center gap-5 border-b border-white/8 bg-[#050b13]/85 px-4 backdrop-blur-xl sm:px-7">
          <Link href="/dashboard" className="lg:hidden">
            <LogoMark className="h-9 w-9" variant="home" />
          </Link>
          <div className="flex-1" />
          <label className="hidden h-12 w-full max-w-[360px] items-center gap-3 rounded-xl border border-white/10 bg-white/[0.045] px-4 text-white/55 md:flex">
            <input className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/55" placeholder="Ask anything..." />
            <Search className="h-5 w-5" />
          </label>
          <Link href="/dashboard/notifications" className="hidden h-10 w-10 items-center justify-center rounded-full text-white hover:bg-white/[0.06] md:inline-flex">
            <Gift className="h-5 w-5" />
          </Link>
          <NotificationBell />
          <UserMenu />
        </header>

        <main className="flex-1 px-4 pb-24 pt-6 sm:px-7 lg:pb-10">
          <div className="mx-auto max-w-[1480px]">{children}</div>
        </main>
      </div>

      {/* Mobile bottom tabs */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-bg/85 backdrop-blur-xl lg:hidden">
        <div className="mx-auto flex max-w-lg items-stretch justify-around">
          {MOBILE_TABS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium transition',
                  active ? 'text-brand' : 'text-muted',
                )}
              >
                <item.icon className="h-6 w-6" />
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
    <div className="flex min-h-24 items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.045] px-4">
      <Plus className="h-6 w-6 text-white/55" />
      <input
        className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-white/55"
        placeholder="Ask anything or give a command..."
      />
      <button className="grid h-12 w-12 place-items-center rounded-full bg-violet-700">
        <Mic className="h-6 w-6" />
      </button>
      <button className="grid h-12 w-12 place-items-center rounded-full bg-white/10">
        <Send className="h-6 w-6" />
      </button>
    </div>
  );
}
