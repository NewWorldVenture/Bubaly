'use client';

// Shared sidebar nav primitives used by both the full grouped sidebar (AppShell)
// and the curated Free-tier sidebar — kept here to avoid duplication and any
// circular import between those two components.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Lock, ChevronRight } from 'lucide-react';
import type { NavItem } from '@/lib/constants/navigation';
import { featureAccessByTier } from '@/lib/features/tiers';
import type { FeatureTier } from '@/lib/constants/feature-catalog';
import { cn } from '@/lib/utils/cn';

export function isActive(pathname: string, href: string): boolean {
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(href + '/');
}

/** Visible nav items for a group given the family's plan + admin tier settings.
 *  Items whose feature is Off are dropped; the rest carry a `locked` flag (tier
 *  above the family's plan) + the level required to unlock. */
export function resolveItems(
  items: readonly NavItem[],
  featureTiers: Record<string, FeatureTier>,
  planLevel: number,
  isSuperAdmin: boolean,
): { item: NavItem; locked: boolean; requiredLevel: 1 | 2 }[] {
  const out: { item: NavItem; locked: boolean; requiredLevel: 1 | 2 }[] = [];
  for (const item of items) {
    const tier = featureTiers[item.href];
    const access = featureAccessByTier(tier, planLevel, isSuperAdmin);
    if (access === 'hidden') continue; // Off → not shown at all
    out.push({ item, locked: access === 'locked', requiredLevel: (tier === 'plus' ? 2 : 1) });
  }
  return out;
}

/**
 * An expandable parent nav item with a sub-list of `children`. The row navigates
 * to the parent href; a caret toggles the children. It auto-expands when the
 * current route matches the parent or any child, so deep links reveal the group.
 */
export function ExpandableNavEntry({ item, onLocked }: { item: NavItem; onLocked: (item: NavItem) => void }) {
  const pathname = usePathname();
  const children = item.children ?? [];
  const childActive = children.some((c) => isActive(pathname, c.href));
  const selfActive = isActive(pathname, item.href);
  const [open, setOpen] = useState(selfActive || childActive);

  // Reveal the group whenever navigation lands inside it.
  useEffect(() => { if (selfActive || childActive) setOpen(true); }, [selfActive, childActive]);

  const base = 'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition xl:px-4 xl:py-3 xl:text-base';
  // Parent highlights only when its own page is open (not a child's), matching
  // the sub-page's own active state below.
  const parentActive = selfActive && !childActive;

  return (
    <div>
      <div className={cn(base, 'gap-2', parentActive ? 'bg-brand/15 text-brand shadow-sm' : 'text-muted hover:bg-elevated hover:text-fg')}>
        <Link href={item.href} className="flex min-w-0 flex-1 items-center gap-3">
          <item.icon className="h-5 w-5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
        </Link>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? `Collapse ${item.label}` : `Expand ${item.label}`}
          aria-expanded={open}
          className="rounded-md p-0.5 text-muted transition hover:text-fg focus-ring"
        >
          <ChevronRight className={cn('h-4 w-4 transition-transform', open && 'rotate-90')} />
        </button>
      </div>
      {open && (
        <div className="mt-0.5 space-y-0.5 border-l border-border/60 pl-3 xl:pl-4">
          {children.map((child) => (
            <NavEntry key={child.href} item={child} variant="list" locked={false} onLocked={onLocked} nested />
          ))}
        </div>
      )}
    </div>
  );
}

/** A single sidebar destination. Free items navigate; items above the family's
 *  plan render greyed-out with a lock and open the upgrade prompt on click.
 *  `badge` shows a small unread count (e.g. Messages); `nested` renders the
 *  compact sub-item style used inside an ExpandableNavEntry. */
export function NavEntry({ item, variant, locked, onLocked, badge, nested }: {
  item: NavItem; variant: 'list' | 'grid'; locked: boolean; onLocked: (item: NavItem) => void; badge?: number; nested?: boolean;
}) {
  const pathname = usePathname();
  const active = !locked && isActive(pathname, item.href);

  // A parent with children renders as an expandable group instead of a link.
  if (!nested && item.children && item.children.length > 0 && !locked) {
    return <ExpandableNavEntry item={item} onLocked={onLocked} />;
  }

  const base = variant === 'grid'
    ? 'flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition'
    : nested
      ? 'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition'
      : 'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition xl:px-4 xl:py-3 xl:text-base';

  const Badge = badge && badge > 0
    ? <span className="ml-auto grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-danger px-1.5 text-[11px] font-bold text-white">{badge > 99 ? '99+' : badge}</span>
    : null;

  if (locked) {
    return (
      <button
        type="button"
        onClick={() => onLocked(item)}
        title={`${item.label} — upgrade to unlock`}
        className={cn(base, 'text-muted/45 hover:bg-elevated/60 hover:text-muted')}
      >
        <item.icon className="h-5 w-5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
        <Lock className="h-3.5 w-3.5 shrink-0 opacity-70" />
      </button>
    );
  }

  return (
    <Link
      href={item.href}
      className={cn(base, active ? 'bg-brand/15 text-brand shadow-sm' : 'text-muted hover:bg-elevated hover:text-fg')}
    >
      <item.icon className="h-5 w-5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {Badge}
    </Link>
  );
}
