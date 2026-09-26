'use client';

// Super-admin editor for the "All Services" tooltip descriptions. Lists every
// service grouped exactly as the catalog, with an editable blurb per service.
// Save persists an override to Supabase (service_descriptions); clearing a field
// or matching the shipped default removes the override so it falls back to code.
// Search filters live; per-row dirty state + save/reset with toasts.

import { useMemo, useState } from 'react';
import { Loader2, RotateCcw, Search, Check } from 'lucide-react';
import { SERVICE_DESCRIPTIONS } from '@/lib/services/descriptions';
import { saveServiceDescriptionAction } from '@/app/(app)/admin/services/actions';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

export type EditorGroup = { title: string; items: { key: string; label: string }[] };

export function ServiceDescriptionsEditor({ groups, overrides }: {
  groups: EditorGroup[];
  overrides: Record<string, string>;
}) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [query, setQuery] = useState('');
  // Working values start from override-or-default; saved snapshot tracks "clean".
  const initial = useMemo(() => {
    const m: Record<string, string> = {};
    for (const g of groups) for (const it of g.items) m[it.key] = overrides[it.key] ?? SERVICE_DESCRIPTIONS[it.key] ?? '';
    return m;
  }, [groups, overrides]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [saved, setSaved] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const overriddenCount = Object.keys(groups.flatMap((g) => g.items).reduce((acc, it) => {
    if ((saved[it.key] ?? '') !== (SERVICE_DESCRIPTIONS[it.key] ?? '')) acc[it.key] = 1;
    return acc;
  }, {} as Record<string, number>)).length;

  // `intent` only chooses the feedback (toast, Save-button tick); the settled
  // state always comes from the server. Resolves true when the write landed.
  async function persist(key: string, description: string, intent: 'save' | 'reset' = 'save'): Promise<boolean> {
    setBusy(key);
    const res = await saveServiceDescriptionAction({ key, description });
    setBusy(null);
    if (!res.ok) {
      // Surfaced, never swallowed. The box keeps what it holds: on a failed save
      // that is what the admin typed; resetToDefault() undoes its own optimism.
      toastError(res.error);
      return false;
    }
    // Settle to the description that is now IN EFFECT (res.description), never to
    // the string we sent. Sending '' means "drop the override", and what the app
    // then serves is the shipped default — so settling to '' used to leave the row
    // blank and still badged CUSTOM, with Save disabled ('' vs ''), until a reload.
    // Same reason the raw argument is wrong on a save: the server trims and caps it.
    setSaved((s) => ({ ...s, [key]: res.description }));
    setValues((v) => ({ ...v, [key]: res.description }));
    if (intent === 'save') {
      setJustSaved(key);
      setTimeout(() => setJustSaved((k) => (k === key ? null : k)), 1500);
    } else {
      // The Save button's "Saved" tick belongs to a save. A reset reports itself
      // in its own toast, and must not inherit a tick left by a save just before.
      setJustSaved((k) => (k === key ? null : k));
    }
    success(t(intent === 'reset' ? 'serviceDescriptionsEditor.descriptionReset' : 'serviceDescriptionsEditor.descriptionSaved'));
    return true;
  }

  async function resetToDefault(key: string) {
    const def = SERVICE_DESCRIPTIONS[key] ?? '';
    const inBox = values[key] ?? '';
    setValues((v) => ({ ...v, [key]: def })); // optimistic; persist() settles from the server
    const applied = await persist(key, '', 'reset'); // empty → server drops the override → falls back to default
    // Refused: nothing was applied, so the box goes back to exactly what it held
    // when Reset was clicked — unsaved typing included, as a failed save keeps
    // it — unless the admin has typed over the optimistic default since.
    if (!applied) setValues((v) => (v[key] === def ? { ...v, [key]: inBox } : v));
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('serviceDescriptionsEditor.searchServices')}
            className="h-10 w-full rounded-xl border border-border bg-bg pl-9 pr-3 text-sm outline-none focus:border-brand"
          />
        </div>
        <p className="text-xs text-muted">
          {overriddenCount > 0 ? `${overriddenCount} customized` : 'All using defaults'} · {groups.reduce((n, g) => n + g.items.length, 0)} services
        </p>
      </div>

      {groups.map((group) => {
        const items = group.items.filter(
          (it) => !q || it.label.toLowerCase().includes(q) || it.key.toLowerCase().includes(q) || (values[it.key] ?? '').toLowerCase().includes(q),
        );
        if (items.length === 0) return null;
        return (
          <section key={group.title} className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted/70">{group.title}</h2>
            <div className="space-y-2">
              {items.map((it) => {
                const value = values[it.key] ?? '';
                const dirty = value.trim() !== (saved[it.key] ?? '').trim();
                const isOverride = (saved[it.key] ?? '') !== (SERVICE_DESCRIPTIONS[it.key] ?? '');
                const isBusy = busy === it.key;
                return (
                  <div key={it.key} className="rounded-xl border border-border bg-surface/40 p-3">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-fg">{it.label}</span>
                        {isOverride && <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-text">{t('serviceDescriptionsEditor.custom')}</span>}
                      </div>
                      <code className="hidden text-[11px] text-muted/60 sm:block">{it.key}</code>
                    </div>
                    <textarea
                      value={value}
                      onChange={(e) => setValues((v) => ({ ...v, [it.key]: e.target.value }))}
                      rows={2}
                      maxLength={400}
                      className="w-full resize-y rounded-lg border border-border bg-bg p-2.5 text-sm outline-none focus:border-brand"
                    />
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted/60">{value.length}/400</span>
                      <div className="flex items-center gap-2">
                        {isOverride && (
                          <button
                            type="button" disabled={isBusy}
                            onClick={() => resetToDefault(it.key)}
                            className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-50"
                          >
                            <RotateCcw className="h-3 w-3" />{' '}{t('serviceDescriptionsEditor.reset')}</button>
                        )}
                        <button
                          type="button" disabled={!dirty || isBusy}
                          onClick={() => persist(it.key, value)}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50',
                            justSaved === it.key ? 'bg-emerald-500/15 text-emerald-300' : 'bg-brand text-brand-fg hover:opacity-90',
                          )}
                        >
                          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : justSaved === it.key ? <Check className="h-3.5 w-3.5" /> : null}
                          {justSaved === it.key ? 'Saved' : 'Save'}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
