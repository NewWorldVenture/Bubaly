import { cloneElement, forwardRef, isValidElement, useId } from 'react';
import { cn } from '@/lib/utils/cn';

const base =
  'w-full rounded-xl bg-surface/60 border border-border px-3 sm:px-4 text-fg text-sm sm:text-base placeholder:text-muted transition focus-ring disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(base, 'h-11', className)} {...props} />
  ),
);
Input.displayName = 'Input';

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(base, 'min-h-[6rem] py-3', className)} {...props} />
));
Textarea.displayName = 'Textarea';

export const Select = forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn(base, 'h-11 appearance-none pr-10', className)} {...props} />
));
Select.displayName = 'Select';

/**
 * Labelled field wrapper with optional error + hint.
 *
 * Its own comment used to say "fully accessible" and it was not. The error was
 * rendered with `role="alert"`, so it is ANNOUNCED ONCE when it appears — and then
 * the control itself reported nothing. A user who tabs back to the field
 * afterwards, or who arrives at it from anywhere other than the moment the error
 * appeared, is told the field is fine. WCAG 3.3.1 asks the field to identify
 * itself as in error, not only for a message to exist somewhere near it.
 *
 * The control now carries `aria-invalid` and an `aria-describedby` pointing at the
 * message (or the hint when there is no error) — applied CENTRALLY by cloning the
 * render-prop's element, so all 124 call sites are fixed without touching one of
 * them. A call site that wants to set either itself still wins: an explicit value
 * on the child is never overwritten. A render prop returning something other than
 * a single element (a fragment, a conditional pair) is left exactly as it was
 * rather than guessed at, and the second argument is there for those.
 */
export function Field({
  label,
  error,
  hint,
  children,
  required,
}: {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: (id: string, aria: FieldAria) => React.ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const aria: FieldAria = {
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errorId : hint ? hintId : undefined,
  };
  const control = children(id, aria);
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </label>
      {isValidElement(control)
        ? cloneElement(control as React.ReactElement<FieldAria>, {
            // Never clobber a call site that set either itself.
            'aria-invalid': (control.props as FieldAria)['aria-invalid'] ?? aria['aria-invalid'],
            'aria-describedby': (control.props as FieldAria)['aria-describedby'] ?? aria['aria-describedby'],
          })
        : control}
      {hint && !error && <p id={hintId} className="text-xs text-muted">{hint}</p>}
      {error && (
        <p id={errorId} className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** What a control needs to report its own state, for a render prop that wants it. */
export type FieldAria = {
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
};
