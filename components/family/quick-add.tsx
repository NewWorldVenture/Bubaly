'use client';
// Generic, accessible "quick add" form used across the Bubaly modules.
// Submits through the whitelisted createFamilyRecord server action, so every
// write is validated + RLS-isolated on the server. Renders loading / error /
// success states inline.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Loader2, Check, X } from 'lucide-react';
import { createFamilyRecord } from '@/lib/family/actions';
import { cn } from '@/lib/utils/cn';

export type FieldType = 'text' | 'textarea' | 'date' | 'number' | 'select' | 'checkbox' | 'member';
export type Field = {
  name: string;
  label: string;
  type?: FieldType;
  required?: boolean;
  placeholder?: string;
  options?: { value: string; label: string }[];
  defaultValue?: string;
};

export type MemberOption = { id: string; display_name: string };

export function QuickAdd({
  table,
  title = 'Add',
  fields,
  members = [],
  buttonClassName,
}: {
  table: string;
  title?: string;
  fields: Field[];
  members?: MemberOption[];
  buttonClassName?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  function submit(formData: FormData) {
    setError(null);
    const values: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.type === 'checkbox') {
        values[f.name] = formData.get(f.name) === 'on';
      } else {
        const v = formData.get(f.name);
        if (v != null && String(v).length) values[f.name] = String(v);
      }
    }
    start(async () => {
      const res = await createFamilyRecord(table, values);
      if (res.ok) {
        setDone(true);
        setTimeout(() => { setDone(false); setOpen(false); }, 800);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-xl bg-brand px-3.5 py-2 text-sm font-semibold text-white transition hover:opacity-90',
          buttonClassName,
        )}
      >
        <Plus className="h-4 w-4" /> {title}
      </button>
    );
  }

  return (
    <form
      action={submit}
      className="rounded-2xl border border-border bg-surface/60 p-4 space-y-3"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <button type="button" onClick={() => setOpen(false)} aria-label="Cancel" className="text-muted hover:text-fg">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => {
          const id = `${table}-${f.name}`;
          const base = 'w-full rounded-2xl border border-border bg-bg px-3.5 py-2.5 text-sm outline-none transition focus:border-brand/60';
          return (
            <label key={f.name} htmlFor={id} className={cn('flex flex-col gap-1 text-xs text-muted', f.type === 'textarea' && 'sm:col-span-2')}>
              <span>{f.label}{f.required && <span className="text-danger"> *</span>}</span>
              {f.type === 'textarea' ? (
                <textarea id={id} name={f.name} required={f.required} placeholder={f.placeholder} rows={3} className={base} />
              ) : f.type === 'select' ? (
                <select id={id} name={f.name} required={f.required} defaultValue={f.defaultValue ?? ''} className={base}>
                  <option value="">Select…</option>
                  {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : f.type === 'member' ? (
                <select id={id} name={f.name} required={f.required} defaultValue="" className={base}>
                  <option value="">Whole family</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                </select>
              ) : f.type === 'checkbox' ? (
                <input id={id} name={f.name} type="checkbox" className="h-4 w-4 accent-brand" />
              ) : (
                <input id={id} name={f.name} type={f.type ?? 'text'} required={f.required} placeholder={f.placeholder} defaultValue={f.defaultValue} className={base} />
              )}
            </label>
          );
        })}
      </div>
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || done}
          className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : done ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {done ? 'Saved' : 'Save'}
        </button>
      </div>
    </form>
  );
}
