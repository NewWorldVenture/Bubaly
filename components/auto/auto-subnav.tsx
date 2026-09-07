'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

const ITEMS = [
  { href: '/dashboard/auto', label: 'Overview' },
  { href: '/dashboard/auto/vehicles', label: 'Vehicles' },
  { href: '/dashboard/auto/licenses', label: 'Licenses' },
  { href: '/dashboard/auto/registration', label: 'Registration & Inspection' },
  { href: '/dashboard/auto/insurance', label: 'Insurance' },
  { href: '/dashboard/auto/rentals', label: 'Rentals' },
  { href: '/dashboard/auto/service', label: 'Service' },
  { href: '/dashboard/auto/accident', label: 'Accident Help' },
];

export function AutoSubnav() {
  const t = useTranslations();
  const pathname = usePathname();
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1" aria-label={t('autoSubnav.autoSections')}>
      {ITEMS.map((item) => {
        const active = item.href === '/dashboard/auto' ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition focus-ring',
              active ? 'bg-brand text-brand-fg' : 'text-muted hover:bg-elevated hover:text-fg',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
