'use client';

// Settings → Display comfort. Lets anyone override the role-default density
// (which <RoleDensity/> applies app-wide). Persisted in localStorage and applied
// instantly via the comfort-change event. "Auto" follows the member's role.
import { useEffect, useState } from 'react';
import { Check, Type } from 'lucide-react';
import { useApp } from './app-context';
import {
  roleSurface, DENSITY_OPTIONS, DENSITY_LABELS, DENSITY_DESCRIPTIONS, type Density,
} from '@/lib/ui/role-surface';
import { COMFORT_STORAGE_KEY, COMFORT_CHANGE_EVENT } from './role-density';
import { cn } from '@/lib/utils/cn';

type Choice = 'auto' | Density;

export function DisplayComfort() {
  const { role } = useApp();
  const roleDefault = roleSurface(role).density;
  const [choice, setChoice] = useState<Choice>('auto');

  useEffect(() => {
    try {
      const v = localStorage.getItem(COMFORT_STORAGE_KEY);
      if (v === 'comfortable' || v === 'cozy' || v === 'playful') setChoice(v);
      else setChoice('auto');
    } catch { /* storage blocked */ }
  }, []);

  const select = (next: Choice) => {
    setChoice(next);
    try {
      if (next === 'auto') localStorage.removeItem(COMFORT_STORAGE_KEY);
      else localStorage.setItem(COMFORT_STORAGE_KEY, next);
    } catch { /* storage blocked */ }
    window.dispatchEvent(new CustomEvent(COMFORT_CHANGE_EVENT));
  };

  const options: { key: Choice; label: string; desc: string }[] = [
    { key: 'auto', label: 'Auto', desc: `Follow your role — ${DENSITY_LABELS[roleDefault]} for you.` },
    ...DENSITY_OPTIONS.map((d) => ({ key: d as Choice, label: DENSITY_LABELS[d], desc: DENSITY_DESCRIPTIONS[d] })),
  ];

  return (
    <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/10 text-brand"><Type className="h-4 w-4" /></span>
        <div>
          <h2 className="text-sm font-bold">Display comfort</h2>
          <p className="text-[11px] text-muted">Text size &amp; spacing across the app. Bubaly tailors this to each member&apos;s role.</p>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {options.map((o) => {
          const active = choice === o.key;
          return (
            <button
              key={o.key}
              onClick={() => select(o.key)}
              aria-pressed={active}
              className={cn(
                'flex items-start justify-between gap-2 rounded-xl border p-3 text-left transition',
                active ? 'border-brand bg-brand/10' : 'border-border hover:bg-elevated',
              )}
            >
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{o.label}</span>
                <span className="block text-xs text-muted">{o.desc}</span>
              </span>
              {active && <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" />}
            </button>
          );
        })}
      </div>
    </section>
  );
}
