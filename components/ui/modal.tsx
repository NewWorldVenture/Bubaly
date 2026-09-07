'use client';

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Accessible modal dialog: focus-trapped, ESC to close, scroll lock, and focus
 *  restored to the trigger on close. Renders as a bottom sheet on mobile. */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className,
  headerAction,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  /** Optional control rendered in the header, just left of the close button. */
  headerAction?: React.ReactNode;
}) {
  const t = useTranslations();
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    // Remember what had focus so we can return to it on close (VoiceOver/TalkBack
    // + keyboard users land back where they were, per WAI-ARIA dialog practice).
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Move focus into the dialog (first focusable control, else the panel).
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .filter((el) => el.offsetParent !== null || el === dialog);
    (focusables()[0] ?? dialog)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab' || !dialog) return;
      // Trap Tab within the dialog.
      const items = focusables();
      if (items.length === 0) { e.preventDefault(); dialog.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey && (active === first || !dialog.contains(active))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault(); first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div
        className="overlay-scrim absolute inset-0 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          // On mobile this is a bottom sheet (items-end): pad the bottom by the
          // safe-area inset so the action row never hides under the home
          // indicator / browser chrome. Desktop keeps even padding.
          'relative z-10 w-full max-w-lg popover-surface max-h-[85dvh] sm:max-h-[92dvh] overflow-y-auto rounded-b-none rounded-t-3xl px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6 animate-slide-up sm:animate-fade-in sm:rounded-3xl outline-none',
          className,
        )}
      >
        <div className="mb-3 flex items-start justify-between gap-3 sm:mb-4 sm:gap-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold tracking-tight sm:text-lg">{title}</h2>
            {description && <p id={descId} className="mt-1 text-xs text-muted sm:text-sm">{description}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerAction}
            <button
              onClick={onClose}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted hover:bg-elevated hover:text-fg focus-ring"
              aria-label={t('modal.closeDialog')}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
