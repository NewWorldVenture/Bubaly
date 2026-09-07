'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

const ITEMS = [
  { href: '/dashboard/home', label: 'Overview' },
  { href: '/dashboard/home/warranties', label: 'Warranties' },
  { href: '/dashboard/home/maintenance', label: 'Maintenance & AI' },
  { href: '/dashboard/home/diagnose', label: 'Repair Help' },
  { href: '/dashboard/home/pros', label: 'Find a Pro' },
  { href: '/dashboard/home/service', label: 'Service Log' },
];

export function HomeSubnav() {
  const t = useTranslations();
  const pathname = usePathname();
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1" aria-label={t('homeSubnav.homeSections')}>
      {ITEMS.map((item) => {
        const active = item.href === '/dashboard/home' ? pathname === item.href : pathname.startsWith(item.href);
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
