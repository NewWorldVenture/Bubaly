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

/** What `Field` wires onto the control it labels. */
export type FieldControlProps = {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  'aria-required'?: true;
};

/**
 * The element types `Field` will wire itself onto.
 *
 * An allowlist rather than "any element", because ~19 call sites hand back a
 * `<div>` wrapping a group of chips or radios. Putting `aria-describedby` on a
 * div announces nothing, and a fix that silently lands there would LOOK
 * universal while doing nothing — which is the failure this audit keeps
 * finding. Those sites are named in
 * tests/a-hint-nobody-hears-is-not-a-hint.test.ts and shrink from there.
 */
const WIRABLE: ReadonlySet<unknown> = new Set<unknown>([
  Input, Select, Textarea, 'input', 'select', 'textarea',
]);

/**
 * Put the field's a11y props on the control, without overwriting anything the
 * call site set for itself.
 */
function wire(node: React.ReactNode, control: FieldControlProps): React.ReactNode {
  if (!isValidElement(node) || !WIRABLE.has(node.type)) return node;
  const own = node.props as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(control)) {
    if (value !== undefined && own[key] === undefined) patch[key] = value;
  }
  return Object.keys(patch).length ? cloneElement(node, patch) : node;
}

/**
 * Labelled field wrapper with optional hint and error.
 *
 * It used to describe itself as "fully accessible" while rendering three of its
 * four affordances as pictures only:
 *
 *   - `hint` was a `<p>` with no id and nothing pointing at it, so a screen
 *     reader never read it;
 *   - `error` was a `<p role="alert">` with no id and no `aria-invalid` on the
 *     control, so the message was announced once as it appeared and the field
 *     itself was never announced as invalid — tab back to it and you are told
 *     nothing is wrong;
 *   - `required` was a red asterisk, announced as "star" or skipped entirely.
 *
 * All three now reach the control. The a11y props are handed to the render prop
 * as a second argument for call sites that build their own markup, AND wired on
 * directly for the ~925 of 1,066 sites that hand back the control itself — so
 * this is one change rather than a thousand.
 *
 * `aria-required` rather than the native `required` attribute, deliberately:
 * native `required` changes form SUBMISSION, and switching it on across a
 * thousand fields that were only ever marked with an asterisk would start
 * blocking submits that work today. Announcing the requirement is the a11y fix;
 * enforcing it is a product decision per form.
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
  children: (id: string, control: FieldControlProps) => React.ReactNode;
}) {
  const id = useId();
  const hintId = `${id}hint`;
  const errorId = `${id}error`;
  // The hint is hidden while an error shows (it always was, visually), so it
  // must not be described either — a description pointing at an element that is
  // not rendered is worse than none.
  const showHint = Boolean(hint) && !error;
  const describedBy = [showHint ? hintId : null, error ? errorId : null]
    .filter(Boolean).join(' ') || undefined;

  const control: FieldControlProps = {
    id,
    'aria-describedby': describedBy,
    'aria-invalid': error ? true : undefined,
    'aria-required': required ? true : undefined,
  };

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
        {required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
      </label>
      {wire(children(id, control), control)}
      {showHint && <p id={hintId} className="text-xs text-muted">{hint}</p>}
      {error && (
        <p id={errorId} className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
