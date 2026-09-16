'use client';

import { useId } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useDialogBehavior } from '@/lib/hooks/use-dialog-behavior';
import { useTranslations } from '@/components/i18n/locale-provider';

/** Accessible modal dialog: focus-trapped, ESC to close, scroll lock, and focus
 *  restored to the trigger on close. Renders as a bottom sheet on mobile.
 *
 *  The dialog BEHAVIOUR lives in `useDialogBehavior` (lib/hooks/use-dialog-behavior.ts)
 *  so the full-screen overlays that deliberately do not use this component — the
 *  photo lightbox is full-bleed black chrome rather than a titled panel — get it
 *  from the same definition. This file owns the markup and the mobile layout;
 *  the hook owns focus, Escape, the Tab trap and the scroll lock. */
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
  const dialogRef = useDialogBehavior<HTMLDivElement>(open, onClose);
  const titleId = useId();
  const descId = useId();

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
