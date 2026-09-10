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
  Plus, X, Check, Settings2, Shirt, Clapperboard, PackageSearch, MoonStar, Sparkle, Truck, Hammer, Briefcase, Languages,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import {
  DEFAULT_CAPTURE_SHORTCUTS, MAX_CAPTURE_SHORTCUTS,
  sanitizeShortcutKeys, resolveSavedShortcuts,
} from '@/lib/capture/shortcuts';
import { loadCaptureShortcuts, saveCaptureShortcutsAction } from '@/app/(app)/capture/shortcuts-actions';
import { useLocale, useTranslations } from '@/components/i18n/locale-provider';

export type Shortcut = { key: string; icon: typeof Calendar; labelKey: string; href: string; hintKey: string };

/** Catalog of "jump directly to" destinations the picker draws from. Keys are
 *  stable so saved layouts survive label/icon tweaks. Every rendered label and
 *  hint resolves a message key using the active locale. */
export const SHORTCUT_CATALOG: Shortcut[] = [
  { key: 'calendar', icon: Calendar, labelKey: 'calendar.calendar', href: '/dashboard/calendar', hintKey: 'captureShortcuts.calendarHint' },
  { key: 'tasks', icon: CheckSquare, labelKey: 'dashboardPlanning.tasks', href: '/dashboard/chores', hintKey: 'home.createTask' },
  { key: 'grocery', icon: ShoppingCart, labelKey: 'kitchenDashboard.grocery', href: '/dashboard/grocery', hintKey: 'captureShortcuts.groceryHint' },
  { key: 'home', icon: Home, labelKey: 'trustDomain.homeMaintenance', href: '/dashboard/home', hintKey: 'captureShortcuts.homeHint' },
  { key: 'health', icon: HeartPulse, labelKey: 'health.health', href: '/dashboard/health', hintKey: 'captureShortcuts.healthHint' },
  { key: 'trip', icon: Plane, labelKey: 'search.kindTrip', href: '/dashboard/trips', hintKey: 'captureShortcuts.tripHint' },
  { key: 'notes', icon: StickyNote, labelKey: 'dashboardPlanning.notes', href: '/dashboard/notes', hintKey: 'captureShortcuts.notesHint' },
  { key: 'meals', icon: UtensilsCrossed, labelKey: 'meals.meals', href: '/dashboard/meals', hintKey: 'aiHomeDashboard.planMeals' },
  { key: 'reminders', icon: Bell, labelKey: 'dashboardPlanning.reminders', href: '/dashboard/reminders', hintKey: 'captureShortcuts.remindersHint' },
  { key: 'documents', icon: FileText, labelKey: 'dashboardPlanning.documents', href: '/dashboard/documents', hintKey: 'taxVault.addDocument' },
  { key: 'wallet', icon: Wallet, labelKey: 'captureShortcuts.walletLabel', href: '/wallet', hintKey: 'captureShortcuts.walletHint' },
  { key: 'pets', icon: PawPrint, labelKey: 'pets.pets', href: '/dashboard/pets', hintKey: 'captureShortcuts.petsHint' },
  { key: 'closet', icon: Shirt, labelKey: 'beforeYouBuy.closet', href: '/dashboard/closet', hintKey: 'captureShortcuts.closetHint' },
  { key: 'watchlist', icon: Clapperboard, labelKey: 'captureShortcuts.watchlistLabel', href: '/dashboard/watchlist', hintKey: 'captureShortcuts.watchlistHint' },
  { key: 'inventory', icon: PackageSearch, labelKey: 'captureShortcuts.inventoryLabel', href: '/dashboard/inventory', hintKey: 'captureShortcuts.inventoryHint' },
  { key: 'sleep', icon: MoonStar, labelKey: 'health.sleep', href: '/dashboard/sleep', hintKey: 'sleep.logLastNight' },
  { key: 'declutter', icon: Sparkle, labelKey: 'captureShortcuts.declutterLabel', href: '/dashboard/declutter', hintKey: 'captureShortcuts.declutterHint' },
  { key: 'moving', icon: Truck, labelKey: 'captureShortcuts.movingLabel', href: '/dashboard/moving', hintKey: 'captureShortcuts.movingHint' },
  { key: 'projects', icon: Hammer, labelKey: 'projects.project', href: '/dashboard/projects', hintKey: 'captureShortcuts.projectsHint' },
  { key: 'career', icon: Briefcase, labelKey: 'captureShortcuts.careerLabel', href: '/dashboard/career', hintKey: 'captureShortcuts.careerHint' },
  { key: 'language', icon: Languages, labelKey: 'language.language', href: '/dashboard/language', hintKey: 'captureShortcuts.languageHint' },
  { key: 'goals', icon: Target, labelKey: 'childDetail.goals', href: '/dashboard/goals', hintKey: 'goalsView.familyGoal' },
  { key: 'finances', icon: CreditCard, labelKey: 'finances.finances', href: '/dashboard/billing', hintKey: 'captureShortcuts.financesHint' },
  { key: 'contacts', icon: Users, labelKey: 'dashboardPlanning.contacts', href: '/dashboard/contacts', hintKey: 'dashboardFamilyEmergency.addContact' },
  { key: 'photos', icon: ImageIcon, labelKey: 'displayGrid.photos', href: '/dashboard/photos', hintKey: 'captureShortcuts.photosHint' },
  { key: 'school', icon: GraduationCap, labelKey: 'school.school', href: '/dashboard/school', hintKey: 'captureShortcuts.schoolHint' },
  { key: 'wishlists', icon: Gift, labelKey: 'wishlists.wishLists', href: '/dashboard/wishlists', hintKey: 'wishlists.addAWish' },
  { key: 'messages', icon: MessageCircle, labelKey: 'messages.messages', href: '/dashboard/messages', hintKey: 'captureShortcuts.messagesHint' },
  { key: 'memories', icon: BookHeart, labelKey: 'dashboardMemories.memories', href: '/dashboard/memories', hintKey: 'captureShortcuts.memoriesHint' },
  { key: 'budgets', icon: PiggyBank, labelKey: 'billing.budgets', href: '/dashboard/budgets', hintKey: 'captureShortcuts.budgetsHint' },
  { key: 'bills', icon: Receipt, labelKey: 'billing.bills', href: '/dashboard/bills', hintKey: 'captureShortcuts.billsHint' },
  { key: 'subscriptions', icon: RefreshCw, labelKey: 'subscriptions.subscriptions', href: '/dashboard/subscriptions', hintKey: 'captureShortcuts.subscriptionsHint' },
  { key: 'locator', icon: MapPin, labelKey: 'findPhone.familyMap', href: '/dashboard/locator', hintKey: 'captureShortcuts.locatorHint' },
  { key: 'journal', icon: NotebookPen, labelKey: 'journal.journal', href: '/dashboard/journal', hintKey: 'captureShortcuts.journalHint' },
  { key: 'habits', icon: Repeat, labelKey: 'habits.habits', href: '/dashboard/habits', hintKey: 'captureShortcuts.habitsHint' },
  { key: 'weather', icon: CloudSun, labelKey: 'weather.weather', href: '/dashboard/weather', hintKey: 'captureShortcuts.weatherHint' },
  { key: 'celebrations', icon: Cake, labelKey: 'celebrations.celebrations', href: '/dashboard/celebrations', hintKey: 'captureShortcuts.celebrationsHint' },
  { key: 'announcements', icon: Megaphone, labelKey: 'announcements.announcements', href: '/dashboard/announcements', hintKey: 'captureShortcuts.announcementsHint' },
  { key: 'recipes', icon: ChefHat, labelKey: 'dashboardFood.recipes', href: '/dashboard/recipes', hintKey: 'captureShortcuts.recipesHint' },
  { key: 'todos', icon: ListChecks, labelKey: 'captureShortcuts.todosLabel', href: '/dashboard/todos', hintKey: 'captureShortcuts.todosHint' },
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
  const t = useTranslations();
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
      if (!res.ok) toastError(t('captureShortcuts.saveFailed'));
    }).catch(() => toastError(t('captureShortcuts.saveFailed')));
  }

  return { keys, persist };
}

export function CaptureShortcuts({
  initialKeys, heading: headingProp, columns = 4, onNavigate,
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
  const t = useTranslations();
  const locale = useLocale().code;
  const heading = headingProp ?? t('captureShortcuts.heading');
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

  const countLabel = t('captureShortcuts.countOfLimit', {
    count: keys.length.toLocaleString(locale), max: MAX_CAPTURE_SHORTCUTS.toLocaleString(locale),
  });
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
                ? <><span className="text-muted">{countLabel} ·</span> <Check className="h-3.5 w-3.5" /> {t('captureShortcuts.done')}</>
                : <><Settings2 className="h-3.5 w-3.5" /> {t('captureShortcuts.customize')}</>}
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
          {t('captureShortcuts.emptyWithLimit', { max: MAX_CAPTURE_SHORTCUTS.toLocaleString(locale) })}
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
                  <span className="w-full truncate text-xs font-semibold">{t(s.labelKey)}</span>
                  <span className="text-[10px] text-brand-text">{t('captureShortcuts.tapToChange')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => removeAt(index)}
                  aria-label={t('captureShortcuts.removeNamed', { name: t(s.labelKey) })}
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
              <span className="w-full truncate text-xs font-semibold">{t(s.labelKey)}</span>
              <span className="w-full truncate text-[10px] text-muted">{t(s.hintKey)}</span>
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
            <span className="text-xs font-semibold">{t('captureShortcuts.addShortcut')}</span>
            <span className="text-[10px]">{countLabel}</span>
          </button>
        )}
      </div>

      {/* Picker */}
      {picker && (
        <Modal open title={t(picker.mode === 'replace' ? 'captureShortcuts.changeShortcut' : 'captureShortcuts.addPickerTitle')} onClose={() => setPicker(null)}>
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
                  <span className="text-xs font-semibold">{t(s.labelKey)}</span>
                </button>
              );
            })}
          </div>
        </Modal>
      )}
    </div>
  );
}
