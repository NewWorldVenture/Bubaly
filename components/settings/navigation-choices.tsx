'use client';

// Settings → "Navigation Choices": full control over the curated sidebar's
// primary destinations. Reorder, add, remove, and shorten/lengthen the list.
// AI Assistant, Settings, and Help & Support are fixed chrome and never appear
// here. Persists to Supabase (user_preferences.notification_prefs.sidebarNav)
// and broadcasts SIDEBAR_NAV_EVENT so the live rail updates instantly.

import { useEffect, useMemo, useState } from 'react';
import { ArrowUp, ArrowDown, Plus, X, RotateCcw, Compass, Check } from 'lucide-react';
import {
  NAV_CATALOG, NAV_CATALOG_BY_HREF, NAV_CATALOG_KEYS, DEFAULT_SIDEBAR_NAV_KEYS, type NavItem,
} from '@/lib/constants/navigation';
import {
  resolveNavKeys, sanitizeNavKeys, MAX_SIDEBAR_NAV,
  SIDEBAR_NAV_STORAGE_KEY, SIDEBAR_NAV_EVENT,
} from '@/lib/navigation/customize';
import { loadSidebarNav, saveSidebarNavAction } from '@/app/(app)/dashboard/navigation-actions';
import { useToast } from '@/components/ui/toast';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';

function cacheKeys(keys: string[]) {
  try { window.localStorage.setItem(SIDEBAR_NAV_STORAGE_KEY, JSON.stringify(keys)); } catch { /* ignore */ }
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
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let active = true;
    loadSidebarNav().then((saved) => {
      if (!active) return;
      setKeys(resolveNavKeys(saved, DEFAULT_SIDEBAR_NAV_KEYS, NAV_CATALOG_KEYS));
      setLoaded(true);
    });
    return () => { active = false; };
  }, []);

  const items = useMemo(
    () => keys.map((href) => NAV_CATALOG_BY_HREF.get(href)).filter((i): i is NavItem => Boolean(i)),
    [keys],
  );
  const available = useMemo(
    () => NAV_CATALOG.filter((i) => !keys.includes(i.href)),
    [keys],
  );
  const isDefault = keys.length === DEFAULT_SIDEBAR_NAV_KEYS.length && keys.every((k, i) => k === DEFAULT_SIDEBAR_NAV_KEYS[i]);

  // Persist a new layout: optimistic state + cache + broadcast, then Supabase.
  async function persist(next: string[]) {
    const clean = sanitizeNavKeys(next, NAV_CATALOG_KEYS);
    const previous = keys;
    setKeys(clean);
    cacheKeys(clean);
    window.dispatchEvent(new CustomEvent(SIDEBAR_NAV_EVENT, { detail: clean }));
    setSaving(true);
    const res = await saveSidebarNavAction({ keys: clean });
    setSaving(false);
    if (!res.ok) {
      setKeys(previous);
      cacheKeys(previous);
      window.dispatchEvent(new CustomEvent(SIDEBAR_NAV_EVENT, { detail: previous }));
      toastError(res.error ?? 'Could not save your navigation');
    }
  }

  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= keys.length) return;
    const next = [...keys];
    [next[index], next[target]] = [next[target], next[index]];
    void persist(next);
  }
  function remove(href: string) {
    if (keys.length <= 1) { toastError('Keep at least one destination in your sidebar.'); return; }
    void persist(keys.filter((k) => k !== href));
  }
  function add(href: string) {
    if (keys.length >= MAX_SIDEBAR_NAV) { toastError(`You can pin up to ${MAX_SIDEBAR_NAV} destinations.`); return; }
    void persist([...keys, href]);
  }
  function reset() {
    if (isDefault) return;
    void persist([...DEFAULT_SIDEBAR_NAV_KEYS]);
    success('Sidebar reset to the default layout');
  }

  return (
    <Card>
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Compass className="h-4 w-4 text-brand" /> Navigation Choices
          </h2>
          <p className="mt-1 text-sm text-muted">
            Choose which destinations appear in your sidebar, and the order they show in.
            Changes save automatically and sync across your devices.
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
        {items.map((item, index) => (
          <li key={item.href}
            className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-elevated text-muted">
              <item.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{item.label}</p>
              {item.children?.length ? <p className="truncate text-xs text-muted">{item.children.length} sub-pages</p> : null}
            </div>
            <span className="hidden text-xs tabular-nums text-muted/60 sm:inline">{index + 1}</span>
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
          </li>
        ))}
      </ul>

      <div className="mt-2 flex items-center justify-between text-xs text-muted">
        <span>{items.length} of {MAX_SIDEBAR_NAV} destinations{loaded ? '' : ' · loading…'}</span>
        {available.length > 0 && (
          <button type="button" onClick={() => setAdding((v) => !v)} className="inline-flex items-center gap-1 font-semibold text-brand hover:underline">
            <Plus className="h-3.5 w-3.5" /> {adding ? 'Close' : 'Add a destination'}
          </button>
        )}
      </div>

      {/* Add picker */}
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
