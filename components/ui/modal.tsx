'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/** Accessible modal dialog: focus-trapped backdrop, ESC to close, scroll lock. */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
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
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'relative z-10 w-full max-w-lg glass-card max-h-[85dvh] sm:max-h-[92dvh] overflow-y-auto rounded-b-none rounded-t-3xl p-4 sm:p-6 animate-slide-up sm:animate-fade-in sm:rounded-3xl',
          className,
        )}
      >
        <div className="mb-3 flex items-start justify-between gap-3 sm:mb-4 sm:gap-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight sm:text-lg">{title}</h2>
            {description && <p className="mt-1 text-xs text-muted sm:text-sm">{description}</p>}
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-muted hover:bg-elevated hover:text-fg focus-ring"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
