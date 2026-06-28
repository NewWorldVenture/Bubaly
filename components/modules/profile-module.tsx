'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  User, Settings, Users, Bell, Moon, SunMedium, LogOut,
  ChevronRight, ShieldCheck, CreditCard, HeartPulse, Sparkles,
  HelpCircle, Star, LayoutGrid,
} from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import { useApp } from '@/components/app/app-context';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { useTheme } from '@/components/theme/use-theme';
import { ROLE_LABELS } from '@/lib/constants/roles';
import type { Tables } from '@/lib/database.types';

type Member = Tables<'family_members'>;

interface ProfileModuleProps {
  member: Member;
  userId: string;
  userEmail: string;
}

function Row({
  icon: Icon, label, href, onClick, badge, danger,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  href?: string;
  onClick?: () => void;
  badge?: string;
  danger?: boolean;
}) {
  const inner = (
    <div className={cn(
      'flex items-center gap-3 px-4 py-3.5 transition hover:bg-elevated',
      danger ? 'text-danger' : 'text-fg',
    )}>
      <Icon className="h-5 w-5 shrink-0 text-muted" />
      <span className="flex-1 text-sm font-medium">{label}</span>
      {badge && <span className="rounded-full bg-brand/20 px-2 py-0.5 text-xs font-semibold text-brand">{badge}</span>}
      <ChevronRight className="h-4 w-4 text-muted/60" />
    </div>
  );
  if (href) return <Link href={href}>{inner}</Link>;
  return <button type="button" onClick={onClick} className="w-full text-left">{inner}</button>;
}

function Section({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-2xl border border-border bg-surface/40 divide-y divide-border', className)}>
      {children}
    </div>
  );
}

export function ProfileModule({ member, userEmail }: ProfileModuleProps) {
  const { family, role, isSuperAdmin } = useApp();
  const { theme, setTheme } = useTheme();
  const [isDark, setIsDark] = useState(theme !== 'light');

  function toggleTheme() {
    const next = isDark ? 'light' : 'dark';
    setIsDark(!isDark);
    setTheme(next);
  }

  const name = member.display_name ?? userEmail.split('@')[0];

  return (
    <div className="mx-auto max-w-lg space-y-6 pb-32 pt-4">
      {/* Avatar + name */}
      <div className="flex flex-col items-center gap-3 pt-4">
        <Avatar name={name} color={member.color ?? undefined} size={80} className="rounded-full ring-4 ring-brand/20" />
        <div className="text-center">
          <h1 className="text-xl font-bold">{name}</h1>
          <p className="text-sm text-muted">{userEmail}</p>
          <p className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-brand/10 px-3 py-0.5 text-xs font-semibold text-brand">
            <Users className="h-3 w-3" />
            {family.name} · {ROLE_LABELS[role]}
          </p>
        </div>
      </div>

      {/* Account */}
      <div>
        <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted">Account</p>
        <Section>
          <Row icon={User} label="Edit Profile" href="/dashboard/settings#profile" />
          <Row icon={Bell} label="Notifications" href="/dashboard/settings#notifications" />
          <Row icon={CreditCard} label="Subscription & Billing" href="/dashboard/billing" />
          {isSuperAdmin && (
            <Row icon={ShieldCheck} label="Site Admin" href="/admin" badge="Admin" />
          )}
        </Section>
      </div>

      {/* Family */}
      <div>
        <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted">Family</p>
        <Section>
          <Row icon={Users} label="Family Members" href="/dashboard/settings#members" />
          <Row icon={HeartPulse} label="Health & Medical" href="/dashboard/health" />
        </Section>
      </div>

      {/* App */}
      <div>
        <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted">App</p>
        <Section>
          <Row icon={Sparkles} label="AI Engine" href="/admin/ai" />
          <Row icon={LayoutGrid} label="More" href="/dashboard/more" />
          <Row icon={Settings} label="All Settings" href="/dashboard/settings" />
          <div className="flex items-center gap-3 px-4 py-3.5">
            {isDark ? <Moon className="h-5 w-5 shrink-0 text-muted" /> : <SunMedium className="h-5 w-5 shrink-0 text-muted" />}
            <span className="flex-1 text-sm font-medium">{isDark ? 'Dark Mode' : 'Light Mode'}</span>
            <button
              type="button"
              onClick={toggleTheme}
              className={cn(
                'relative h-6 w-11 rounded-full transition-colors',
                isDark ? 'bg-brand' : 'bg-border',
              )}
            >
              <span className={cn(
                'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
                isDark ? 'translate-x-5' : 'translate-x-0.5',
              )} />
            </button>
          </div>
          <Row icon={HelpCircle} label="Help & Support" href="/dashboard/settings#support" />
          <Row icon={Star} label="Rate the App" onClick={() => window.open('https://apps.apple.com/', '_blank')} />
        </Section>
      </div>

      {/* Sign out */}
      <Section>
        <SignOutButton className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm font-medium text-danger transition hover:bg-elevated">
          <LogOut className="h-5 w-5 shrink-0 text-danger" />
          Sign out
        </SignOutButton>
      </Section>
    </div>
  );
}
