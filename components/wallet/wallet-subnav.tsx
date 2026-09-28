'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Wallet, Target, CalendarClock, Gift, Receipt, Baby, CreditCard, TrendingUp, SlidersHorizontal, Building2, Send } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

// Each tab names its catalogue key; the labels were English in every language.
const TABS = [
  { href: '/wallet', labelKey: 'walletSubnav.overview', icon: Wallet },
  { href: '/wallet/treasury', labelKey: 'walletSubnav.treasury', icon: Building2 },
  { href: '/wallet/send', labelKey: 'walletSubnav.send', icon: Send },
  { href: '/wallet/goals', labelKey: 'walletSubnav.goals', icon: Target },
  { href: '/wallet/allowance', labelKey: 'walletSubnav.allowance', icon: CalendarClock },
  { href: '/wallet/gift', labelKey: 'walletSubnav.gifts', icon: Gift },
  { href: '/wallet/babysitters', labelKey: 'walletSubnav.babysitters', icon: Baby },
  { href: '/wallet/activity', labelKey: 'walletSubnav.activity', icon: Receipt },
  { href: '/wallet/cards', labelKey: 'walletSubnav.cards', icon: CreditCard },
  { href: '/wallet/invest', labelKey: 'walletSubnav.invest', icon: TrendingUp },
  { href: '/wallet/settings', labelKey: 'walletSubnav.settings', icon: SlidersHorizontal },
];

export function WalletSubnav() {
  const pathname = usePathname();
  const t = useTranslations();
  return (
    <nav aria-label={t('walletSubnav.label')} className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface/40 p-1 no-scrollbar">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link key={tab.href} href={tab.href} aria-current={active ? 'page' : undefined}
            className={cn('flex flex-shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition',
              active ? 'bg-brand text-white' : 'text-muted hover:bg-elevated hover:text-fg')}>
            <tab.icon className="h-3.5 w-3.5" /> {t(tab.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}
