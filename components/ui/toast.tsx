'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';
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

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const push = useCallback((message: string, tone: ToastTone = 'info', action?: ToastAction) => {
    const id = ++counter.current;
    hapticFor(tone);
    setToasts((t) => [...t, { id, tone, message, action }]);
    // Actionable toasts linger a little longer so there's time to tap them.
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 7000 : 4200);
  }, []);

  const api: ToastApi = {
    toast: push,
    success: (m, action) => push(m, 'success', action),
    error: (m, action) => push(m, 'error', action),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Above the mobile bottom tab bar (4rem, visible until lg) + home indicator;
          only drops to bottom-6 once the bar is gone (M-033). */}
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(5rem+var(--safe-bottom))] z-[100] flex flex-col items-center gap-2 px-4 lg:bottom-6">
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
                  onClick={() => { t.action!.onClick(); setToasts((arr) => arr.filter((x) => x.id !== t.id)); }}
                  className="shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold text-brand-text hover:bg-brand/10"
                >
                  {t.action.label}
                </button>
              )}
              <button
                onClick={() => setToasts((arr) => arr.filter((x) => x.id !== t.id))}
                className="text-muted hover:text-fg"
                aria-label="Dismiss"
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
