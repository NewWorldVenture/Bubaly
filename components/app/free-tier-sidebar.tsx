'use client';

// The curated desktop sidebar (used by every account). A calm primary list of
// the member's pinned destinations, an "All Services" launcher to the full
// catalog where ANY service in the member's plan can be ⭐-pinned to the rail
// (individually, or all-at-once with "Pin all in my plan"), and a Settings /
// Help footer. Pins ARE the sidebar list: they persist to Supabase
// (user_preferences.notification_prefs.sidebarNav) so the rail follows the
// member across devices, with localStorage as an offline cache.

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { Star, ListPlus, ListX, Lock, RotateCcw } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import {
  SIDEBAR_FOOTER_NAV, ALL_SERVICES_ICON, APP_NAV_GROUPS,
  ALL_SERVICES_BY_HREF, ALL_SERVICES_KEYS, DEFAULT_SIDEBAR_NAV_KEYS,
  NAV_CHILD_KEYS_BY_PARENT, isNavItemVisibleToRole, type NavItem,
} from '@/lib/constants/navigation';
import { isManager } from '@/lib/constants/roles';
import { featureAccessByTier } from '@/lib/features/tiers';
import {
  resolveNavKeys, sanitizeNavKeys, resolveChildKeys, sanitizeChildMap,
  addNavKeys, removeNavKeys,
  SIDEBAR_NAV_STORAGE_KEY, SIDEBAR_NAV_CHILDREN_STORAGE_KEY, SIDEBAR_NAV_EVENT,
  type NavChildMap,
} from '@/lib/navigation/customize';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { ServiceTooltip, useServiceDescriptions } from '@/components/services/service-tooltip';
import { cn } from '@/lib/utils/cn';
import { loadSidebarPrefs, saveSidebarNavAction } from '@/app/(app)/dashboard/navigation-actions';
import { useApp } from './app-context';
import { resolveItems, NavEntry, AiAssistantNavButton } from './nav-shared';
import { SidebarAccount } from './sidebar-account';
import { useTranslations } from '@/components/i18n/locale-provider';

/**
 * Live unread-messages count for the sidebar badge. Seeds from the server
 * snapshot, then keeps it current: refetches on any `family_messages` change
 * (realtime) and whenever the tab regains focus (robust even if the table
 * isn't in the realtime publication — e.g. after the user reads messages).
 */
function useLiveUnread(initial: number, familyId: string, userId: string): number {
  const [count, setCount] = useState(initial);
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

function readCachedChildMap(): NavChildMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(SIDEBAR_NAV_CHILDREN_STORAGE_KEY);
    if (raw) return sanitizeChildMap(JSON.parse(raw), NAV_CHILD_KEYS_BY_PARENT);
  } catch { /* ignore */ }
  return {};
}

/**
 * The member's pinned sidebar destinations (raw keys), the resolved NavItems to
 * render, and a `persist` that saves a new pin list everywhere at once:
 * optimistic state → localStorage cache → same-tab broadcast (so the mobile
 * drawer's sidebar updates live) → Supabase (source of truth). Resolves against
 * the FULL cross-tier catalog so a member can pin higher-tier modules their plan
 * unlocks; payment-tier gating happens at render.
 */
function useSidebarNav() {
  const [keys, setKeysState] = useState<string[]>(() => {
    if (typeof window === 'undefined') return DEFAULT_SIDEBAR_NAV_KEYS;
    try {
      const raw = window.localStorage.getItem(SIDEBAR_NAV_STORAGE_KEY);
      if (raw) {
        const cached = sanitizeNavKeys(JSON.parse(raw), ALL_SERVICES_KEYS);
        if (cached.length) return cached;
      }
    } catch { /* ignore */ }
    return DEFAULT_SIDEBAR_NAV_KEYS;
  });
  const [childMap, setChildMap] = useState<NavChildMap>(readCachedChildMap);

  // Supabase is authoritative — reconcile once on mount.
  useEffect(() => {
    let active = true;
    loadSidebarPrefs().then(({ nav, children }) => {
      if (!active) return;
      if (nav != null) {
        const clean = resolveNavKeys(nav, DEFAULT_SIDEBAR_NAV_KEYS, ALL_SERVICES_KEYS);
        setKeysState(clean);
        try { window.localStorage.setItem(SIDEBAR_NAV_STORAGE_KEY, JSON.stringify(clean)); } catch { /* ignore */ }
      }
      if (children != null) {
        const clean = sanitizeChildMap(children, NAV_CHILD_KEYS_BY_PARENT);
        setChildMap(clean);
        try { window.localStorage.setItem(SIDEBAR_NAV_CHILDREN_STORAGE_KEY, JSON.stringify(clean)); } catch { /* ignore */ }
      }
    });
    return () => { active = false; };
  }, []);

  // Live update when a layout change is broadcast in this tab (Settings editor
  // saving, or the other FreeTierSidebar instance pinning).
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ nav: string[]; children: NavChildMap }>).detail;
      if (detail?.nav) setKeysState(resolveNavKeys(detail.nav, DEFAULT_SIDEBAR_NAV_KEYS, ALL_SERVICES_KEYS));
      if (detail?.children) setChildMap(sanitizeChildMap(detail.children, NAV_CHILD_KEYS_BY_PARENT));
    };
    window.addEventListener(SIDEBAR_NAV_EVENT, onChange);
    return () => window.removeEventListener(SIDEBAR_NAV_EVENT, onChange);
  }, []);

  /** Save a new pin list: optimistic + cache + broadcast + Supabase. */
  const persist = useCallback((next: string[]): Promise<{ ok: boolean; error?: string }> => {
    const clean = sanitizeNavKeys(next, ALL_SERVICES_KEYS);
    setKeysState(clean);
    try { window.localStorage.setItem(SIDEBAR_NAV_STORAGE_KEY, JSON.stringify(clean)); } catch { /* ignore */ }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(SIDEBAR_NAV_EVENT, { detail: { nav: clean, children: childMap } }));
    }
    return saveSidebarNavAction({ keys: clean });
  }, [childMap]);

  /** Reset the whole sidebar to the plan default — top-level keys AND every
   *  group's sub-page layout — matching the Settings › Navigation Choices reset. */
  const resetToDefault = useCallback((): Promise<{ ok: boolean; error?: string }> => {
    const clean = [...DEFAULT_SIDEBAR_NAV_KEYS];
    setKeysState(clean);
    setChildMap({});
    try {
      window.localStorage.setItem(SIDEBAR_NAV_STORAGE_KEY, JSON.stringify(clean));
      window.localStorage.setItem(SIDEBAR_NAV_CHILDREN_STORAGE_KEY, JSON.stringify({}));
    } catch { /* ignore */ }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(SIDEBAR_NAV_EVENT, { detail: { nav: clean, children: {} } }));
    }
    return saveSidebarNavAction({ keys: clean, children: {} });
  }, []);

  const items = useMemo(
    () => resolveNavKeys(keys, DEFAULT_SIDEBAR_NAV_KEYS, ALL_SERVICES_KEYS)
      .map((href) => ALL_SERVICES_BY_HREF.get(href))
      .filter((i): i is NavItem => Boolean(i))
      .map((item) => {
        const childCatalog = item.children;
        if (!childCatalog || childCatalog.length === 0) return item;
        const byHref = new Map(childCatalog.map((c) => [c.href, c]));
        const children = resolveChildKeys(childMap, item.href, childCatalog.map((c) => c.href))
          .map((h) => byHref.get(h))
          .filter((c): c is NavItem => Boolean(c));
        return { ...item, children };
      }),
    [keys, childMap],
  );

  return { items, keys, childMap, persist, resetToDefault };
}

/** Full catalog of every module, grouped + plan-gated, with ⭐ pin toggles and a
 *  "Pin all in my plan" / "Unpin all" header for the member's tier. */
function AllServicesModal({ open, onClose, onLocked, pinned, onTogglePin, onPinAll, onUnpinAll, onReset, isDefault, busy }: {
  open: boolean; onClose: () => void; onLocked: (item: NavItem) => void;
  pinned: Set<string>; onTogglePin: (href: string) => void;
  onPinAll: (hrefs: string[]) => void; onUnpinAll: (hrefs: string[]) => void;
  onReset: () => void; isDefault: boolean; busy: boolean;
}) {
  const t = useTranslations();
  const { planLevel, isSuperAdmin, featureTiers, role } = useApp();
  const manager = isManager(role);
  const descriptions = useServiceDescriptions();

  // Every service the member's plan unlocks, across all groups (deduped).
  const inTierHrefs = useMemo(() => {
    const set = new Set<string>();
    for (const group of APP_NAV_GROUPS) {
      for (const { item, locked } of resolveItems(group.items, featureTiers, planLevel, isSuperAdmin, manager)) {
        if (!locked && ALL_SERVICES_BY_HREF.has(item.href)) set.add(item.href);
      }
    }
    return [...set];
  }, [featureTiers, planLevel, isSuperAdmin, manager]);

  const allPinned = inTierHrefs.length > 0 && inTierHrefs.every((h) => pinned.has(h));

  if (!open) return null;
  return (
    <Modal open onClose={onClose} title={t('freeTierSidebar.allServices')} className="sm:max-w-2xl lg:max-w-3xl">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-3">
        <p className="text-xs text-muted">
          <Star className="mr-0.5 inline h-3 w-3 -translate-y-px fill-brand text-brand-text" /> {t('freeTierSidebar.pinsAServiceToYourSidebar')} <span className="font-semibold text-fg">{inTierHrefs.length}</span> {t('freeTierSidebar.inYourPlan')}
        </p>
        <div className="flex gap-2">
          <button
            type="button" disabled={busy || inTierHrefs.length === 0}
            onClick={() => onPinAll(inTierHrefs)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg transition hover:opacity-90 disabled:opacity-50"
          >
            <ListPlus className="h-3.5 w-3.5" /> {t('freeTierSidebar.pinAllInMyPlan')}
          </button>
          <button
            type="button" disabled={busy || !inTierHrefs.some((h) => pinned.has(h))}
            onClick={() => onUnpinAll(inTierHrefs)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-50"
          >
            <ListX className="h-3.5 w-3.5" /> {allPinned ? 'Unpin all' : 'Unpin these'}
          </button>
          <button
            type="button" disabled={busy || isDefault}
            onClick={onReset}
            title={t('freeTierSidebar.resetYourSidebarToYourPlans')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" /> {t('freeTierSidebar.reset')}
          </button>
        </div>
      </div>

      <div className="max-h-[68vh] space-y-6 overflow-y-auto pr-0.5">
        {APP_NAV_GROUPS.map((group) => {
          const resolved = resolveItems(group.items, featureTiers, planLevel, isSuperAdmin, manager);
          if (resolved.length === 0) return null;
          return (
            <section key={group.title} className="space-y-2">
              <div className="flex items-baseline gap-2 px-0.5">
                <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted/80">{group.title}</h3>
                <span className="h-px flex-1 bg-border/50" aria-hidden />
                <span className="text-[10px] font-semibold tabular-nums text-muted/50">{resolved.length}</span>
              </div>
              {/* Mobile-first: 2 roomy columns, 3 from sm. Labels wrap to 2 lines
                  (no more cut-off names); the pin star sits in a reserved lane so
                  it never overlaps the label. */}
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {resolved.map(({ item, locked }) => {
                  const pinnable = !locked && ALL_SERVICES_BY_HREF.has(item.href);
                  const isPinned = pinnable && pinned.has(item.href);
                  const inner = (
                    <>
                      <item.icon className={cn('h-5 w-5 shrink-0', locked ? 'text-muted/45' : 'text-fg/80')} />
                      <span className={cn('min-w-0 flex-1 text-left text-[13px] font-medium leading-tight line-clamp-2',
                        locked ? 'text-muted/50' : 'text-fg')}>{item.label}</span>
                      {locked && <Lock className="h-3.5 w-3.5 shrink-0 text-muted/45" />}
                    </>
                  );
                  return (
                    <ServiceTooltip key={item.href} label={item.label} description={descriptions[item.href] ?? ''}>
                      <div className={cn(
                        'group relative flex items-stretch rounded-xl border border-transparent transition',
                        'hover:border-border hover:bg-elevated/50',
                      )}>
                        {locked ? (
                          <button
                            type="button" onClick={() => onLocked(item)}
                            title={`${item.label} — upgrade to unlock`}
                            className={cn('flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left', pinnable && 'pr-8')}
                          >
                            {inner}
                          </button>
                        ) : (
                          <Link
                            href={item.href} onClick={onClose}
                            className={cn('flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2.5 py-2', pinnable && 'pr-8')}
                          >
                            {inner}
                          </Link>
                        )}
                        {pinnable && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={(e) => { e.stopPropagation(); onTogglePin(item.href); }}
                            aria-label={isPinned ? `Unpin ${item.label} from sidebar` : `Pin ${item.label} to sidebar`}
                            aria-pressed={isPinned}
                            title={isPinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                            className="absolute right-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted/50 transition hover:bg-elevated hover:text-brand-text disabled:opacity-50"
                          >
                            <Star className={cn('h-4 w-4', isPinned && 'fill-brand text-brand-text')} />
                          </button>
                        )}
                      </div>
                    </ServiceTooltip>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}

export function FreeTierSidebar({ onLocked }: { onLocked: (item: NavItem) => void }) {
  const t = useTranslations();
  const { familyId, userId, unreadMessages, role, isSuperAdmin, planLevel, featureTiers } = useApp();
  const { error: toastError, success } = useToast();
  const [allOpen, setAllOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const liveUnread = useLiveUnread(unreadMessages, familyId, userId);
  const { items: sidebarNav, keys, childMap, persist, resetToDefault } = useSidebarNav();
  const manager = isManager(role);

  // Already on the plan default? (same top-level keys + no sub-page overrides.)
  const isDefaultLayout = useMemo(
    () => keys.length === DEFAULT_SIDEBAR_NAV_KEYS.length
      && keys.every((k, i) => k === DEFAULT_SIDEBAR_NAV_KEYS[i])
      && Object.keys(childMap).length === 0,
    [keys, childMap],
  );

  // Render list: role-visible, payment-tier-gated (a pinned above-plan module
  // renders locked with the upgrade prompt, never as a dead link). Hidden/off
  // modules are dropped entirely.
  const primaryNav = useMemo(
    () => sidebarNav
      .filter((item) => isNavItemVisibleToRole(item, { isManager: manager, isSuperAdmin }))
      .map((item) => {
        const access = featureAccessByTier(featureTiers[item.href], planLevel, isSuperAdmin);
        const children = item.children?.filter((c) => isNavItemVisibleToRole(c, { isManager: manager, isSuperAdmin }));
        return { item: children ? { ...item, children } : item, locked: access === 'locked', hidden: access === 'hidden' };
      })
      .filter((x) => !x.hidden),
    [sidebarNav, manager, isSuperAdmin, planLevel, featureTiers],
  );

  const pinnedSet = useMemo(() => new Set(keys), [keys]);

  const save = useCallback(async (next: string[], okMsg?: string) => {
    setBusy(true);
    const prev = keys;
    const res = await persist(next);
    setBusy(false);
    if (!res.ok) { void persist(prev); toastError(res.error ?? 'Could not update your sidebar.'); return; }
    if (okMsg) success(okMsg);
  }, [keys, persist, toastError, success]);

  const togglePin = useCallback((href: string) => {
    const next = keys.includes(href) ? removeNavKeys(keys, [href]) : addNavKeys(keys, [href], ALL_SERVICES_KEYS);
    void save(next);
  }, [keys, save]);

  const pinAll = useCallback((hrefs: string[]) => {
    void save(addNavKeys(keys, hrefs, ALL_SERVICES_KEYS), `Pinned ${hrefs.length} services to your sidebar.`);
  }, [keys, save]);

  const unpinAll = useCallback((hrefs: string[]) => {
    void save(removeNavKeys(keys, hrefs), 'Unpinned those services.');
  }, [keys, save]);

  const reset = useCallback(async () => {
    if (isDefaultLayout) return;
    setBusy(true);
    const res = await resetToDefault();
    setBusy(false);
    if (!res.ok) { toastError(res.error ?? 'Could not reset your sidebar.'); return; }
    success(t('freeTierSidebar.sidebarResetToYourPlan'));
  }, [isDefaultLayout, resetToDefault, toastError, success, t]);

  return (
    <>
      <nav className="flex flex-1 flex-col overflow-y-auto px-3 pb-4 xl:px-4">
        {/* AI Assistant — pinned at the very top */}
        <div className="mb-2">
          <AiAssistantNavButton />
        </div>

        {/* Primary destinations — the member's pinned services */}
        <div className="space-y-0.5">
          {primaryNav.map(({ item, locked }) => (
            <NavEntry
              key={item.href}
              item={item}
              variant="list"
              locked={locked}
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
          {t('freeTierSidebar.allServices')}
        </button>

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
        onPinAll={pinAll}
        onUnpinAll={unpinAll}
        onReset={reset}
        isDefault={isDefaultLayout}
        busy={busy}
      />
    </>
  );
}
