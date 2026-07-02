'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useRef, useEffect } from 'react';
import {
  Mic, Type, Camera, FileText, Sparkles, X, ArrowRight,
  Calendar, CheckSquare, ShoppingCart, Home, HeartPulse, Plane,
  Loader2, ChevronDown, Undo2, Settings2, Check, Plus,
  StickyNote, UtensilsCrossed, Bell, Wallet, PawPrint, Target,
  CreditCard, Users, Image as ImageIcon, GraduationCap, Gift, MessageCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useToast } from '@/components/ui/toast';
import { useApp } from '@/components/app/app-context';
import { Modal } from '@/components/ui/modal';
import { createClient } from '@/lib/supabase/client';
import { saveCapture, undoCapture, type CaptureSaveResult } from '@/lib/capture/save';
import type { CaptureKind } from '@/lib/capture/parse';
import { resolveShortcutKeys, sanitizeShortcutKeys } from '@/lib/capture/shortcuts';
import { saveCaptureShortcutsAction } from '@/app/(app)/capture/shortcuts-actions';

type CaptureMode = 'type' | 'voice' | 'photo' | 'document';

// Routed destinations that we can create directly (the rest just navigate).
const URL_TO_KIND: Record<string, CaptureKind> = {
  '/dashboard/grocery': 'shopping',
  '/dashboard/calendar': 'event',
  '/dashboard/notes': 'note',
  '/dashboard/chores': 'task',
};

// Catalog of "jump directly to" shortcuts. The visible set is customizable per
// device (persisted to localStorage); the catalog is the pool the picker draws
// from. Keys are stable so saved layouts survive label/icon tweaks.
type Shortcut = { key: string; icon: typeof Calendar; label: string; href: string; hint: string };

const SHORTCUT_CATALOG: Shortcut[] = [
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
  { key: 'goals', icon: Target, label: 'Goals', href: '/dashboard/goals', hint: 'Family goal' },
  // 6 additional destinations to fill out the customizable grid.
  { key: 'finances', icon: CreditCard, label: 'Finances', href: '/dashboard/billing', hint: 'Track money' },
  { key: 'contacts', icon: Users, label: 'Contacts', href: '/dashboard/contacts', hint: 'Add contact' },
  { key: 'photos', icon: ImageIcon, label: 'Photos', href: '/dashboard/photos', hint: 'Add photo' },
  { key: 'school', icon: GraduationCap, label: 'School', href: '/dashboard/school', hint: 'School item' },
  { key: 'wishlists', icon: Gift, label: 'Wish Lists', href: '/dashboard/wishlists', hint: 'Add a wish' },
  { key: 'messages', icon: MessageCircle, label: 'Messages', href: '/dashboard/messages', hint: 'Send a message' },
];
const SHORTCUT_BY_KEY: Record<string, Shortcut> = Object.fromEntries(SHORTCUT_CATALOG.map((s) => [s.key, s]));
const CATALOG_KEYS = SHORTCUT_CATALOG.map((s) => s.key);
const DEFAULT_SHORTCUTS = ['calendar', 'tasks', 'grocery', 'home', 'health', 'trip'];
const SHORTCUTS_STORAGE_KEY = 'bubaly.capture.shortcuts';
const MAX_SHORTCUTS = 15;

function routeCapture(text: string): { destination: string; url: string } {
  const lower = text.toLowerCase();
  if (/buy|shop|grocery|groceries|store|milk|eggs|bread|chicken|produce/.test(lower))
    return { destination: 'Grocery List', url: '/dashboard/grocery' };
  if (/event|party|birthday|meeting|appointment|schedule|doctor|dentist|school/.test(lower))
    return { destination: 'Calendar', url: '/dashboard/calendar' };
  if (/meal|recipe|dinner|lunch|breakfast|cook|food/.test(lower))
    return { destination: 'Meals', url: '/dashboard/meals' };
  if (/trip|vacation|travel|flight|hotel|pack/.test(lower))
    return { destination: 'Trip Planner', url: '/dashboard/trips' };
  if (/health|symptom|medicine|medication|sick|pain|fever/.test(lower))
    return { destination: 'Health', url: '/dashboard/health' };
  if (/document|scan|file|pdf|receipt|invoice/.test(lower))
    return { destination: 'Documents', url: '/dashboard/documents' };
  if (/note|remember|idea|thought/.test(lower))
    return { destination: 'Notes', url: '/dashboard/notes' };
  if (/task|todo|remind|chore|clean|fix|repair|do|finish/.test(lower))
    return { destination: 'Tasks & Chores', url: '/dashboard/chores' };
  return { destination: 'AI Assistant', url: `/dashboard/assistant?q=${encodeURIComponent(text)}` };
}

export function CaptureShell({ initialShortcuts = null }: { initialShortcuts?: string[] | null }) {
  const router = useRouter();
  const { error: toastError, success } = useToast();
  const { familyId, userId, selfMember } = useApp();
  const [mode, setMode] = useState<CaptureMode>('type');
  const [text, setText] = useState('');
  const [routing, setRouting] = useState(false);
  const [routed, setRouted] = useState<{ destination: string; url: string } | null>(null);
  const [created, setCreated] = useState<(CaptureSaveResult & { destination: string }) | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [recording, setRecording] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Customizable "jump directly to" shortcuts. Source of truth is Supabase
  // (user_preferences.notification_prefs.captureShortcuts via the server actions)
  // so the layout follows the member across devices; localStorage is an
  // instant/offline cache. Server value (passed from the page) wins on first paint.
  const [shortcutKeys, setShortcutKeys] = useState<string[]>(() =>
    initialShortcuts && initialShortcuts.length
      ? resolveShortcutKeys(initialShortcuts, CATALOG_KEYS, MAX_SHORTCUTS)
      : DEFAULT_SHORTCUTS);
  const [editingShortcuts, setEditingShortcuts] = useState(false);
  const [picker, setPicker] = useState<{ mode: 'add' | 'replace'; index: number } | null>(null);

  useEffect(() => {
    // Server layout is authoritative — mirror it into the localStorage cache.
    if (initialShortcuts && initialShortcuts.length) {
      try { localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(shortcutKeys)); } catch { /* ignore */ }
      return;
    }
    // No saved server layout yet → fall back to the local cache if present.
    try {
      const raw = localStorage.getItem(SHORTCUTS_STORAGE_KEY);
      if (!raw) return;
      const valid = sanitizeShortcutKeys(JSON.parse(raw), CATALOG_KEYS, MAX_SHORTCUTS);
      if (valid.length) setShortcutKeys(valid);
    } catch { /* ignore */ }
    // Run once on mount; shortcutKeys intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function persistShortcuts(keys: string[]) {
    setShortcutKeys(keys);
    try { localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(keys)); } catch { /* ignore */ }
    // Persist to Supabase so the layout syncs across devices.
    void saveCaptureShortcutsAction({ keys }).then((res) => {
      if (!res.ok) toastError(res.error ?? 'Could not save shortcuts');
    });
  }
  function removeShortcut(index: number) { persistShortcuts(shortcutKeys.filter((_, i) => i !== index)); }
  function pickShortcut(key: string) {
    if (!picker) return;
    if (picker.mode === 'replace') persistShortcuts(shortcutKeys.map((k, i) => (i === picker.index ? key : k)));
    else persistShortcuts([...shortcutKeys, key].slice(0, MAX_SHORTCUTS));
    setPicker(null);
  }
  const availableToAdd = SHORTCUT_CATALOG.filter((s) => !shortcutKeys.includes(s.key));
  // Never render more "Add" slots than there are remaining destinations to add.
  const addCardCount = Math.min(Math.max(0, MAX_SHORTCUTS - shortcutKeys.length), availableToAdd.length);

  // One-tap undo: delete the rows the capture just created and restore the input
  // so the user can edit and re-file, or walk away. Frictionless safety net for
  // a mis-routed capture.
  async function undoCreated() {
    if (!created) return;
    setUndoing(true);
    try {
      await undoCapture(createClient(), created.undo);
      const restore = text || created.title;
      success('Undone');
      setCreated(null);
      setText(restore);
      setMode('type');
      textRef.current?.focus();
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Could not undo');
    } finally {
      setUndoing(false);
    }
  }

  function handleInput(value: string) {
    setText(value);
    setRouted(null);
    setCreated(null);
  }

  async function handleSubmit() {
    const value = text.trim();
    if (!value) return;
    setRouting(true);
    const route = routeCapture(value);
    const kind = URL_TO_KIND[route.url];
    // When the routed destination is something we can create directly, capture
    // it for real (with natural-language times / due dates / multi-item lists)
    // instead of just navigating to an empty page.
    if (kind) {
      try {
        const res = await saveCapture(createClient(), { kind, text: value, familyId, userId, memberId: selfMember?.id ?? null });
        setCreated({ ...res, destination: route.destination });
      } catch (err) {
        toastError(err instanceof Error ? err.message : 'Could not save');
      } finally {
        setRouting(false);
      }
      return;
    }
    setRouted(route);
    setRouting(false);
  }

  function goToDestination() {
    if (created) router.push(created.href);
    else if (routed) router.push(routed.url);
  }

  function captureAnother() {
    setCreated(null);
    setText('');
    setMode('type');
    textRef.current?.focus();
  }

  function startVoice() {
    type SpeechResult = { transcript: string };
    type SRCtor = new () => {
      lang: string; interimResults: boolean;
      onresult: ((e: { results: SpeechResult[][] }) => void) | null;
      onerror: (() => void) | null;
      onend: (() => void) | null;
      start: () => void;
    };
    const w = window as unknown as Record<string, unknown>;
    const SR: SRCtor | undefined = (w['SpeechRecognition'] ?? w['webkitSpeechRecognition']) as SRCtor | undefined;
    if (!SR) { toastError('Voice input is not supported in this browser.'); return; }
    const recognition = new SR();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    setRecording(true);
    recognition.onresult = (e) => {
      const transcript = e.results[0]?.[0]?.transcript ?? '';
      setText(transcript);
      setRecording(false);
      setMode('type');
    };
    recognition.onerror = () => { setRecording(false); toastError('Could not capture voice. Try again.'); };
    recognition.onend = () => setRecording(false);
    recognition.start();
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg pb-24 pt-4">
      <div className="mx-auto w-full max-w-lg px-4">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Capture</h1>
            <p className="text-sm text-muted">Speak, type, or snap — AI routes it instantly.</p>
          </div>
          <button type="button" onClick={() => router.back()}
            className="grid h-9 w-9 place-items-center rounded-full bg-elevated text-muted hover:text-fg">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Mode picker */}
        <div className="mb-4 grid grid-cols-4 gap-2">
          {([
            { id: 'type' as const, icon: Type, label: 'Type', action: () => { setMode('type'); textRef.current?.focus(); } },
            { id: 'voice' as const, icon: Mic, label: 'Voice', action: () => { setMode('voice'); startVoice(); } },
            { id: 'photo' as const, icon: Camera, label: 'Photo', action: () => setMode('photo') },
            { id: 'document' as const, icon: FileText, label: 'Scan', action: () => setMode('document') },
          ]).map(({ id, icon: Icon, label, action }) => (
            <button key={id} type="button" onClick={action}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-2xl py-3 text-xs font-semibold transition',
                mode === id ? 'bg-brand/15 text-brand' : 'bg-elevated text-muted hover:bg-elevated/80 hover:text-fg',
              )}>
              <Icon className="h-5 w-5" />
              {label}
            </button>
          ))}
        </div>

        {/* Input area */}
        <div className="relative mb-4 overflow-hidden rounded-2xl border border-border bg-surface/40 focus-within:border-brand/50 focus-within:ring-1 focus-within:ring-brand/30">
          {recording ? (
            <div className="flex min-h-[120px] flex-col items-center justify-center gap-3 p-6">
              <div className="relative">
                <Mic className="h-10 w-10 text-brand" />
                <span className="absolute inset-0 animate-ping rounded-full bg-brand/30" />
              </div>
              <p className="text-sm font-medium text-brand">Listening…</p>
              <button type="button" onClick={() => setRecording(false)} className="text-xs text-muted underline">Cancel</button>
            </div>
          ) : (
            <textarea
              ref={textRef}
              value={text}
              onChange={(e) => handleInput(e.target.value)}
              placeholder={'What\'s on your mind? "Buy milk", "Plan birthday party", "Schedule dentist"…'}
              className="min-h-[120px] w-full resize-none bg-transparent p-4 text-sm outline-none placeholder:text-muted"
              autoFocus={mode === 'type'}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit(); }}
            />
          )}
          {text && !recording && (
            <div className="flex items-center justify-between border-t border-border/60 px-4 py-2">
              <span className="text-xs text-muted">{text.length} chars</span>
              <button type="button" onClick={() => handleInput('')} className="text-xs text-muted hover:text-fg">Clear</button>
            </div>
          )}
        </div>

        {/* Created confirmation */}
        {created ? (
          <div className="mb-4 overflow-hidden rounded-2xl border border-emerald-500/30 bg-emerald-500/5">
            <div className="flex items-center gap-3 p-4">
              <Sparkles className="h-5 w-5 shrink-0 text-emerald-500" />
              <div className="flex-1">
                <p className="text-sm font-semibold">
                  {created.count > 1 ? `Added ${created.count} items` : 'Added'} to <span className="text-emerald-600">{created.destination}</span>
                </p>
                {created.title && <p className="truncate text-xs text-muted">{created.title}</p>}
              </div>
              <button type="button" onClick={undoCreated} disabled={undoing}
                className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-muted hover:bg-elevated hover:text-fg disabled:opacity-60">
                {undoing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />} Undo
              </button>
            </div>
            <div className="flex gap-2 border-t border-emerald-500/20 p-3">
              <button type="button" onClick={goToDestination}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-600/90">
                View in {created.destination} <ArrowRight className="h-4 w-4" />
              </button>
              <button type="button" onClick={captureAnother}
                className="flex items-center gap-1.5 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-elevated">
                Capture another
              </button>
            </div>
          </div>
        ) : routed ? (
          <div className="mb-4 overflow-hidden rounded-2xl border border-brand/30 bg-brand/5">
            <div className="flex items-center gap-3 p-4">
              <Sparkles className="h-5 w-5 shrink-0 text-brand" />
              <div className="flex-1">
                <p className="text-sm font-semibold">Sending to <span className="text-brand">{routed.destination}</span></p>
                <p className="text-xs text-muted">AI matched your input to the best destination.</p>
              </div>
            </div>
            <div className="flex gap-2 border-t border-brand/20 p-3">
              <button type="button" onClick={goToDestination}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand/90">
                Go to {routed.destination} <ArrowRight className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => setRouted(null)}
                className="flex items-center gap-1.5 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-elevated">
                <ChevronDown className="h-4 w-4" /> Change
              </button>
            </div>
          </div>
        ) : (
          <button type="button" disabled={!text.trim() || routing} onClick={handleSubmit}
            className="mb-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand py-4 text-sm font-bold text-white transition hover:bg-brand/90 disabled:opacity-40">
            {routing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />}
            {routing ? 'Capturing…' : 'Capture with AI'}
          </button>
        )}

        {/* Quick route shortcuts — customizable */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Or jump directly to</p>
            <button type="button" onClick={() => setEditingShortcuts((v) => !v)}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-brand hover:bg-brand/10 transition">
              {editingShortcuts ? <><Check className="h-3.5 w-3.5" /> Done</> : <><Settings2 className="h-3.5 w-3.5" /> Customize</>}
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {shortcutKeys.map((key, index) => {
              const s = SHORTCUT_BY_KEY[key];
              if (!s) return null;
              const Icon = s.icon;
              if (editingShortcuts) {
                return (
                  <div key={key} className="relative">
                    <button type="button" onClick={() => setPicker({ mode: 'replace', index })}
                      className="flex w-full flex-col items-center gap-1.5 rounded-2xl border border-brand/30 bg-brand/5 p-3 text-center transition hover:bg-brand/10">
                      <Icon className="h-6 w-6 text-brand" />
                      <span className="text-xs font-semibold">{s.label}</span>
                      <span className="text-[10px] text-brand">Tap to change</span>
                    </button>
                    <button type="button" onClick={() => removeShortcut(index)} aria-label={`Remove ${s.label}`}
                      className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-danger text-white shadow">
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              }
              return (
                <Link key={key} href={s.href}
                  className="flex flex-col items-center gap-1.5 rounded-2xl border border-border bg-surface/40 p-3 text-center transition hover:border-brand/30 hover:bg-elevated">
                  <Icon className="h-6 w-6 text-brand" />
                  <span className="text-xs font-semibold">{s.label}</span>
                  <span className="text-[10px] text-muted">{s.hint}</span>
                </Link>
              );
            })}

            {/* Add-shortcut cards fill the grid up to the max */}
            {availableToAdd.length > 0 && Array.from({ length: addCardCount }).map((_, i) => (
              <button key={`add-${i}`} type="button" onClick={() => setPicker({ mode: 'add', index: shortcutKeys.length })}
                className="flex flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-border p-3 text-center text-muted transition hover:border-brand/40 hover:text-brand">
                <Plus className="h-6 w-6" />
                <span className="text-xs font-semibold">Add</span>
                <span className="text-[10px]">Add shortcut</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Shortcut picker */}
      {picker && (
        <Modal open title={picker.mode === 'replace' ? 'Change shortcut' : 'Add a shortcut'} onClose={() => setPicker(null)}>
          <div className="grid grid-cols-3 gap-2">
            {(picker.mode === 'replace'
              ? SHORTCUT_CATALOG.filter((s) => !shortcutKeys.includes(s.key) || s.key === shortcutKeys[picker.index])
              : availableToAdd
            ).map((s) => {
              const Icon = s.icon;
              const isCurrent = picker.mode === 'replace' && s.key === shortcutKeys[picker.index];
              return (
                <button key={s.key} type="button" onClick={() => pickShortcut(s.key)}
                  className={cn('flex flex-col items-center gap-1.5 rounded-2xl border p-3 text-center transition',
                    isCurrent ? 'border-brand bg-brand/10' : 'border-border bg-surface/40 hover:border-brand/40 hover:bg-elevated')}>
                  <Icon className="h-6 w-6 text-brand" />
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
