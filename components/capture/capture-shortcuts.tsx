'use client';

// Shared, customizable Capture shortcuts — ONE system used everywhere shortcuts
// appear (the global Quick-capture modal and the /capture page), so a member
// customizes once and it follows them across surfaces AND devices.
//
// Behavior (product spec):
//  • Default view shows ONLY the shortcuts the member selected — no "+ Add"
//    placeholder wall. Brand-new members get a starter set (never customized).
//  • Pressing "Customize" reveals editing: tap a tile to change it, × to
//    remove, and a single "Add shortcut" tile while there's room — up to
//    MAX_CAPTURE_SHORTCUTS (10) total.
//  • Every change saves instantly (optimistic): localStorage for instant/offline
//    render + Supabase (user_preferences.notification_prefs.captureShortcuts,
//    own-row RLS) for cross-device sync. No separate "Save" step.

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  Calendar, CheckSquare, ShoppingCart, Home, HeartPulse, Plane,
  StickyNote, UtensilsCrossed, Bell, FileText, Wallet, PawPrint, Target,
  CreditCard, Users, Image as ImageIcon, GraduationCap, Gift, MessageCircle,
  BookHeart, PiggyBank, Receipt, RefreshCw, MapPin, NotebookPen,
  Repeat, CloudSun, Cake, Megaphone, ChefHat, ListChecks,
  Plus, X, Check, Settings2, Shirt, Clapperboard, PackageSearch, MoonStar, Sparkle,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import {
  DEFAULT_CAPTURE_SHORTCUTS, MAX_CAPTURE_SHORTCUTS,
  sanitizeShortcutKeys, resolveSavedShortcuts,
} from '@/lib/capture/shortcuts';
import { loadCaptureShortcuts, saveCaptureShortcutsAction } from '@/app/(app)/capture/shortcuts-actions';

export type Shortcut = { key: string; icon: typeof Calendar; label: string; href: string; hint: string };

/** Catalog of "jump directly to" destinations the picker draws from. Keys are
 *  stable so saved layouts survive label/icon tweaks. */
export const SHORTCUT_CATALOG: Shortcut[] = [
  { key: 'calendar', icon: Calendar, label: 'Calendar', href: '/dashboard/calendar', hint: 'Add event' },
  { key: 'tasks', icon: CheckSquare, label: 'Tasks', href: '/dashboard/chores', hint: 'Create task' },
  { key: 'grocery', icon: ShoppingCart, label: 'Grocery', href: '/dashboard/grocery', hint: 'Add to list' },
  { key: 'home', icon: Home, label: 'Home Maintenance', href: '/dashboard/home', hint: 'Home task' },
  { key: 'health', icon: HeartPulse, label: 'Health', href: '/dashboard/health', hint: 'Log health' },
  { key: 'trip', icon: Plane, label: 'Trip', href: '/dashboard/trips', hint: 'Plan trip' },
  { key: 'notes', icon: StickyNote, label: 'Notes', href: '/dashboard/notes', hint: 'Jot a note' },
  { key: 'meals', icon: UtensilsCrossed, label: 'Meals', href: '/dashboard/meals', hint: 'Plan meals' },
  { key: 'reminders', icon: Bell, label: 'Reminders', href: '/dashboard/reminders', hint: 'Set reminder' },
  { key: 'documents', icon: FileText, label: 'Documents', href: '/dashboard/documents', hint: 'Add document' },
  { key: 'wallet', icon: Wallet, label: 'Wallet', href: '/wallet', hint: 'Family wallet' },
  { key: 'pets', icon: PawPrint, label: 'Pets', href: '/dashboard/pets', hint: 'Pet care' },
  { key: 'closet', icon: Shirt, label: 'Closet', href: '/dashboard/closet', hint: 'Outfit today' },
  { key: 'watchlist', icon: Clapperboard, label: 'Watchlist', href: '/dashboard/watchlist', hint: 'Movie night' },
  { key: 'inventory', icon: PackageSearch, label: 'Inventory', href: '/dashboard/inventory', hint: 'Where is it?' },
  { key: 'sleep', icon: MoonStar, label: 'Sleep', href: '/dashboard/sleep', hint: 'Log last night' },
  { key: 'declutter', icon: Sparkle, label: 'Declutter', href: '/dashboard/declutter', hint: '15-minute mission' },
  { key: 'goals', icon: Target, label: 'Goals', href: '/dashboard/goals', hint: 'Family goal' },
  { key: 'finances', icon: CreditCard, label: 'Finances', href: '/dashboard/billing', hint: 'Track money' },
  { key: 'contacts', icon: Users, label: 'Contacts', href: '/dashboard/contacts', hint: 'Add contact' },
  { key: 'photos', icon: ImageIcon, label: 'Photos', href: '/dashboard/photos', hint: 'Add photo' },
  { key: 'school', icon: GraduationCap, label: 'School', href: '/dashboard/school', hint: 'School item' },
  { key: 'wishlists', icon: Gift, label: 'Wish Lists', href: '/dashboard/wishlists', hint: 'Add a wish' },
  { key: 'messages', icon: MessageCircle, label: 'Messages', href: '/dashboard/messages', hint: 'Send a message' },
  { key: 'memories', icon: BookHeart, label: 'Memories', href: '/dashboard/memories', hint: 'Save a moment' },
  { key: 'budgets', icon: PiggyBank, label: 'Budgets', href: '/dashboard/budgets', hint: 'Set budgets' },
  { key: 'bills', icon: Receipt, label: 'Bills', href: '/dashboard/bills', hint: 'Manage bills' },
  { key: 'subscriptions', icon: RefreshCw, label: 'Subscriptions', href: '/dashboard/subscriptions', hint: 'Track plans' },
  { key: 'locator', icon: MapPin, label: 'Family Map', href: '/dashboard/locator', hint: 'Find family' },
  { key: 'journal', icon: NotebookPen, label: 'Journal', href: '/dashboard/journal', hint: 'Write entry' },
  { key: 'habits', icon: Repeat, label: 'Habits', href: '/dashboard/habits', hint: 'Track habit' },
  { key: 'weather', icon: CloudSun, label: 'Weather', href: '/dashboard/weather', hint: 'Check forecast' },
  { key: 'celebrations', icon: Cake, label: 'Celebrations', href: '/dashboard/celebrations', hint: 'Mark occasion' },
  { key: 'announcements', icon: Megaphone, label: 'Announcements', href: '/dashboard/announcements', hint: 'Tell everyone' },
  { key: 'recipes', icon: ChefHat, label: 'Recipes', href: '/dashboard/recipes', hint: 'Find recipe' },
  { key: 'todos', icon: ListChecks, label: 'To-Dos', href: '/dashboard/todos', hint: 'Make a list' },
];
export const SHORTCUT_BY_KEY: Record<string, Shortcut> = Object.fromEntries(SHORTCUT_CATALOG.map((s) => [s.key, s]));
export const CATALOG_KEYS = SHORTCUT_CATALOG.map((s) => s.key);

const STORAGE_KEY = 'bubaly.capture.shortcuts';

function readCache(): string[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    // A cached array (even empty) is an explicit choice; anything else = no cache.
    return Array.isArray(parsed) ? sanitizeShortcutKeys(parsed, CATALOG_KEYS, MAX_CAPTURE_SHORTCUTS) : null;
  } catch { return null; }
}
function writeCache(keys: string[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(keys)); } catch { /* ignore */ }
}

/**
 * Shortcut layout state, shared by every surface.
 * Priority: server-provided `initialKeys` (SSR pages) → localStorage cache
 * (instant) → background Supabase load (authoritative) → starter defaults.
 */
export function useCaptureShortcuts(initialKeys?: string[] | null) {
  const { error: toastError } = useToast();
  const hasServerInitial = initialKeys !== undefined && initialKeys !== null;
  const [keys, setKeys] = useState<string[]>(() =>
    hasServerInitial
      ? resolveSavedShortcuts(initialKeys, CATALOG_KEYS, MAX_CAPTURE_SHORTCUTS)
      : DEFAULT_CAPTURE_SHORTCUTS.filter((k) => k in SHORTCUT_BY_KEY));
  // Guards the background load against overwriting an edit the user just made.
  const dirty = useRef(false);

  useEffect(() => {
    if (hasServerInitial) { writeCache(keys); return; }
    // Instant paint from cache, then reconcile with the server copy.
    const cached = readCache();
    if (cached !== null && !dirty.current) setKeys(cached);
    let active = true;
    loadCaptureShortcuts()
      .then((saved) => {
        if (!active || dirty.current || saved === null) return;
        const resolved = sanitizeShortcutKeys(saved, CATALOG_KEYS, MAX_CAPTURE_SHORTCUTS);
        setKeys(resolved);
        writeCache(resolved);
      })
      .catch(() => { /* offline — cache/defaults already shown */ });
    return () => { active = false; };
    // Mount-only by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function persist(next: string[]) {
    dirty.current = true;
    const clean = sanitizeShortcutKeys(next, CATALOG_KEYS, MAX_CAPTURE_SHORTCUTS);
    setKeys(clean);
    writeCache(clean);
    void saveCaptureShortcutsAction({ keys: clean }).then((res) => {
      if (!res.ok) toastError(res.error ?? 'Could not save shortcuts');
    });
  }

  return { keys, persist };
}

export function CaptureShortcuts({
  initialKeys, heading = 'Shortcuts', columns = 4, onNavigate,
  editing: editingProp, onEditingChange, showCustomizeButton = true,
}: {
  initialKeys?: string[] | null;
  heading?: string;
  /** Grid columns: 3 on the roomy /capture page, 4 in the compact modal. */
  columns?: 3 | 4;
  /** Called when a shortcut is tapped (e.g. close the hosting modal). */
  onNavigate?: () => void;
  /** Controlled edit mode — pass with onEditingChange to drive it from outside
   *  (e.g. a "Customize" button hoisted into the modal header). */
  editing?: boolean;
  onEditingChange?: (v: boolean) => void;
  /** Hide the built-in Customize/Done toggle when the host renders its own. */
  showCustomizeButton?: boolean;
}) {
  const { keys, persist } = useCaptureShortcuts(initialKeys);
  const [editingInternal, setEditingInternal] = useState(false);
  const editing = editingProp ?? editingInternal;
  const setEditing = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(editing) : v;
    if (onEditingChange) onEditingChange(next); else setEditingInternal(next);
  };
  const [picker, setPicker] = useState<{ mode: 'add' | 'replace'; index: number } | null>(null);

  const availableToAdd = SHORTCUT_CATALOG.filter((s) => !keys.includes(s.key));
  const canAdd = keys.length < MAX_CAPTURE_SHORTCUTS && availableToAdd.length > 0;

  function removeAt(index: number) { persist(keys.filter((_, i) => i !== index)); }
  function pick(key: string) {
    if (!picker) return;
    if (picker.mode === 'replace') persist(keys.map((k, i) => (i === picker.index ? key : k)));
    else persist([...keys, key]);
    setPicker(null);
  }

  const gridCols = columns === 3 ? 'grid-cols-3' : 'grid-cols-4';

  return (
    <div>
      {(heading || showCustomizeButton) && (
        <div className="mb-2 flex items-center justify-between">
          {heading ? <p className="text-xs font-semibold uppercase tracking-wide text-muted">{heading}</p> : <span />}
          {showCustomizeButton && (
            <button
              type="button"
              onClick={() => { setEditing((v) => !v); setPicker(null); }}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-brand-text transition hover:bg-brand/10"
            >
              {editing
                ? <><span className="text-muted">{keys.length}/{MAX_CAPTURE_SHORTCUTS} ·</span> <Check className="h-3.5 w-3.5" /> Done</>
                : <><Settings2 className="h-3.5 w-3.5" /> Customize</>}
            </button>
          )}
        </div>
      )}

      {/* Empty (only reachable by explicitly removing everything) */}
      {keys.length === 0 && !editing && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="w-full rounded-2xl border-2 border-dashed border-border px-3 py-4 text-center text-xs text-muted transition hover:border-brand/40 hover:text-brand-text"
        >
          No shortcuts yet — tap to add up to {MAX_CAPTURE_SHORTCUTS}.
        </button>
      )}

      <div className={cn('grid gap-2', gridCols)}>
        {keys.map((key, index) => {
          const s = SHORTCUT_BY_KEY[key];
          if (!s) return null;
          const Icon = s.icon;
          if (editing) {
            return (
              <div key={key} className="relative">
                <button
                  type="button"
                  onClick={() => setPicker({ mode: 'replace', index })}
                  className="flex w-full flex-col items-center gap-1 rounded-2xl border border-brand/30 bg-brand/5 px-2 py-3 text-center transition hover:bg-brand/10"
                >
                  <Icon className="h-5 w-5 text-brand-text" />
                  <span className="w-full truncate text-xs font-semibold">{s.label}</span>
                  <span className="text-[10px] text-brand-text">Tap to change</span>
                </button>
                <button
                  type="button"
                  onClick={() => removeAt(index)}
                  aria-label={`Remove ${s.label}`}
                  className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-danger text-white shadow"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          }
          return (
            <Link
              key={key}
              href={s.href}
              onClick={onNavigate}
              className="flex flex-col items-center gap-1 rounded-2xl border border-border bg-surface/40 px-2 py-3 text-center transition hover:border-brand/30 hover:bg-elevated"
            >
              <Icon className="h-5 w-5 text-brand-text" />
              <span className="w-full truncate text-xs font-semibold">{s.label}</span>
              <span className="w-full truncate text-[10px] text-muted">{s.hint}</span>
            </Link>
          );
        })}

        {/* Exactly ONE add tile, and only while customizing with room left. */}
        {editing && canAdd && (
          <button
            type="button"
            onClick={() => setPicker({ mode: 'add', index: keys.length })}
            className="flex flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-border px-2 py-3 text-center text-muted transition hover:border-brand/40 hover:text-brand-text"
          >
            <Plus className="h-5 w-5" />
            <span className="text-xs font-semibold">Add shortcut</span>
            <span className="text-[10px]">{keys.length}/{MAX_CAPTURE_SHORTCUTS}</span>
          </button>
        )}
      </div>

      {/* Picker */}
      {picker && (
        <Modal open title={picker.mode === 'replace' ? 'Change shortcut' : 'Add a shortcut'} onClose={() => setPicker(null)}>
          <div className="grid grid-cols-3 gap-2">
            {(picker.mode === 'replace'
              ? SHORTCUT_CATALOG.filter((s) => !keys.includes(s.key) || s.key === keys[picker.index])
              : availableToAdd
            ).map((s) => {
              const Icon = s.icon;
              const isCurrent = picker.mode === 'replace' && s.key === keys[picker.index];
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => pick(s.key)}
                  className={cn('flex flex-col items-center gap-1.5 rounded-2xl border p-3 text-center transition',
                    isCurrent ? 'border-brand bg-brand/10' : 'border-border bg-surface/40 hover:border-brand/40 hover:bg-elevated')}
                >
                  <Icon className="h-6 w-6 text-brand-text" />
                  <span className="text-xs font-semibold">{s.label}</span>
                </button>
              );
            })}
          </div>
        </Modal>
      )}
    </div>
  );
}
