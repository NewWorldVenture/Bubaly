'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { useTranslations } from '@/components/i18n/locale-provider';

/** What to ask, and what the two buttons say. */
export type ConfirmRequest = {
  /** The question itself — "Delete this insurance policy?". Already localised. */
  title: string;
  /** What is lost and whether it comes back. Already localised. */
  body?: string;
  /** The word on the button that proceeds. Defaults to a generic "Confirm". */
  confirmLabel?: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /** Paints the proceed button red. Default true — every caller so far deletes. */
  destructive?: boolean;
};

export type Confirm = (request: ConfirmRequest) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

// Outside the provider we still ASK — we just ask in the browser's own dialog.
// That is the deliberate difference from useToast(), which throws: the property
// this primitive exists to hold is that a destructive click asks first, and a
// forgotten provider should cost the styling, not the question. Returning false
// instead would be worse than either — every delete button in that subtree would
// become a silent no-op that reports success.
const fallbackConfirm: Confirm = async (request) =>
  typeof window === 'undefined'
    ? false
    : window.confirm([request.title, request.body].filter(Boolean).join('\n\n'));

/**
 * Ask before destroying something.
 *
 * Returns a promise that settles TRUE only if the person chose the proceed
 * button. It never rejects, and every other exit — Cancel, Escape, the scrim,
 * the close X — settles false, so the whole guard a caller needs is:
 *
 *     if (!(await confirm({ title: t('...') }))) return;
 */
export function useConfirm(): Confirm {
  return useContext(ConfirmContext) ?? fallbackConfirm;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations();
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setRequest(null);
    resolve?.(ok);
  }, []);

  const confirm = useCallback<Confirm>((next) => {
    // A second request arriving while one is open would strand the first
    // promise forever, and a handler awaiting a promise that never settles is a
    // handler that never returns. Settle the outgoing one as a decline first.
    resolver.current?.(false);
    resolver.current = null;
    setRequest(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={request !== null}
        onClose={() => settle(false)}
        title={request?.title ?? ''}
        description={request?.body}
        className="sm:max-w-md"
      >
        {/* Cancel comes first in the DOM so that neither the Modal's initial
            focus (its close X) nor the first Tab after it lands on the red one. */}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => settle(false)}>
            {request?.cancelLabel ?? t('confirm.cancel')}
          </Button>
          <Button
            variant={request?.destructive === false ? 'primary' : 'danger'}
            onClick={() => settle(true)}
          >
            {request?.confirmLabel ?? t('confirm.confirm')}
          </Button>
        </div>
      </Modal>
    </ConfirmContext.Provider>
  );
}
