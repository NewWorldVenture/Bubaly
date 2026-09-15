'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useTranslations } from '@/components/i18n/locale-provider';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

type ToastTone = 'success' | 'error' | 'info';
/** Optional one-tap action shown in the toast, e.g. "Undo". */
export type ToastAction = { label: string; onClick: () => void };
type Toast = { id: number; tone: ToastTone; message: string; action?: ToastAction };

type ToastApi = {
  toast: (message: string, tone?: ToastTone, action?: ToastAction) => void;
  success: (message: string, action?: ToastAction) => void;
  error: (message: string, action?: ToastAction) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

const ICONS = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
} as const;

/** Native haptic tap alongside a toast (Capacitor shell only; web no-ops).
 *  Toasts fire exactly on the app's key actions, so this one hook gives every
 *  save/approve/error a physical acknowledgment without per-module wiring. */
function hapticFor(tone: ToastTone) {
  void (async () => {
    try {
      const { Capacitor } = await import('@capacitor/core');
      if (!Capacitor.isNativePlatform()) return;
      const { Haptics, NotificationType } = await import('@capacitor/haptics');
      if (tone === 'info') return;
      await Haptics.notification({ type: tone === 'success' ? NotificationType.Success : NotificationType.Error });
    } catch {
      // No haptics engine — silence is fine.
    }
  })();
}

/** How long a toast stays, by whether it carries an action to take.
 *  Exported so the guard test asserts against the real window rather than a
 *  copy of these numbers that can drift away from them. */
export const LIFETIME = { action: 7000, plain: 4200 } as const;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const tr = useTranslations();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  // The pending dismissal for each toast, so it can be PAUSED.
  //
  // WCAG 2.2.1 (Timing Adjustable): a time limit on content has to be
  // pausable, extendable or turn-off-able. This had none of the three — the
  // timer id was discarded at creation, so nothing could reach it. For an
  // ordinary toast that is a nuisance; for the three that carry "Undo" it is
  // the ONLY path back from a write that already happened (quick-capture, the
  // ⌘K bar, and voice capture all call undoCapture from here and nowhere
  // else), and the toast is rendered after {children}, so reaching that button
  // by keyboard means tabbing past the entire rest of the page first — inside
  // seven seconds.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const pending = timers.current.get(id);
    if (pending) clearTimeout(pending);
    timers.current.delete(id);
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const schedule = useCallback((id: number, ms: number) => {
    const pending = timers.current.get(id);
    if (pending) clearTimeout(pending);
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id);
      setToasts((t) => t.filter((x) => x.id !== id));
    }, ms));
  }, []);

  /** Hold every toast open while the stack is hovered or holds focus. */
  const pauseAll = useCallback(() => {
    for (const pending of timers.current.values()) clearTimeout(pending);
    timers.current.clear();
  }, []);

  /** Give each one a FULL window back, not the remainder: someone who paused to
   *  read or to tab towards Undo needs time to act, not the 300ms they had
   *  left. */
  const resumeAll = useCallback(() => {
    setToasts((current) => {
      for (const t of current) schedule(t.id, t.action ? LIFETIME.action : LIFETIME.plain);
      return current;
    });
  }, [schedule]);

  const push = useCallback((message: string, tone: ToastTone = 'info', action?: ToastAction) => {
    const id = ++counter.current;
    hapticFor(tone);
    setToasts((t) => [...t, { id, tone, message, action }]);
    // Actionable toasts linger a little longer so there's time to tap them.
    schedule(id, action ? LIFETIME.action : LIFETIME.plain);
  }, [schedule]);

  // Memoised, so the context value keeps its identity across the re-render that
  // showing a toast causes. Without this every toast handed all consumers a new
  // `toast`/`success`/`error`, and any consumer that used one as an effect
  // dependency re-ran that effect on every toast.
  const api = useMemo<ToastApi>(() => ({
    toast: push,
    success: (m, action) => push(m, 'success', action),
    error: (m, action) => push(m, 'error', action),
  }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Above the mobile bottom tab bar (4rem, visible until lg) + home indicator;
          only drops to bottom-6 once the bar is gone (M-033). */}
      {/* Pause on hover AND on focus. Focus is the half that matters for the
          keyboard user this is meant to help: `onFocusCapture` fires as the
          focus lands anywhere inside the stack, including on the Undo button
          they were tabbing towards, and the countdown stops there. */}
      <div
        onMouseEnter={pauseAll}
        onMouseLeave={resumeAll}
        onFocusCapture={pauseAll}
        onBlurCapture={resumeAll}
        className="pointer-events-none fixed inset-x-0 bottom-[calc(5rem+var(--safe-bottom))] z-[100] flex flex-col items-center gap-2 px-4 lg:bottom-6"
      >
        {toasts.map((t) => {
          const Icon = ICONS[t.tone];
          return (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : 'status'}
              aria-live={t.tone === 'error' ? 'assertive' : 'polite'}
              className={cn(
                'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl popover-surface px-4 py-3 text-sm shadow-glass animate-fade-in',
                t.tone === 'success' && 'border-success/30',
                t.tone === 'error' && 'border-danger/30',
              )}
            >
              <Icon
                className={cn(
                  'mt-0.5 h-5 w-5 shrink-0',
                  t.tone === 'success' && 'text-success',
                  t.tone === 'error' && 'text-danger',
                  t.tone === 'info' && 'text-brand-text',
                )}
              />
              <span className="flex-1">{t.message}</span>
              {t.action && (
                <button
                  onClick={() => { t.action!.onClick(); dismiss(t.id); }}
                  className="shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold text-brand-text hover:bg-brand/10"
                >
                  {t.action.label}
                </button>
              )}
              <button
                onClick={() => dismiss(t.id)}
                className="text-muted hover:text-fg"
                aria-label={tr('toast.dismiss')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
