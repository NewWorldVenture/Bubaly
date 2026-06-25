'use client';

// Customizable, tier-aware dashboard quick actions. The "+" and AI buttons are
// fixed; every other button can be removed, reordered, replaced, or swapped from
// the available (tier-unlocked) set. Locked features live in a separate "Unlock
// more" area and route to the paywall, never the restricted feature. Layout
// persists to Supabase via the customize server actions. Works on all viewports.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Settings2, X, ChevronUp, ChevronDown, Plus, Check, RotateCcw, Search, Lock, Sparkles } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { FeatureIcon } from '@/components/dashboard/feature-icons';
import { FEATURE_BY_KEY, MAX_DASH_BUTTONS, type DashFeature, type DashTier } from '@/lib/dashboard/registry';
import { saveDashboardLayoutAction, resetDashboardLayoutAction, logDashboardEventAction } from '@/app/(app)/dashboard/customize-actions';

const TIER_LABEL: Record<DashTier, string> = { free: 'Free', basic: 'Basic', plus: 'Plus' };

export function DashboardQuickActions({ fixed, primaryKeys, available, locked }: {
  fixed: DashFeature[];
  primaryKeys: string[];
  available: DashFeature[];      // all tier-unlocked customizable features
  locked: DashFeature[];         // above-tier features (upgrade discovery)
}) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [editing, setEditing] = useState(false);
  const [keys, setKeys] = useState<string[]>(primaryKeys);
  const [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState<{ mode: 'add' | 'replace'; index: number } | null>(null);

  const tiles = useMemo(() => keys.map((k) => FEATURE_BY_KEY[k]).filter(Boolean), [keys]);

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= keys.length) return;
    const next = [...keys];
    [next[i], next[j]] = [next[j], next[i]];
    setKeys(next);
  }
  function remove(i: number) { setKeys(keys.filter((_, idx) => idx !== i)); }
  function pick(featureKey: string) {
    if (!picker) return;
    if (picker.mode === 'replace') setKeys(keys.map((k, idx) => (idx === picker.index ? featureKey : k)));
    else setKeys([...keys, featureKey].slice(0, MAX_DASH_BUTTONS));
    setPicker(null);
  }

  async function save() {
    setSaving(true);
    const res = await saveDashboardLayoutAction({ featureKeys: keys });
    setSaving(false);
    if (!res.ok) return toastError(res.error ?? 'Could not save layout');
    success('Dashboard saved');
    setEditing(false);
    router.refresh();
  }
  async function reset() {
    setSaving(true);
    const res = await resetDashboardLayoutAction({});
    setSaving(false);
    if (!res.ok) return toastError(res.error ?? 'Could not reset');
    success('Reset to default');
    setEditing(false);
    router.refresh();
  }
  function cancel() { setKeys(primaryKeys); setEditing(false); }

  const addable = available.filter((f) => !keys.includes(f.key));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Quick Access</h2>
        {!editing ? (
          <button onClick={() => setEditing(true)} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-brand hover:bg-brand/10 transition">
            <Settings2 className="h-3.5 w-3.5" /> Customize
          </button>
        ) : (
          <div className="flex items-center gap-1">
            <button onClick={reset} disabled={saving} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted hover:bg-elevated hover:text-fg transition"><RotateCcw className="h-3.5 w-3.5" /> Reset</button>
            <button onClick={cancel} disabled={saving} className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-elevated hover:text-fg transition">Cancel</button>
            <button onClick={save} disabled={saving} className="flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand/90 transition"><Check className="h-3.5 w-3.5" /> Save</button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-4 gap-2">
        {/* Fixed buttons — always present, never editable */}
        {fixed.map((f) => (
          <Link key={f.key} href={f.route}
            className="relative flex flex-col items-center gap-1.5 rounded-2xl border border-brand/30 bg-brand/5 py-4 text-center">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand/15 text-brand"><FeatureIcon icon={f.icon} className="h-4 w-4" /></div>
            <span className="text-[11px] font-semibold">{f.label}</span>
            {editing && <span className="absolute right-1 top-1 rounded bg-brand/15 px-1 text-[8px] font-bold uppercase text-brand">Fixed</span>}
          </Link>
        ))}

        {/* Customizable buttons */}
        {tiles.map((f, i) => editing ? (
          <div key={f.key} className="relative flex flex-col items-center gap-1.5 rounded-2xl border border-border bg-surface/40 py-4 text-center">
            <button onClick={() => remove(i)} aria-label={`Remove ${f.label}`} className="absolute -left-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-danger text-white shadow"><X className="h-3 w-3" /></button>
            <button onClick={() => setPicker({ mode: 'replace', index: i })} className="grid h-9 w-9 place-items-center rounded-xl bg-elevated"><FeatureIcon icon={f.icon} className="h-4 w-4" /></button>
            <span className="text-[11px] font-semibold">{f.label}</span>
            <div className="absolute bottom-1 right-1 flex flex-col">
              <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" className="text-muted hover:text-fg disabled:opacity-30"><ChevronUp className="h-3 w-3" /></button>
              <button onClick={() => move(i, 1)} disabled={i === tiles.length - 1} aria-label="Move down" className="text-muted hover:text-fg disabled:opacity-30"><ChevronDown className="h-3 w-3" /></button>
            </div>
          </div>
        ) : (
          <Link key={f.key} href={f.route}
            className="flex flex-col items-center gap-1.5 rounded-2xl border border-border bg-surface/40 py-4 text-center transition hover:border-brand/20 hover:bg-elevated">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-elevated"><FeatureIcon icon={f.icon} className="h-4 w-4" /></div>
            <span className="text-[11px] font-semibold">{f.label}</span>
          </Link>
        ))}

        {/* Add tile */}
        {editing && keys.length < MAX_DASH_BUTTONS && addable.length > 0 && (
          <button onClick={() => setPicker({ mode: 'add', index: keys.length })}
            className="flex flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-border py-4 text-muted hover:border-brand/40 hover:text-brand transition">
            <Plus className="h-5 w-5" /><span className="text-[11px] font-semibold">Add</span>
          </button>
        )}
      </div>

      {editing && <p className="text-[11px] text-muted">Locked features aren’t shown as primary buttons until you upgrade. The + and AI buttons are fixed.</p>}

      {/* Upgrade discovery */}
      {locked.length > 0 && <UnlockMore locked={locked} />}

      {picker && (
        <FeaturePicker
          mode={picker.mode}
          features={picker.mode === 'replace' ? available.filter((f) => !keys.includes(f.key) || f.key === keys[picker.index]) : addable}
          onClose={() => setPicker(null)}
          onPick={pick}
        />
      )}
    </div>
  );
}

function UnlockMore({ locked }: { locked: DashFeature[] }) {
  return (
    <div className="mt-2 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-amber-500">
        <Sparkles className="h-3.5 w-3.5" /> Unlock more
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {locked.slice(0, 6).map((f) => (
          <Link key={f.key} href="/pricing"
            onClick={() => { void logDashboardEventAction({ action: 'locked_feature_clicked', featureKey: f.key }); }}
            className="flex items-center gap-2 rounded-xl border border-border bg-surface/40 p-2.5 text-left transition hover:border-amber-500/40">
            <div className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg bg-elevated text-muted"><FeatureIcon icon={f.icon} className="h-4 w-4" /></div>
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold">{f.label}</p>
              <span className="flex items-center gap-0.5 text-[10px] text-amber-500"><Lock className="h-2.5 w-2.5" /> {TIER_LABEL[f.requiredTier]}</span>
            </div>
          </Link>
        ))}
      </div>
      <Link href="/pricing" onClick={() => { void logDashboardEventAction({ action: 'upgrade_cta_clicked' }); }}
        className="mt-3 block rounded-lg bg-amber-500 px-3 py-2 text-center text-xs font-semibold text-white hover:bg-amber-600 transition">
        See upgrade options
      </Link>
    </div>
  );
}

function FeaturePicker({ mode, features, onClose, onPick }: {
  mode: 'add' | 'replace'; features: DashFeature[]; onClose: () => void; onPick: (key: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const categories = useMemo(() => ['all', ...Array.from(new Set(features.map((f) => f.category)))], [features]);
  const filtered = features.filter((f) =>
    (category === 'all' || f.category === category) &&
    (!query || f.label.toLowerCase().includes(query.toLowerCase())),
  );

  return (
    <Modal open onClose={onClose} title={mode === 'replace' ? 'Replace button' : 'Add a button'}>
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-xl border border-border bg-surface/60 px-3 py-2">
          <Search className="h-4 w-4 text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search features…" autoFocus className="w-full bg-transparent text-sm outline-none placeholder:text-muted" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <button key={c} onClick={() => setCategory(c)}
              className={cn('rounded-full px-2.5 py-1 text-xs font-medium capitalize transition', category === c ? 'bg-brand text-white' : 'bg-surface/60 text-muted hover:bg-elevated')}>
              {c}
            </button>
          ))}
        </div>
        <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="col-span-3 py-6 text-center text-sm text-muted">No features match.</p>
          ) : filtered.map((f) => (
            <button key={f.key} onClick={() => onPick(f.key)}
              className="flex flex-col items-center gap-1.5 rounded-2xl border border-border bg-surface/40 py-3 text-center transition hover:border-brand/40 hover:bg-elevated">
              <div className="grid h-9 w-9 place-items-center rounded-xl bg-elevated"><FeatureIcon icon={f.icon} className="h-4 w-4" /></div>
              <span className="text-[11px] font-semibold">{f.label}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
