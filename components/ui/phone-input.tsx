'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import {
  COUNTRY_DIAL_CODES,
  guessCountryDialCode,
  type CountryDialCode,
} from '@/lib/utils/phone';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

interface PhoneInputProps {
  /** ISO country code for the pre-selected dial code, e.g. "US" */
  defaultCountryCode?: string;
  /** Pre-filled dial code e.g. "+1" — takes precedence over defaultCountryCode */
  defaultDialCode?: string;
  /** Pre-filled local number (without the dial code) */
  defaultLocalNumber?: string;
  /** Called whenever the E.164 value or dial code changes */
  onChange?: (e164: string, dialCode: string, countryCode: string) => void;
  className?: string;
}

export function PhoneInput({
  defaultCountryCode,
  defaultDialCode,
  defaultLocalNumber = '',
  onChange,
  className,
}: PhoneInputProps) {
  const tr = useTranslations();
  const [country, setCountry] = useState<CountryDialCode>(() => {
    if (defaultDialCode) {
      const match = COUNTRY_DIAL_CODES.find(
        (c) => c.dialCode === defaultDialCode && (!defaultCountryCode || c.code === defaultCountryCode),
      );
      return match ?? COUNTRY_DIAL_CODES.find((c) => c.dialCode === defaultDialCode) ?? COUNTRY_DIAL_CODES[0];
    }
    if (defaultCountryCode) {
      return COUNTRY_DIAL_CODES.find((c) => c.code === defaultCountryCode) ?? COUNTRY_DIAL_CODES[0];
    }
    const dc = guessCountryDialCode();
    return COUNTRY_DIAL_CODES.find((c) => c.dialCode === dc) ?? COUNTRY_DIAL_CODES[0];
  });

  const [localNumber, setLocalNumber] = useState(defaultLocalNumber);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const filtered = query
    ? COUNTRY_DIAL_CODES.filter(
        (c) =>
          c.name.toLowerCase().includes(query.toLowerCase()) ||
          c.dialCode.includes(query) ||
          c.code.toLowerCase().includes(query.toLowerCase()),
      )
    : COUNTRY_DIAL_CODES;

  const digits = localNumber.replace(/\D/g, '');
  const e164 = digits ? `${country.dialCode}${digits}` : '';

  useEffect(() => {
    onChange?.(e164, country.dialCode, country.code);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e164, country.dialCode, country.code]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      // The button toggles the list itself; counting it as outside would close the list on mousedown and reopen it on click.
      if (panelRef.current && !panelRef.current.contains(e.target as Node) && !triggerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  // Auto-focus the search field when the dropdown opens
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => searchRef.current?.focus(), 40);
      return () => clearTimeout(t);
    }
  }, [open]);

  /** Close the list and hand focus back to the button that opened it, so a keyboard user is not left on <body>. */
  function close() {
    setOpen(false);
    setQuery('');
    triggerRef.current?.focus();
  }

  function selectCountry(c: CountryDialCode) {
    setCountry(c);
    close();
  }

  return (
    <div className={cn('relative', className)}>
      {/* Hidden inputs so the form's onSubmit can read these values */}
      <input type="hidden" name="phone" value={e164} />
      <input type="hidden" name="dialCode" value={country.dialCode} />
      <input type="hidden" name="countryCode" value={country.code} />

      {/* Unified input wrapper — handles the shared focus ring */}
      <div className="flex h-11 overflow-hidden rounded-xl border border-border bg-surface/60 transition focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/30">
        {/* Dial-code picker button */}
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listId : undefined}
          aria-label={tr('phoneAuth.countryLabel', { name: country.name })}
          className="flex shrink-0 items-center gap-1.5 border-r border-border bg-elevated px-3 transition hover:bg-elevated/80"
        >
          <span className="text-base leading-none" aria-hidden>{country.flag}</span>
          <span className="text-xs font-medium text-fg">{country.dialCode}</span>
          <ChevronDown
            className={cn('h-3 w-3 text-muted transition-transform duration-150', open && 'rotate-180')}
          />
        </button>

        {/* Local number */}
        <input
          type="tel"
          inputMode="tel"
          value={localNumber}
          onChange={(e) => setLocalNumber(e.target.value)}
          placeholder={country.format}
          className="flex-1 bg-transparent px-3 text-sm text-fg placeholder:text-muted outline-none"
          aria-label={tr('phoneInput.phoneNumber')}
        />
      </div>

      {/* Dropdown */}
      {open && (
        // The panel holds the search field and the list; only the list is the listbox. Escape closes it here
        // rather than letting it reach a dialog the field sits in.
        <div
          ref={panelRef}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}
          className="absolute top-full left-0 z-50 mt-1 w-72 rounded-xl border border-border bg-surface shadow-glass"
        >
          {/* Search */}
          <div className="flex items-center gap-2 border-b border-border px-3 py-2.5 focus-within:ring-2 focus-within:ring-inset focus-within:ring-brand">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted" />
            <input
              ref={searchRef}
              type="text"
              placeholder={tr('phoneInput.searchCountryOrCode')}
              aria-label={tr('phoneInput.searchCountryOrCode')}
              aria-controls={listId}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            />
          </div>

          {/* Country list */}
          {filtered.length > 0 && <ul id={listId} role="listbox" aria-label={tr('phoneInput.selectCountry')} className="max-h-52 overflow-y-auto py-1">
            {filtered.map((c) => {
              const active = c.code === country.code;
              return (
                <li key={c.code} role="none">
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => selectCountry(c)}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-2 text-sm transition hover:bg-elevated',
                      active && 'bg-brand/10 font-semibold text-brand-text',
                    )}
                  >
                    <span className="w-6 shrink-0 text-center text-base leading-none">{c.flag}</span>
                    <span className="flex-1 truncate text-left">{c.name}</span>
                    <span className={cn('text-xs', active ? 'text-brand-text' : 'text-muted')}>
                      {c.dialCode}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>}
          {filtered.length === 0 && (
            <p className="px-3 py-4 text-center text-sm text-muted">{tr('phoneInput.noCountriesFound')}</p>
          )}
        </div>
      )}
    </div>
  );
}
