'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

export type SubnavItem = { href: string; label: string };

/** Horizontal, scrollable section nav shared by every /dashboard/social page. */
export function SocialSubnav({ items }: { items: SubnavItem[] }) {
  const t = useTranslations();
  const pathname = usePathname();
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1" aria-label={t('subnav.socialSections')}>
      {items.map((item) => {
        const active =
          item.href === pathname ||
          (item.href !== '/dashboard/social' && pathname.startsWith(item.href));
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
