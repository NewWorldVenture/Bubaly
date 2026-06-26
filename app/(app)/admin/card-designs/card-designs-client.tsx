'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Pencil, Trash2, ToggleLeft, ToggleRight, CreditCard, X } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { upsertCardDesignAction, toggleCardDesignAction, deleteCardDesignAction } from './actions';

export type DesignRow = {
  id: string;
  name: string;
  stripe_design_id: string | null;
  requires_physical: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: string;
};

function DesignModal({
  design,
  onClose,
}: {
  design: DesignRow | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(design?.name ?? '');
  const [stripeId, setStripeId] = useState(design?.stripe_design_id ?? '');
  const [requiresPhysical, setRequiresPhysical] = useState(design?.requires_physical ?? false);
  const [sortOrder, setSortOrder] = useState(String(design?.sort_order ?? 0));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return toastError('Name is required');
    setLoading(true);
    const res = await upsertCardDesignAction({
      id: design?.id,
      name,
      stripeDesignId: stripeId.trim() || null,
      requiresPhysical,
      sortOrder: parseInt(sortOrder, 10) || 0,
    });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not save');
    success(design ? 'Design updated' : 'Design created');
    onClose();
    router.refresh();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-border bg-bg p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-bold text-fg">{design ? 'Edit design' : 'New card design'}</h3>
          <button onClick={onClose} aria-label="Close" title="Close" className="rounded-lg p-1.5 text-muted hover:bg-elevated"><X className="h-4 w-4" /></button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand"
              placeholder="e.g. Astronaut, Galaxy, Soccer Star"
              required
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Stripe personalization design ID <span className="text-muted/60">(optional)</span>
            </label>
            <input
              type="text"
              value={stripeId}
              onChange={(e) => setStripeId(e.target.value)}
              className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm font-mono outline-none focus:border-brand"
              placeholder="ica_design_..."
            />
            <p className="mt-1 text-xs text-muted">Leave blank to use the standard Stripe design.</p>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Sort order</label>
            <input
              type="number"
              min="0"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              className="w-24 rounded-xl border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand"
            />
          </div>
          <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-surface/50 px-4 py-3">
            <input
              type="checkbox"
              checked={requiresPhysical}
              onChange={(e) => setRequiresPhysical(e.target.checked)}
              className="h-4 w-4 rounded accent-brand"
            />
            <div>
              <p className="text-sm font-medium text-fg">Physical card only</p>
              <p className="text-xs text-muted">This design is only available on physical cards (not virtual).</p>
            </div>
          </label>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-border py-2.5 text-sm font-medium text-muted hover:bg-elevated">
              Cancel
            </button>
            <button type="submit" disabled={loading} className="flex-1 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60">
              {loading ? 'Saving…' : design ? 'Save changes' : 'Create design'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function CardDesignsClient({ designs }: { designs: DesignRow[] }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState<DesignRow | 'new' | null>(null);

  function handleToggle(d: DesignRow) {
    startTransition(async () => {
      const res = await toggleCardDesignAction({ id: d.id, isActive: !d.is_active });
      if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
      success(d.is_active ? 'Design deactivated' : 'Design activated');
      router.refresh();
    });
  }

  function handleDelete(d: DesignRow) {
    if (!confirm(`Delete "${d.name}"? This can't be undone.`)) return;
    startTransition(async () => {
      const res = await deleteCardDesignAction({ id: d.id });
      if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
      success('Design deleted');
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          Manage custom card designs. Each design maps to a Stripe personalization design ID.
          Leave the Stripe ID blank to use the platform default.
        </p>
        <button
          onClick={() => setEditing('new')}
          className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90"
        >
          <Plus className="h-4 w-4" /> New design
        </button>
      </div>

      {designs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <CreditCard className="mx-auto mb-3 h-8 w-8 text-muted" />
          <p className="font-medium text-fg">No card designs yet</p>
          <p className="mt-1 text-sm text-muted">Add custom designs to let families personalize their cards.</p>
          <button onClick={() => setEditing('new')} className="mt-3 text-sm text-brand hover:underline">
            Add first design →
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-surface/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-elevated">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted">Name</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted">Stripe design ID</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted">Type</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted">Order</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted">Status</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {designs.map((d) => (
                <tr key={d.id} className={cn(!d.is_active && 'opacity-50')}>
                  <td className="px-4 py-3">
                    <span className="font-medium text-fg">{d.name}</span>
                  </td>
                  <td className="px-4 py-3">
                    {d.stripe_design_id ? (
                      <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-xs text-muted">{d.stripe_design_id}</span>
                    ) : (
                      <span className="text-xs text-muted/60 italic">default</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium',
                      d.requires_physical
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                        : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
                    )}>
                      {d.requires_physical ? 'Physical only' : 'All cards'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted">{d.sort_order}</td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium',
                      d.is_active
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : 'bg-surface text-muted',
                    )}>
                      {d.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleToggle(d)}
                        title={d.is_active ? 'Deactivate' : 'Activate'}
                        className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg"
                      >
                        {d.is_active ? <ToggleRight className="h-4 w-4 text-brand" /> : <ToggleLeft className="h-4 w-4" />}
                      </button>
                      <button
                        onClick={() => setEditing(d)}
                        title="Edit"
                        className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(d)}
                        title="Delete"
                        className="rounded-lg p-1.5 text-muted hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing !== null && (
        <DesignModal
          design={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
