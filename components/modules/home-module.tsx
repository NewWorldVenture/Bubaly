'use client';

import { useState } from 'react';
import { Home, Plus, Trash2, Wrench, Package, Check } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { LoadingBlock, EmptyState, ErrorState } from '@/components/ui/states';
import { fmtDate, fmtRelative } from '@/lib/utils/format';
import { isManager } from '@/lib/constants/roles';
import type { Tables } from '@/lib/database.types';

type HomeAsset = Tables<'home_assets'>;
type MaintenanceTask = Tables<'maintenance_tasks'>;

const PRIORITY_TONE = { low: 'neutral', medium: 'brand', high: 'danger' } as const;

export function HomeModule() {
  const { familyId, userId, role } = useApp();
  const manager = isManager(role);
  const { success, error: toastError } = useToast();
  const [openAsset, setOpenAsset] = useState(false);
  const [openTask, setOpenTask] = useState(false);

  const { data: assets, loading: assetsLoading, error: assetsError, refresh: refreshAssets } = useRealtimeQuery<HomeAsset>({
    table: 'home_assets',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('home_assets').select('*').eq('family_id', familyId).order('name'),
  });

  const { data: tasks, loading: tasksLoading, error: tasksError, refresh: refreshTasks } = useRealtimeQuery<MaintenanceTask>({
    table: 'maintenance_tasks',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('maintenance_tasks').select('*').eq('family_id', familyId)
        .in('status', ['todo', 'in_progress']).order('due_at', { ascending: true, nullsFirst: false }),
  });

  async function completeTask(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('maintenance_tasks').update({
      status: 'done', completed_at: new Date().toISOString(),
    }).eq('id', id);
    if (error) return toastError(error.message);
    success('Task completed');
    void refreshTasks();
  }

  async function removeAsset(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('home_assets').delete().eq('id', id);
    if (error) return toastError(error.message);
    success('Asset removed');
    void refreshAssets();
  }

  if (assetsLoading || tasksLoading) return <LoadingBlock />;
  if (assetsError) return <ErrorState message={assetsError} onRetry={refreshAssets} />;
  if (tasksError) return <ErrorState message={tasksError} onRetry={refreshTasks} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Home & Maintenance"
        description="Track appliances, assets, and maintenance tasks."
        action={manager && (
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpenAsset(true)}><Package className="h-4 w-4" /> Add asset</Button>
            <Button onClick={() => setOpenTask(true)}><Plus className="h-4 w-4" /> Add task</Button>
          </div>
        )}
      />

      {/* Maintenance Tasks */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Wrench className="h-4 w-4 text-warning" /> Maintenance tasks
          </h2>
          <Badge tone={tasks.length > 0 ? 'warning' : 'neutral'}>{tasks.length} open</Badge>
        </div>
        {tasks.length === 0 ? (
          <EmptyState icon={Wrench} title="No pending tasks" description="Add maintenance tasks to stay on top of your home." />
        ) : (
          <ul className="space-y-2">
            {tasks.map((t) => (
              <li key={t.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.title}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <Badge tone={PRIORITY_TONE[t.priority]}>{t.priority}</Badge>
                    {t.due_at && <span>{fmtRelative(t.due_at)}</span>}
                  </div>
                </div>
                <button onClick={() => completeTask(t.id)} className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-elevated">
                  <Check className="h-3.5 w-3.5" /> Done
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Home Assets */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Package className="h-4 w-4 text-brand" /> Home assets
          </h2>
          <Badge tone="neutral">{assets.length}</Badge>
        </div>
        {assets.length === 0 ? (
          <EmptyState icon={Package} title="No assets tracked" description="Add appliances and items to track warranties and maintenance." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {assets.map((a) => (
              <div key={a.id} className="flex items-start gap-3 rounded-xl border border-border bg-surface/40 p-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10">
                  <Home className="h-4 w-4 text-brand" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.name}</p>
                  <div className="text-xs text-muted">
                    {a.brand && <span>{a.brand} </span>}
                    {a.model && <span>{a.model}</span>}
                  </div>
                  {a.warranty_until && (
                    <p className="mt-0.5 text-xs text-muted">Warranty: {fmtDate(a.warranty_until)}</p>
                  )}
                </div>
                {manager && (
                  <button onClick={() => removeAsset(a.id)} className="rounded-lg p-1.5 text-muted hover:text-danger" aria-label="Remove">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {openAsset && (
        <NewAssetModal familyId={familyId} userId={userId}
          onClose={() => setOpenAsset(false)} onCreated={() => { setOpenAsset(false); void refreshAssets(); }} />
      )}
      {openTask && (
        <NewTaskModal familyId={familyId} userId={userId} assets={assets}
          onClose={() => setOpenTask(false)} onCreated={() => { setOpenTask(false); void refreshTasks(); }} />
      )}
    </div>
  );
}

function NewAssetModal({ familyId, userId, onClose, onCreated }: {
  familyId: string; userId: string; onClose: () => void; onCreated: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    if (!name) return toastError('Name is required');
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.from('home_assets').insert({
      family_id: familyId, created_by: userId, name,
      category: String(form.get('category') ?? '').trim() || null,
      brand: String(form.get('brand') ?? '').trim() || null,
      model: String(form.get('model') ?? '').trim() || null,
      location: String(form.get('location') ?? '').trim() || null,
      warranty_until: String(form.get('warranty_until') ?? '') || null,
    });
    setLoading(false);
    if (error) return toastError(error.message);
    success('Asset added');
    onCreated();
  }

  return (
    <Modal open onClose={onClose} title="Add home asset">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Item name" required>
          {(id) => <Input id={id} name="name" placeholder="Dishwasher" autoFocus />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">{(id) => <Input id={id} name="category" placeholder="Appliance" />}</Field>
          <Field label="Location">{(id) => <Input id={id} name="location" placeholder="Kitchen" />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Brand">{(id) => <Input id={id} name="brand" placeholder="Bosch" />}</Field>
          <Field label="Model">{(id) => <Input id={id} name="model" placeholder="SHPM88Z75N" />}</Field>
        </div>
        <Field label="Warranty until">{(id) => <Input id={id} name="warranty_until" type="date" />}</Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Add asset</Button>
        </div>
      </form>
    </Modal>
  );
}

function NewTaskModal({ familyId, userId, assets, onClose, onCreated }: {
  familyId: string; userId: string; assets: HomeAsset[];
  onClose: () => void; onCreated: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    if (!title) return toastError('Title is required');
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.from('maintenance_tasks').insert({
      family_id: familyId, created_by: userId, title,
      description: String(form.get('description') ?? '').trim() || null,
      priority: String(form.get('priority') ?? 'medium') as 'low' | 'medium' | 'high',
      status: 'todo',
      recurrence: 'none',
      asset_id: String(form.get('asset_id') ?? '') || null,
      due_at: form.get('due_at') ? new Date(String(form.get('due_at'))).toISOString() : null,
    });
    setLoading(false);
    if (error) return toastError(error.message);
    success('Task created');
    onCreated();
  }

  return (
    <Modal open onClose={onClose} title="Add maintenance task">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Task" required>
          {(id) => <Input id={id} name="title" placeholder="Replace HVAC filter" autoFocus />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            {(id) => (
              <Select id={id} name="priority" defaultValue="medium">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </Select>
            )}
          </Field>
          <Field label="Due date">{(id) => <Input id={id} name="due_at" type="datetime-local" />}</Field>
        </div>
        {assets.length > 0 && (
          <Field label="Related asset">
            {(id) => (
              <Select id={id} name="asset_id" defaultValue="">
                <option value="">None</option>
                {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            )}
          </Field>
        )}
        <Field label="Description">{(id) => <Textarea id={id} name="description" placeholder="Any details…" />}</Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Create task</Button>
        </div>
      </form>
    </Modal>
  );
}
