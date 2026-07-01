'use client';

// The curated Free-tier desktop sidebar: a calm primary list, the user's pinned
// shortcuts, an "All Services" launcher to the full catalog (where any service
// can be ⭐-pinned to the sidebar), and a Settings / Help footer. The full
// ~70-module catalog lives behind All Services (plan-gated with upgrade prompts)
// so nothing is lost — it's just no longer overwhelming.

import { useEffect, useId, useMemo, useState } from 'react';
import { Star } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import {
  PRIMARY_NAV, DASHBOARD_NAV, SIDEBAR_FOOTER_NAV, ALL_SERVICES_ICON, APP_NAV_GROUPS, type NavItem,
} from '@/lib/constants/navigation';
import { FEATURE_BY_KEY } from '@/lib/dashboard/registry';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { saveDashboardLayoutAction } from '@/app/(app)/dashboard/customize-actions';
import { useApp } from './app-context';
import { resolveItems, NavEntry, AiAssistantNavButton } from './nav-shared';
import { SidebarAccount } from './sidebar-account';

// Reverse map: nav route → registry feature key (only routes that ARE a
// registry feature can be pinned, since pins persist as dashboard feature_keys).
const KEY_BY_ROUTE = new Map(Object.values(FEATURE_BY_KEY).map((f) => [f.route, f.key]));

/**
 * Live unread-messages count for the sidebar badge. Seeds from the server
 * snapshot, then keeps it current: refetches on any `family_messages` change
 * (realtime) and whenever the tab regains focus (robust even if the table
 * isn't in the realtime publication — e.g. after the user reads messages).
 */
function useLiveUnread(initial: number, familyId: string, userId: string): number {
  const [count, setCount] = useState(initial);
  // Unique per component instance. The browser Supabase client is a singleton,
  // and the desktop sidebar + the mobile drawer can both mount a FreeTierSidebar
  // at once — two channels with the SAME topic on one client collide and throw
  // ("tried to subscribe multiple times"), which broke the hamburger drawer.
  const channelId = useId();
  useEffect(() => { setCount(initial); }, [initial]);

  useEffect(() => {
    const supabase = createClient();
    let active = true;
    const refetch = async () => {
      const { count: c } = await supabase
        .from('family_messages')
        .select('id', { count: 'exact', head: true })
        .eq('family_id', familyId).is('deleted_at', null)
        .neq('sender_id', userId).not('read_by', 'cs', `{${userId}}`);
      if (active && typeof c === 'number') setCount(c);
    };
    const channel = supabase
      .channel(`unread-msgs:${familyId}:${channelId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'family_messages', filter: `family_id=eq.${familyId}` }, () => { void refetch(); })
      .subscribe();
    const onVis = () => { if (document.visibilityState === 'visible') void refetch(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      active = false;
      void supabase.removeChannel(channel);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [familyId, userId, channelId]);

  return count;
}

/** Full catalog of every module, grouped + plan-gated, with ⭐ pin toggles. */
function AllServicesModal({ open, onClose, onLocked, pinned, onTogglePin }: {
  open: boolean; onClose: () => void; onLocked: (item: NavItem) => void;
  pinned: Set<string>; onTogglePin: (key: string) => void;
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
                {resolved.map(({ item, locked }) => {
                  const key = !locked ? KEY_BY_ROUTE.get(item.href) : undefined;
                  const isPinned = key ? pinned.has(key) : false;
                  return (
                    <div key={item.href} className="relative">
                      <div onClick={() => { if (!locked) onClose(); }}>
                        <NavEntry item={item} variant="grid" locked={locked} onLocked={onLocked} />
                      </div>
                      {key && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); onTogglePin(key); }}
                          aria-label={isPinned ? `Unpin ${item.label}` : `Pin ${item.label}`}
                          title={isPinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                          className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-md text-muted/60 transition hover:bg-elevated hover:text-brand"
                        >
                          <Star className={cn('h-3.5 w-3.5', isPinned && 'fill-brand text-brand')} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

export function FreeTierSidebar({ onLocked }: { onLocked: (item: NavItem) => void }) {
  const { familyId, userId, unreadMessages } = useApp();
  const { error: toastError } = useToast();
  const [allOpen, setAllOpen] = useState(false);
  const [keys, setKeys] = useState<string[] | null>(null);
  const liveUnread = useLiveUnread(unreadMessages, familyId, userId);

  // Initial pinned set: the user's saved layout, else the family default.
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
        setKeys(((mine?.feature_keys ?? fam?.feature_keys ?? []) as string[]));
      });
    return () => { active = false; };
  }, [familyId, userId]);

  const pinnedSet = useMemo(() => new Set(keys ?? []), [keys]);

  async function togglePin(key: string) {
    const current = keys ?? [];
    const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
    setKeys(next); // optimistic
    // No deviceContext → device 'all', the same row the Home Quick Access uses,
    // so pinned favorites stay in sync across the sidebar and the dashboard.
    const res = await saveDashboardLayoutAction({ featureKeys: next });
    if (!res.ok) {
      setKeys(current); // revert
      toastError(res.error ?? 'Could not update your shortcuts.');
    }
  }

  return (
    <>
      <nav className="flex flex-1 flex-col overflow-y-auto px-3 pb-4 xl:px-4">
        {/* AI Assistant — pinned at the very top */}
        <div className="mb-2">
          <AiAssistantNavButton />
        </div>

        {/* Primary destinations */}
        <div className="space-y-0.5">
          {PRIMARY_NAV.map((item) => (
            <NavEntry
              key={item.href}
              item={item}
              variant="list"
              locked={false}
              onLocked={onLocked}
              badge={item.href === '/dashboard/messages' ? liveUnread : undefined}
            />
          ))}
        </div>

        {/* Divider, then the All Services launcher */}
        <div className="my-3 border-t border-border/50" />
        <button
          onClick={() => setAllOpen(true)}
          className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted transition hover:bg-elevated hover:text-fg xl:px-4 xl:py-3 xl:text-base"
        >
          <ALL_SERVICES_ICON className="h-5 w-5 shrink-0" />
          All Services
        </button>

        {/* Dashboards & hubs */}
        <div className="mt-2 space-y-0.5">
          {DASHBOARD_NAV.map((item) => (
            <NavEntry key={item.href} item={item} variant="list" locked={false} onLocked={onLocked} />
          ))}
        </div>

        {/* Push the footer to the bottom */}
        <div className="flex-1" />

        {/* Settings + Help, always reachable */}
        <div className="space-y-0.5 border-t border-border/50 pt-3">
          {SIDEBAR_FOOTER_NAV.map((item) => (
            <NavEntry key={item.href} item={item} variant="list" locked={false} onLocked={onLocked} />
          ))}
        </div>

        {/* Account details + theme toggle */}
        <div className="mt-3">
          <SidebarAccount />
        </div>
      </nav>

      <AllServicesModal
        open={allOpen}
        onClose={() => setAllOpen(false)}
        onLocked={(i) => { setAllOpen(false); onLocked(i); }}
        pinned={pinnedSet}
        onTogglePin={togglePin}
      />
    </>
  );
}
