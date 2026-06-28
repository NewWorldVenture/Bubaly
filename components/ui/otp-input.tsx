'use client';

// Six separate single-digit boxes for an SMS/PIN one-time code — the segmented
// input from the verification-code mockup (one box per digit), replacing a single
// combined field. Controlled: the parent owns the digit string; this component
// handles focus advance/retreat, paste of a full code, and arrow navigation.
import { useRef, type KeyboardEvent, type ClipboardEvent } from 'react';
import { cn } from '@/lib/utils/cn';

export function OtpInput({
  value,
  onChange,
  length = 6,
  autoFocus = false,
  disabled = false,
  onComplete,
  ariaLabel = 'Verification code',
}: {
  value: string;
  onChange: (next: string) => void;
  length?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  onComplete?: (code: string) => void;
  ariaLabel?: string;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = value.split('').slice(0, length);

  function focus(i: number) {
    const el = refs.current[Math.max(0, Math.min(length - 1, i))];
    el?.focus();
    el?.select();
  }

  function setAt(index: number, digit: string) {
    const arr = value.split('');
    arr[index] = digit;
    const next = arr.join('').replace(/\D/g, '').slice(0, length);
    onChange(next);
    return next;
  }

  function handleChange(index: number, raw: string) {
    const d = raw.replace(/\D/g, '');
    if (!d) return;
    // Typing into a box (or autofill dropping several digits) fills forward.
    if (d.length > 1) {
      const next = (value.slice(0, index) + d).replace(/\D/g, '').slice(0, length);
      onChange(next);
      focus(next.length >= length ? length - 1 : next.length);
      if (next.length === length) onComplete?.(next);
      return;
    }
    const next = setAt(index, d);
    if (index < length - 1) focus(index + 1);
    if (next.length === length) onComplete?.(next);
  }

  function handleKeyDown(index: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (digits[index]) {
        setAt(index, '');
      } else if (index > 0) {
        setAt(index - 1, '');
        focus(index - 1);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focus(index - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      focus(index + 1);
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (!pasted) return;
    onChange(pasted);
    focus(pasted.length >= length ? length - 1 : pasted.length);
    if (pasted.length === length) onComplete?.(pasted);
  }

  return (
    <div className="flex items-center justify-center gap-2 sm:gap-3" role="group" aria-label={ariaLabel}>
      {Array.from({ length }, (_, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          value={digits[i] ?? ''}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          onFocus={(e) => e.target.select()}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          disabled={disabled}
          autoFocus={autoFocus && i === 0}
          aria-label={`Digit ${i + 1}`}
          className={cn(
            'h-14 w-12 rounded-xl border bg-bg text-center text-2xl font-semibold transition focus-ring',
            'disabled:opacity-50',
            digits[i] ? 'border-brand' : 'border-border',
          )}
        />
      ))}
    </div>
  );
}
