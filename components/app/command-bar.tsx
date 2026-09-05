'use client';

// Universal ⌘K command bar (Friction Backlog #2). A global natural-language
// entry point on every screen: type anything and Enter routes it —
//   • a page name → jump there              (NAV_CATALOG fuzzy match)
//   • "remind me to…", "add milk…"          → capture a real row (saveCapture)
//   • anything else                         → ask Bubaly (POST /api/ai/requests)
// Reuses the exact ranking (lib/command-bar/route) + capture engine Voice
// Control uses, so there's one parser, not three. The router's assistant
// fallback is presented here as a `request`: the concierge files it with the
// page the person is on as context and lands them on the run page, or shows
// the answer as a toast. Opens on ⌘K / Ctrl+K (and a "/" press when nothing
// is focused); Esc/scrim closes; ↑/↓ + Enter navigate.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
import { Search, CornerDownLeft, Compass, Sparkles, ListPlus, Wand2 } from 'lucide-react';
import { useApp } from './app-context';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { describeDbError } from '@/lib/supabase/errors';
import { saveCapture, undoCapture } from '@/lib/capture/save';
import { NAV_CATALOG } from '@/lib/constants/navigation';
import { routeCommand, type CommandResult } from '@/lib/command-bar/route';
import { submitAIRequest } from '@/lib/ai/chat-request';
import { moduleFromPathname } from '@/lib/concierge/suggested-prompts';
import { useLockBodyScroll } from '@/lib/hooks/use-lock-body-scroll';

const NAV_ITEMS = NAV_CATALOG.map((n) => ({ href: n.href, label: n.label }));

/** The router's results plus the concierge request the bar offers in place of the assistant hand-off. */
export type CommandBarResult = Exclude<CommandResult, { kind: 'assistant' }> | { kind: 'request'; text: string; label: string };

/** Navigation, captures and reasoning intents pass through untouched; the assistant fallback becomes a request. */
export function toCommandBarResults(results: CommandResult[]): CommandBarResult[] {
  return results.map((r) => (r.kind === 'assistant' ? { kind: 'request', text: r.query, label: `Ask Bubaly: “${r.query}”` } : r));
}

/** How much of an inline answer fits in a toast before the run page is the better place. */
const TOAST_ANSWER_CHARS = 160;

export function CommandBar() {
  const router = useRouter();
  const pathname = usePathname();
  const { familyId, userId, selfMember } = useApp();
  const { success, error: toastError, toast } = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => (open ? toCommandBarResults(routeCommand(query, NAV_ITEMS)) : []), [open, query]);

  // Lock the page behind the command palette so mobile touch-scroll stays in the
  // overlay instead of dragging the underlying page.
  useLockBodyScroll(open);

  // Global open shortcut: ⌘K / Ctrl+K anywhere; "/" only when not already typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === 'k') { e.preventDefault(); setOpen((v) => !v); return; }
      if (e.key === '/' && !open) {
        const el = document.activeElement as HTMLElement | null;
        const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
        if (!typing) { e.preventDefault(); setOpen(true); }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => { if (open) { setQuery(''); setActive(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  useEffect(() => { setActive(0); }, [query]);

  const run = useCallback(async (r: CommandBarResult | undefined) => {
    if (!r || busy) return;
    if (r.kind === 'navigate' || r.kind === 'intent') { setOpen(false); router.push(r.href); return; }
    if (r.kind === 'request') {
      // Ask Bubaly: the page the person is on is the request's context.
      setBusy(true);
      try {
        const moduleName = moduleFromPathname(pathname);
        const result = await submitAIRequest({ text: r.text, context: moduleName ? { module: moduleName } : null });
        if (!result.ok) { toastError(result.error); return; }
        setOpen(false);
        const data = result.data;
        if (data.redirect) {
          success(data.outcome === 'clarification' ? 'Bubaly has a question for you.' : 'Bubaly is on it.');
          router.push(data.redirect);
        } else if (data.summary.length <= TOAST_ANSWER_CHARS) {
          toast(data.summary, 'info');
        } else {
          // Long answers deserve a page; the assistant view shows the same request.
          toast(`${data.summary.slice(0, TOAST_ANSWER_CHARS).trimEnd()}…`, 'info');
        }
      } finally {
        setBusy(false);
      }
      return;
    }
    // capture → write a real row, with Undo (saveCapture returns the result or throws)
    setBusy(true);
    try {
      const res = await saveCapture(createClient(), { kind: r.captureKind, text: r.text, familyId, userId, memberId: selfMember?.id ?? null });
      setOpen(false);
      success(
        res.count > 1 ? `${res.count} items added` : r.label,
        { label: 'Undo', onClick: () => { void undoCapture(createClient(), res.undo).then(() => success('Undone')).catch(() => toastError('Could not undo')); } },
      );
    } catch (err) {
      toastError(describeDbError(err, 'Could not save that.'));
    } finally {
      setBusy(false);
    }
  }, [busy, router, pathname, familyId, userId, selfMember, success, toast, toastError]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); void run(results[active]); }
  }

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-start justify-center p-4 pt-[12vh]">
      <div className="overlay-scrim absolute inset-0 backdrop-blur-sm animate-fade-in" onClick={() => setOpen(false)} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command bar"
        className="relative z-10 w-full max-w-xl overflow-hidden rounded-2xl popover-surface shadow-glass animate-fade-in"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search, add a task, or ask anything…"
            aria-label="Command input"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted"
          />
          <kbd className="hidden shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted sm:block">esc</kbd>
        </div>

        {query.trim() === '' ? (
          <p className="px-4 py-6 text-center text-xs text-muted">
            Jump to a page, capture a task/note/event, or ask Bubaly. Try “plan our week”, “remind me to…”, “add milk to the list”, or a page name.
          </p>
        ) : (
          <ul className="max-h-[52vh] overflow-y-auto py-1">
            {results.map((r, i) => {
              const Icon = r.kind === 'navigate' ? Compass : r.kind === 'request' ? Sparkles : r.kind === 'intent' ? Wand2 : ListPlus;
              return (
                <li key={`${r.kind}-${i}`}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => void run(r)}
                    disabled={busy}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm ${i === active ? 'bg-elevated' : ''}`}
                  >
                    <Icon className={`h-4 w-4 shrink-0 ${r.kind === 'request' || r.kind === 'intent' ? 'text-brand-text' : 'text-muted'}`} />
                    <span className="min-w-0 flex-1 truncate">{r.label}</span>
                    {i === active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
