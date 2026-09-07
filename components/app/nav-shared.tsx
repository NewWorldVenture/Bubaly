'use client';

// Shared sidebar nav primitives used by both the full grouped sidebar (AppShell)
// and the curated Free-tier sidebar — kept here to avoid duplication and any
// circular import between those two components.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Lock, Sparkles, ChevronDown } from 'lucide-react';
import { type NavItem, isNavItemVisibleToRole } from '@/lib/constants/navigation';
import { featureAccessByTier } from '@/lib/features/tiers';
import type { FeatureTier } from '@/lib/constants/feature-catalog';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

export function isActive(pathname: string, href: string): boolean {
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(href + '/');
}

/**
 * Pinned "AI Assistant" entry at the very top of the sidebar (both tiers). A
 * distinct gradient pill linking straight to the full assistant, so the AI
 * layer is always one tap away regardless of plan.
 */
export function AiAssistantNavButton({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations();
  const pathname = usePathname() ?? '';
  const active = isActive(pathname, '/dashboard/assistant');
  return (
    <Link
      href="/dashboard/assistant"
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm font-semibold transition xl:px-4 xl:py-3 xl:text-base',
        active
          ? 'border-brand/40 bg-brand/15 text-brand-text'
          : 'border-border/70 bg-gradient-to-r from-brand/10 to-transparent text-fg hover:border-brand/40 hover:from-brand/20',
      )}
    >
      <Sparkles className={cn('h-5 w-5 shrink-0', active ? 'text-brand-text' : 'text-brand-text/90')} />
      {t('navShared.aiAssistant')}
    </Link>
  );
}

/** Visible nav items for a group given the family's plan + admin tier settings.
 *  Items whose feature is Off are dropped; the rest carry a `locked` flag (tier
 *  above the family's plan) + the level required to unlock. `isManager` gates
 *  manager-only (`manage`) destinations out for kids/teens/guests. */
export function resolveItems(
  items: readonly NavItem[],
  featureTiers: Record<string, FeatureTier>,
  planLevel: number,
  isSuperAdmin: boolean,
  isManager = true,
): { item: NavItem; locked: boolean; requiredLevel: 1 | 2 }[] {
  const out: { item: NavItem; locked: boolean; requiredLevel: 1 | 2 }[] = [];
  for (const item of items) {
    if (!isNavItemVisibleToRole(item, { isManager, isSuperAdmin })) continue; // manager-only
    const tier = featureTiers[item.href];
    const access = featureAccessByTier(tier, planLevel, isSuperAdmin);
    if (access === 'hidden') continue; // Off → not shown at all
    out.push({ item, locked: access === 'locked', requiredLevel: (tier === 'plus' ? 2 : 1) });
  }
  return out;
}

/** A single sidebar destination. Free items navigate; items above the family's
 *  plan render greyed-out with a lock and open the upgrade prompt on click.
 *  `badge` shows a small unread count (e.g. Messages). */
export function NavEntry({ item, variant, locked, onLocked, badge }: {
  item: NavItem; variant: 'list' | 'grid'; locked: boolean; onLocked: (item: NavItem) => void; badge?: number;
}) {
  const pathname = usePathname();
  const active = !locked && isActive(pathname, item.href);

  // Expandable group (list variant only): navigates to its own page AND
  // exposes a chevron to reveal its sub-destinations.
  if (item.children && item.children.length > 0 && variant === 'list' && !locked) {
    return <ExpandableNavEntry item={item} />;
  }

  const base = variant === 'grid'
    ? 'flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition'
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
      className={cn(base, active ? 'bg-brand/15 text-brand-text shadow-sm' : 'text-muted hover:bg-elevated hover:text-fg')}
    >
      <item.icon className="h-5 w-5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {Badge}
    </Link>
  );
}

/** An expandable parent: the row navigates to its own page; the chevron toggles
 *  a nested list of sub-destinations. Auto-expands when you're on the parent or
 *  any child route. */
function ExpandableNavEntry({ item }: { item: NavItem }) {
  const pathname = usePathname() ?? '';
  const parentActive = isActive(pathname, item.href);
  const childActive = (item.children ?? []).some((c) => isActive(pathname, c.href));
  const isUnder = parentActive || childActive;
  const [open, setOpen] = useState(isUnder);

  // Open automatically when navigating into this section.
  useEffect(() => { if (isUnder) setOpen(true); }, [isUnder]);

  const row = 'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition xl:px-4 xl:py-3 xl:text-base';

  return (
    <div>
      <div className={cn(row, 'pr-1', parentActive ? 'bg-brand/15 text-brand-text shadow-sm' : 'text-muted hover:bg-elevated hover:text-fg')}>
        <Link href={item.href} className="flex min-w-0 flex-1 items-center gap-3">
          <item.icon className="h-5 w-5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
        </Link>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? `Collapse ${item.label}` : `Expand ${item.label}`}
          aria-expanded={open}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-current/70 transition hover:bg-black/10 dark:hover:bg-white/10"
        >
          <ChevronDown className={cn('h-4 w-4 transition-transform', open ? 'rotate-180' : '')} />
        </button>
      </div>

      {open && (
        <div className="mb-1 ml-4 mt-0.5 space-y-0.5 border-l border-border/60 pl-2">
          {(item.children ?? []).map((child) => {
            const active = isActive(pathname, child.href);
            return (
              <Link
                key={child.href}
                href={child.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition xl:px-4',
                  active ? 'bg-brand/15 text-brand-text shadow-sm' : 'text-muted hover:bg-elevated hover:text-fg',
                )}
              >
                <child.icon className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{child.label}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
