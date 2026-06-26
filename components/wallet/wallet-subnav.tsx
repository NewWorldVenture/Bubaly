'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Wallet, Target, CalendarClock, Gift, Receipt, Baby, CreditCard, SlidersHorizontal, Building2, Send } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

const TABS = [
  { href: '/wallet', label: 'Overview', icon: Wallet },
  { href: '/wallet/treasury', label: 'Treasury', icon: Building2 },
  { href: '/wallet/send', label: 'Send', icon: Send },
  { href: '/wallet/goals', label: 'Goals', icon: Target },
  { href: '/wallet/allowance', label: 'Allowance', icon: CalendarClock },
  { href: '/wallet/gift', label: 'Gifts', icon: Gift },
  { href: '/wallet/babysitters', label: 'Babysitters', icon: Baby },
  { href: '/wallet/activity', label: 'Activity', icon: Receipt },
  { href: '/wallet/cards', label: 'Cards', icon: CreditCard },
  { href: '/wallet/settings', label: 'Settings', icon: SlidersHorizontal },
];

export function WalletSubnav() {
  const pathname = usePathname();
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface/40 p-1 no-scrollbar">
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link key={t.href} href={t.href}
            className={cn('flex flex-shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition',
              active ? 'bg-brand text-white' : 'text-muted hover:bg-elevated hover:text-fg')}>
            <t.icon className="h-3.5 w-3.5" /> {t.label}
          </Link>
        );
      })}
    </div>
  );
}
