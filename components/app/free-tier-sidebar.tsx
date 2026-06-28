'use client';

// The curated Free-tier desktop sidebar: a calm primary list, the user's pinned
// shortcuts, an "All Services" launcher to the full catalog, and a Settings /
// Help footer. The full ~70-module catalog lives behind All Services (plan-gated
// with upgrade prompts) so nothing is lost — it's just no longer overwhelming.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import {
  PRIMARY_NAV, SIDEBAR_FOOTER_NAV, ALL_SERVICES_ICON, APP_NAV_GROUPS, type NavItem,
} from '@/lib/constants/navigation';
import { FEATURE_BY_KEY } from '@/lib/dashboard/registry';
import { FeatureIcon } from '@/components/dashboard/feature-icons';
import { Modal } from '@/components/ui/modal';
import { cn } from '@/lib/utils/cn';
import { useApp } from './app-context';
import { resolveItems, NavEntry, isActive } from './nav-shared';
import { usePathname } from 'next/navigation';

/** The user's pinned Quick-Access shortcuts (from their saved dashboard layout). */
function SidebarShortcuts() {
  const { familyId, userId } = useApp();
  const pathname = usePathname();
  const [keys, setKeys] = useState<string[] | null>(null);

  useEffect(() => {
    let active = true;
    createClient()
      .from('dashboard_layouts')
      .select('feature_keys, scope, user_id')
      .eq('family_id', familyId).is('deleted_at', null).in('scope', ['user', 'family'])
      .then(({ data }) => {
        if (!active) return;
        const mine = data?.find((l) => l.scope === 'user' && l.user_id === userId);
        const fam = data?.find((l) => l.scope === 'family');
        setKeys(((mine?.feature_keys ?? fam?.feature_keys ?? []) as string[]).slice(0, 6));
      });
    return () => { active = false; };
  }, [familyId, userId]);

  if (keys === null) return null; // loading — render nothing to avoid layout flash
  if (keys.length === 0) {
    return <p className="px-2 py-1 text-xs leading-5 text-muted/60">Pin favorites from All Services.</p>;
  }
  return (
    <>
      {keys.map((k) => {
        const f = FEATURE_BY_KEY[k];
        if (!f) return null;
        const active = isActive(pathname, f.route);
        return (
          <Link key={k} href={f.route}
            className={cn(
              'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition xl:px-4',
              active ? 'bg-brand/15 text-brand shadow-sm' : 'text-muted hover:bg-elevated hover:text-fg',
            )}>
            <FeatureIcon icon={f.icon} className="h-5 w-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{f.label}</span>
          </Link>
        );
      })}
    </>
  );
}

/** Full catalog of every module, grouped + plan-gated, shown in a modal. */
function AllServicesModal({ open, onClose, onLocked }: {
  open: boolean; onClose: () => void; onLocked: (item: NavItem) => void;
}) {
  const { planLevel, isSuperAdmin, featureTiers } = useApp();
  if (!open) return null;
  return (
    <Modal open onClose={onClose} title="All Services">
      <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
        {APP_NAV_GROUPS.map((group) => {
          const resolved = resolveItems(group.items, featureTiers, planLevel, isSuperAdmin);
          if (resolved.length === 0) return null;
          return (
            <div key={group.title} className="space-y-1">
              <p className="px-1 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted/70">{group.title}</p>
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                {resolved.map(({ item, locked }) => (
                  <div key={item.href} onClick={() => { if (!locked) onClose(); }}>
                    <NavEntry item={item} variant="grid" locked={locked} onLocked={onLocked} />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

export function FreeTierSidebar({ onLocked }: { onLocked: (item: NavItem) => void }) {
  const { unreadMessages } = useApp();
  const [allOpen, setAllOpen] = useState(false);

  return (
    <>
      <nav className="flex flex-1 flex-col overflow-y-auto px-3 pb-4 xl:px-4">
        {/* Primary destinations */}
        <div className="space-y-0.5">
          {PRIMARY_NAV.map((item) => (
            <NavEntry
              key={item.href}
              item={item}
              variant="list"
              locked={false}
              onLocked={onLocked}
              badge={item.href === '/dashboard/messages' ? unreadMessages : undefined}
            />
          ))}
        </div>

        {/* Shortcuts */}
        <div className="mt-5 space-y-0.5">
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted/70">Shortcuts</p>
          <SidebarShortcuts />
        </div>

        {/* All Services launcher */}
        <button
          onClick={() => setAllOpen(true)}
          className="mt-4 flex items-center gap-3 rounded-xl bg-brand px-3 py-3 text-sm font-bold text-brand-fg shadow-sm transition hover:opacity-90 xl:px-4"
        >
          <ALL_SERVICES_ICON className="h-5 w-5 shrink-0" />
          All Services
        </button>

        {/* Push the footer to the bottom */}
        <div className="flex-1" />

        {/* Settings + Help, always reachable */}
        <div className="space-y-0.5 border-t border-border/50 pt-3">
          {SIDEBAR_FOOTER_NAV.map((item) => (
            <NavEntry key={item.href} item={item} variant="list" locked={false} onLocked={onLocked} />
          ))}
        </div>
      </nav>

      <AllServicesModal open={allOpen} onClose={() => setAllOpen(false)} onLocked={(i) => { setAllOpen(false); onLocked(i); }} />
    </>
  );
}
