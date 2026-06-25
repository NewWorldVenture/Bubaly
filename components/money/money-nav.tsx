'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, CreditCard, Users, Activity, FileBarChart, Settings } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

const TABS = [
  { href: '/money',            label: 'Overview',     icon: LayoutDashboard, exact: true },
  { href: '/money/cards',      label: 'Cards',        icon: CreditCard },
  { href: '/money/babysitters',label: 'Babysitters',  icon: Users },
  { href: '/money/activity',   label: 'Activity',     icon: Activity },
  { href: '/money/reports',    label: 'Reports',      icon: FileBarChart },
  { href: '/money/settings',   label: 'Settings',     icon: Settings },
];

export function MoneyNav() {
  const pathname = usePathname();
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface/40 p-1 no-scrollbar">
      {TABS.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href}
            className={cn(
              'flex flex-shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition',
              active ? 'bg-brand text-white' : 'text-muted hover:bg-elevated hover:text-fg',
            )}>
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
