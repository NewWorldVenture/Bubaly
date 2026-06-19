'use client';

import { useRef } from 'react';
import { Search } from 'lucide-react';

/**
 * Server-rendered filtering via GET query params — submits automatically on
 * change/typing-pause, so filters work without any client-side data fetching.
 */
export function FilterForm({
  action,
  hidden,
  children,
}: {
  action: string;
  hidden?: Record<string, string | undefined>;
  children: React.ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={action} method="GET" className="flex flex-wrap items-center gap-2">
      {hidden &&
        Object.entries(hidden).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      {children}
    </form>
  );
}

export function FilterSelect({ name, defaultValue, options }: {
  name: string;
  defaultValue?: string;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      name={name}
      defaultValue={defaultValue ?? ''}
      onChange={(e) => e.currentTarget.form?.requestSubmit()}
      className="h-9 rounded-lg border border-border bg-surface/60 px-2.5 text-sm text-fg focus-ring"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

export function FilterSearchInput({ name, defaultValue, placeholder }: {
  name: string;
  defaultValue?: string;
  placeholder: string;
}) {
  return (
    <label className="flex h-9 min-w-[14rem] flex-1 items-center gap-2 rounded-lg border border-border bg-surface/60 px-2.5 text-muted">
      <Search className="h-4 w-4 shrink-0" />
      <input
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted"
      />
    </label>
  );
}
