'use client';

// Settings → "Navigation Choices": full control over the curated sidebar. The
// top-level destinations AND each expandable group's sub-pages are reorderable,
// removable, and re-addable. AI Assistant, Settings, and Help & Support are fixed
// chrome and never appear here. Persists to Supabase
// (user_preferences.notification_prefs.sidebarNav + .sidebarNavChildren) and
// broadcasts SIDEBAR_NAV_EVENT so the live rail updates instantly.

import { useEffect, useMemo, useState } from 'react';
import { ArrowUp, ArrowDown, Plus, X, RotateCcw, Compass, Check, ChevronDown } from 'lucide-react';
import {
  NAV_CATALOG, NAV_CATALOG_BY_HREF, NAV_CATALOG_KEYS, DEFAULT_SIDEBAR_NAV_KEYS,
  NAV_CHILD_CATALOG_BY_PARENT, NAV_CHILD_KEYS_BY_PARENT, type NavItem,
} from '@/lib/constants/navigation';
import {
  resolveNavKeys, sanitizeNavKeys, resolveChildKeys, sanitizeChildMap, MAX_SIDEBAR_NAV,
  SIDEBAR_NAV_STORAGE_KEY, SIDEBAR_NAV_CHILDREN_STORAGE_KEY, SIDEBAR_NAV_EVENT, type NavChildMap,
} from '@/lib/navigation/customize';
import { loadSidebarPrefs, saveSidebarNavAction } from '@/app/(app)/dashboard/navigation-actions';
import { useToast } from '@/components/ui/toast';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';

function cacheAll(keys: string[], children: NavChildMap) {
  try {
    window.localStorage.setItem(SIDEBAR_NAV_STORAGE_KEY, JSON.stringify(keys));
    window.localStorage.setItem(SIDEBAR_NAV_CHILDREN_STORAGE_KEY, JSON.stringify(children));
  } catch { /* ignore */ }
}

function childArrayIsDefault(parent: string, arr: string[]): boolean {
  const def = NAV_CHILD_KEYS_BY_PARENT.get(parent) ?? [];
  const clean = sanitizeNavKeys(arr, def);
  return clean.length === def.length && clean.every((k, i) => k === def[i]);
}

export function NavigationChoices() {
  const { success, error: toastError } = useToast();

  // Seed from the localStorage cache for an instant render, then reconcile with
  // Supabase (authoritative). `loaded` gates the disabled state on first paint.
  const [keys, setKeys] = useState<string[]>(() => {
    if (typeof window === 'undefined') return DEFAULT_SIDEBAR_NAV_KEYS;
    try {
      const raw = window.localStorage.getItem(SIDEBAR_NAV_STORAGE_KEY);
      if (raw) {
        const cached = sanitizeNavKeys(JSON.parse(raw), NAV_CATALOG_KEYS);
        if (cached.length) return cached;
      }
    } catch { /* ignore */ }
    return DEFAULT_SIDEBAR_NAV_KEYS;
  });
  const [childMap, setChildMap] = useState<NavChildMap>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem(SIDEBAR_NAV_CHILDREN_STORAGE_KEY);
      if (raw) return sanitizeChildMap(JSON.parse(raw), NAV_CHILD_KEYS_BY_PARENT);
    } catch { /* ignore */ }
    return {};
  });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    loadSidebarPrefs().then(({ nav, children }) => {
      if (!active) return;
      setKeys(resolveNavKeys(nav, DEFAULT_SIDEBAR_NAV_KEYS, NAV_CATALOG_KEYS));
      setChildMap(sanitizeChildMap(children ?? {}, NAV_CHILD_KEYS_BY_PARENT));
      setLoaded(true);
    });
    return () => { active = false; };
  }, []);

  const items = useMemo(
    () => keys.map((href) => NAV_CATALOG_BY_HREF.get(href)).filter((i): i is NavItem => Boolean(i)),
    [keys],
  );
  const available = useMemo(() => NAV_CATALOG.filter((i) => !keys.includes(i.href)), [keys]);
  const isDefault = useMemo(() => {
    const keysDefault = keys.length === DEFAULT_SIDEBAR_NAV_KEYS.length && keys.every((k, i) => k === DEFAULT_SIDEBAR_NAV_KEYS[i]);
    const childCustom = Object.entries(childMap).some(([parent, arr]) => !childArrayIsDefault(parent, arr));
    return keysDefault && !childCustom;
  }, [keys, childMap]);

  // Persist a full layout: optimistic state + cache + broadcast, then Supabase.
  async function persist(nextKeys: string[], nextChildren: NavChildMap) {
    const cleanKeys = sanitizeNavKeys(nextKeys, NAV_CATALOG_KEYS);
    const cleanChildren = sanitizeChildMap(nextChildren, NAV_CHILD_KEYS_BY_PARENT);
    const prevKeys = keys;
    const prevChildren = childMap;
    setKeys(cleanKeys);
    setChildMap(cleanChildren);
    cacheAll(cleanKeys, cleanChildren);
    window.dispatchEvent(new CustomEvent(SIDEBAR_NAV_EVENT, { detail: { nav: cleanKeys, children: cleanChildren } }));
    setSaving(true);
    const res = await saveSidebarNavAction({ keys: cleanKeys, children: cleanChildren });
    setSaving(false);
    if (!res.ok) {
      setKeys(prevKeys);
      setChildMap(prevChildren);
      cacheAll(prevKeys, prevChildren);
      window.dispatchEvent(new CustomEvent(SIDEBAR_NAV_EVENT, { detail: { nav: prevKeys, children: prevChildren } }));
      toastError(res.error ?? 'Could not save your navigation');
    }
  }

  // ── Top-level ops ──────────────────────────────────────────────────────────
  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= keys.length) return;
    const next = [...keys];
    [next[index], next[target]] = [next[target], next[index]];
    void persist(next, childMap);
  }
  function remove(href: string) {
    if (keys.length <= 1) { toastError('Keep at least one destination in your sidebar.'); return; }
    // Drop any saved sub-page layout for a removed group so it doesn't linger.
    const { [href]: _gone, ...restChildren } = childMap;
    void persist(keys.filter((k) => k !== href), restChildren);
  }
  function add(href: string) {
    if (keys.length >= MAX_SIDEBAR_NAV) { toastError(`You can pin up to ${MAX_SIDEBAR_NAV} destinations.`); return; }
    void persist([...keys, href], childMap);
  }
  function reset() {
    if (isDefault) return;
    void persist([...DEFAULT_SIDEBAR_NAV_KEYS], {});
    success('Sidebar reset to the default layout');
  }

  // ── Sub-page (child) ops ─────────────────────────────────────────────────────
  function childKeys(parent: string): string[] {
    return resolveChildKeys(childMap, parent, NAV_CHILD_KEYS_BY_PARENT.get(parent) ?? []);
  }
  function setChild(parent: string, next: string[]) {
    void persist(keys, { ...childMap, [parent]: next });
  }
  function moveChild(parent: string, index: number, dir: -1 | 1) {
    const cur = childKeys(parent);
    const target = index + dir;
    if (target < 0 || target >= cur.length) return;
    const next = [...cur];
    [next[index], next[target]] = [next[target], next[index]];
    setChild(parent, next);
  }
  function removeChild(parent: string, href: string) {
    setChild(parent, childKeys(parent).filter((k) => k !== href));
  }
  function addChild(parent: string, href: string) {
    setChild(parent, [...childKeys(parent), href]);
  }
  function resetChild(parent: string) {
    const { [parent]: _gone, ...rest } = childMap;
    void persist(keys, rest);
  }
  function toggleGroup(parent: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(parent)) next.delete(parent); else next.add(parent);
      return next;
    });
  }

  return (
    <Card>
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Compass className="h-4 w-4 text-brand" /> Navigation Choices
          </h2>
          <p className="mt-1 text-sm text-muted">
            Choose which destinations appear in your sidebar and the order they show in — down to
            each group&apos;s sub-pages. Changes save automatically and sync across your devices.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={reset} disabled={isDefault || saving} title="Reset to the default layout">
          <RotateCcw className="h-4 w-4" /> Reset
        </Button>
      </div>

      <p className="mb-4 text-xs text-muted/80">
        AI Assistant, Settings, and Help &amp; Support are always available and can&apos;t be removed.
      </p>

      {/* Current layout */}
      <ul className="space-y-1.5">
        {items.map((item, index) => {
          const catalog = NAV_CHILD_CATALOG_BY_PARENT.get(item.href);
          const hasGroup = Boolean(catalog && catalog.length > 0);
          const open = openGroups.has(item.href);
          const kids = hasGroup ? childKeys(item.href) : [];
          const byHref = hasGroup ? new Map(catalog!.map((c) => [c.href, c])) : null;
          const kidItems = byHref ? kids.map((h) => byHref.get(h)).filter((c): c is NavItem => Boolean(c)) : [];
          const kidAvailable = catalog ? catalog.filter((c) => !kids.includes(c.href)) : [];
          return (
            <li key={item.href} className="rounded-xl border border-border bg-surface/40">
              <div className="flex items-center gap-3 px-3 py-2.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-elevated text-muted">
                  <item.icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.label}</p>
                  {hasGroup && (
                    <button type="button" onClick={() => toggleGroup(item.href)}
                      className="inline-flex items-center gap-1 text-xs text-muted transition hover:text-fg">
                      <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
                      {kidItems.length} sub-page{kidItems.length === 1 ? '' : 's'}
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-0.5">
                  <button type="button" onClick={() => move(index, -1)} disabled={index === 0 || saving}
                    aria-label={`Move ${item.label} up`} className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-30">
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={() => move(index, 1)} disabled={index === items.length - 1 || saving}
                    aria-label={`Move ${item.label} down`} className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-30">
                    <ArrowDown className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={() => remove(item.href)} disabled={items.length <= 1 || saving}
                    aria-label={`Remove ${item.label}`} className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-danger disabled:opacity-30">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Sub-page editor */}
              {hasGroup && open && (
                <div className="ml-6 border-l border-border/60 px-3 pb-3 pl-3">
                  {kidItems.length === 0 ? (
                    <p className="py-2 text-xs text-muted">No sub-pages — <span className="font-medium text-fg">{item.label}</span> shows as a plain link. Add some below.</p>
                  ) : (
                    <ul className="space-y-1 py-2">
                      {kidItems.map((kid, ki) => (
                        <li key={kid.href} className="flex items-center gap-2.5 rounded-lg bg-surface/60 px-2.5 py-1.5">
                          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-elevated text-muted"><kid.icon className="h-3.5 w-3.5" /></span>
                          <span className="min-w-0 flex-1 truncate text-sm">{kid.label}</span>
                          <button type="button" onClick={() => moveChild(item.href, ki, -1)} disabled={ki === 0 || saving}
                            aria-label={`Move ${kid.label} up`} className="grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
                          <button type="button" onClick={() => moveChild(item.href, ki, 1)} disabled={ki === kidItems.length - 1 || saving}
                            aria-label={`Move ${kid.label} down`} className="grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
                          <button type="button" onClick={() => removeChild(item.href, kid.href)} disabled={saving}
                            aria-label={`Remove ${kid.label}`} className="grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-elevated hover:text-danger disabled:opacity-30"><X className="h-3.5 w-3.5" /></button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {kidAvailable.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {kidAvailable.map((kid) => (
                        <button key={kid.href} type="button" onClick={() => addChild(item.href, kid.href)} disabled={saving}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-40">
                          <Plus className="h-3 w-3" /> {kid.label}
                        </button>
                      ))}
                    </div>
                  )}

                  {!childArrayIsDefault(item.href, kids) && (
                    <button type="button" onClick={() => resetChild(item.href)} disabled={saving}
                      className="mt-2 inline-flex items-center gap-1 text-xs text-muted transition hover:text-fg">
                      <RotateCcw className="h-3 w-3" /> Reset {item.label} sub-pages
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-2 flex items-center justify-between text-xs text-muted">
        <span>{items.length} of {MAX_SIDEBAR_NAV} destinations{loaded ? '' : ' · loading…'}</span>
        {available.length > 0 && (
          <button type="button" onClick={() => setAdding((v) => !v)} className="inline-flex items-center gap-1 font-semibold text-brand hover:underline">
            <Plus className="h-3.5 w-3.5" /> {adding ? 'Close' : 'Add a destination'}
          </button>
        )}
      </div>

      {/* Add picker (top-level) */}
      {adding && available.length > 0 && (
        <div className="mt-3 rounded-xl border border-border bg-surface/30 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted/70">Add to sidebar</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {available.map((item) => (
              <button key={item.href} type="button" onClick={() => add(item.href)} disabled={saving || keys.length >= MAX_SIDEBAR_NAV}
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-elevated disabled:opacity-40">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-elevated text-muted"><item.icon className="h-3.5 w-3.5" /></span>
                <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
                <Plus className="h-4 w-4 shrink-0 text-muted" />
              </button>
            ))}
          </div>
        </div>
      )}

      {isDefault && (
        <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted">
          <Check className="h-3.5 w-3.5 text-brand" /> You&apos;re using the default layout.
        </p>
      )}
    </Card>
  );
}
