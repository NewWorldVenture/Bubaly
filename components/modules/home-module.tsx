'use client';

import { useMemo, useRef, useState } from 'react';
import { Home, Plus, Trash2, Wrench, Package, Check, Shield, FileText, Upload, ExternalLink, X } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { SkeletonList, EmptyState, ErrorState } from '@/components/ui/states';
import { fmtDate, fmtRelative } from '@/lib/utils/format';
import { isManager } from '@/lib/constants/roles';
import { uploadFamilyDocument, getDocumentSignedUrl, removeFamilyDocument } from '@/lib/storage/documents';
import type { Tables } from '@/lib/database.types';
import { preOpenWindow } from '@/lib/utils/open-url';
import { useTranslations } from '@/components/i18n/locale-provider';

type HomeAsset = Tables<'home_assets'>;
type MaintenanceTask = Tables<'maintenance_tasks'>;
type WarrantyDoc = Tables<'documents'>;

const PRIORITY_TONE = { low: 'neutral', medium: 'brand', high: 'danger' } as const;

function fmtBytes(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Expiry status for a warranty date — drives the badge tone everywhere it's shown. */
function expiryStatus(dateStr: string | null): { tone: 'danger' | 'warning' | 'success' | 'neutral'; label: string } {
  if (!dateStr) return { tone: 'neutral', label: 'No expiration set' };
  const days = Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
  if (days < 0) return { tone: 'danger', label: `Expired ${fmtRelative(dateStr)}` };
  if (days <= 30) return { tone: 'warning', label: `Expires ${fmtRelative(dateStr)}` };
  return { tone: 'success', label: `Expires ${fmtRelative(dateStr)}` };
}

export function HomeModule() {
  const tr = useTranslations();
  const { familyId, userId, role } = useApp();
  const manager = isManager(role);
  const { success, error: toastError } = useToast();
  const [openAsset, setOpenAsset] = useState(false);
  const [openTask, setOpenTask] = useState(false);
  const [warrantyAsset, setWarrantyAsset] = useState<HomeAsset | null>(null);

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

  const { data: warrantyDocs, loading: docsLoading, error: docsError, refresh: refreshDocs } = useRealtimeQuery<WarrantyDoc>({
    table: 'documents',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('documents').select('*').eq('family_id', familyId)
        .not('asset_id', 'is', null).order('created_at', { ascending: false }),
  });

  const docsByAsset = useMemo(() => {
    const map = new Map<string, WarrantyDoc[]>();
    for (const d of warrantyDocs) {
      if (!d.asset_id) continue;
      if (!map.has(d.asset_id)) map.set(d.asset_id, []);
      map.get(d.asset_id)!.push(d);
    }
    return map;
  }, [warrantyDocs]);

  function refreshWarranty() {
    void refreshAssets();
    void refreshDocs();
  }

  // Every asset with a tracked expiration date and/or an attached warranty file,
  // soonest-expiring first — this powers the "All Warranties" rollup below.
  const warrantyRows = useMemo(() => {
    return assets
      .map((asset) => {
        const files = docsByAsset.get(asset.id) ?? [];
        const earliestDocExpiry = files
          .map((f) => f.expires_at)
          .filter((d): d is string => !!d)
          .sort()[0];
        const expiry = earliestDocExpiry ?? asset.warranty_until ?? null;
        return { asset, files, expiry };
      })
      .filter((row) => row.expiry || row.files.length > 0)
      .sort((a, b) => {
        if (!a.expiry && !b.expiry) return a.asset.name.localeCompare(b.asset.name);
        if (!a.expiry) return 1;
        if (!b.expiry) return -1;
        return a.expiry.localeCompare(b.expiry);
      });
  }, [assets, docsByAsset]);

  async function completeTask(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('maintenance_tasks').update({
      status: 'done', completed_at: new Date().toISOString(),
    }).eq('id', id);
    if (error) return toastError(describeDbError(error));
    success('Task completed');
    void refreshTasks();
  }

  async function removeAsset(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('home_assets').delete().eq('id', id);
    if (error) return toastError(describeDbError(error));
    success('Asset removed');
    void refreshAssets();
  }

  async function viewFile(doc: WarrantyDoc) {
    const tab = preOpenWindow(); // sync, inside the tap gesture (iOS popup blocker)
    const supabase = createClient();
    const { url, error } = await getDocumentSignedUrl(supabase, doc.storage_path);
    if (error || !url) { tab.cancel(); return toastError(error ?? 'Could not open file'); }
    tab.navigate(url);
  }

  if (assetsLoading || tasksLoading || docsLoading) return <SkeletonList />;
  if (assetsError) return <ErrorState message={assetsError} onRetry={refreshAssets} />;
  if (tasksError) return <ErrorState message={tasksError} onRetry={refreshTasks} />;
  if (docsError) return <ErrorState message={docsError} onRetry={refreshDocs} />;

  return (
    <div className="module-page">
      <PageHeader
        title={tr('home.homeMaintenance')}
        description={tr('homeModule.trackAppliancesAssetsWarrantiesAnd')}
        action={
          <div className="flex gap-2">
            <AiInsight kind="home" />
            {manager && (
              <>
                <Button variant="ghost" onClick={() => setOpenAsset(true)}><Package className="h-4 w-4" /> {tr('home.addAsset')}</Button>
                <Button onClick={() => setOpenTask(true)}><Plus className="h-4 w-4" /> {tr('home.addTask')}</Button>
              </>
            )}
          </div>
        }
      />

      {/* All Warranties */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Shield className="h-4 w-4 text-success" /> {tr('home.allWarranties')}
          </h2>
          <Badge tone={warrantyRows.length > 0 ? 'success' : 'neutral'}>{warrantyRows.length}</Badge>
        </div>
        {warrantyRows.length === 0 ? (
          <EmptyState icon={Shield} title={tr('home.noWarrantiesTrackedYet')}
            description={tr('homeModule.openAnyAssetBelowAnd')} />
        ) : (
          <ul className="space-y-2">
            {warrantyRows.map(({ asset, files, expiry }) => {
              const status = expiryStatus(expiry);
              return (
                <li key={asset.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10">
                    <Home className="h-4 w-4 text-brand-text" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{asset.name}</p>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {files.map((f) => (
                      <button
                        key={f.id}
                        onClick={() => viewFile(f)}
                        className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-elevated"
                        title={f.title}
                      >
                        <FileText className="h-3.5 w-3.5" /> {tr('home.view')}{files.length > 1 ? '' : ' file'}
                      </button>
                    ))}
                    <button
                      onClick={() => setWarrantyAsset(asset)}
                      className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-elevated"
                    >
                      <Shield className="h-3.5 w-3.5" /> {tr('home.manage')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Maintenance Tasks */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Wrench className="h-4 w-4 text-warning" /> {tr('home.maintenanceTasks')}
          </h2>
          <Badge tone={tasks.length > 0 ? 'warning' : 'neutral'}>{tasks.length} open</Badge>
        </div>
        {tasks.length === 0 ? (
          <EmptyState icon={Wrench} title={tr('home.noPendingTasks')} description={tr('homeModule.addMaintenanceTasksToStay')} />
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
                  <Check className="h-3.5 w-3.5" /> {tr('home.done')}
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
            <Package className="h-4 w-4 text-brand-text" /> {tr('home.homeAssets')}
          </h2>
          <Badge tone="neutral">{assets.length}</Badge>
        </div>
        {assets.length === 0 ? (
          <EmptyState icon={Package} title={tr('home.noAssetsTracked')} description={tr('homeModule.addAppliancesAndItemsTo')} />
        ) : (
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
            {assets.map((a) => {
              const files = docsByAsset.get(a.id) ?? [];
              const status = expiryStatus(files.map((f) => f.expires_at).filter((d): d is string => !!d).sort()[0] ?? a.warranty_until);
              return (
                <div key={a.id} className="flex items-start gap-3 rounded-xl border border-border bg-surface/40 p-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10">
                    <Home className="h-4 w-4 text-brand-text" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{a.name}</p>
                    <div className="text-xs text-muted">
                      {a.brand && <span>{a.brand} </span>}
                      {a.model && <span>{a.model}</span>}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {files.length > 0 && <Badge tone="neutral">{files.length} file{files.length > 1 ? 's' : ''}</Badge>}
                    </div>
                    <button
                      onClick={() => setWarrantyAsset(a)}
                      className="mt-2 flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-elevated"
                    >
                      <Shield className="h-3.5 w-3.5" /> {tr('home.manageWarranty')}
                    </button>
                  </div>
                  {manager && (
                    <button onClick={() => removeAsset(a.id)} className="rounded-lg p-1.5 text-muted hover:text-danger" aria-label={tr('home.remove')}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              );
            })}
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
      {warrantyAsset && (
        <WarrantyModal
          asset={warrantyAsset}
          files={docsByAsset.get(warrantyAsset.id) ?? []}
          familyId={familyId}
          userId={userId}
          manager={manager}
          onClose={() => setWarrantyAsset(null)}
          onChanged={refreshWarranty}
        />
      )}
    </div>
  );
}

function WarrantyModal({ asset, files, familyId, userId, manager, onClose, onChanged }: {
  asset: HomeAsset; files: WarrantyDoc[]; familyId: string; userId: string; manager: boolean;
  onClose: () => void; onChanged: () => void;
}) {
  const tr = useTranslations();
  const { success, error: toastError } = useToast();
  const [warrantyUntil, setWarrantyUntil] = useState(asset.warranty_until ?? '');
  const [savingDate, setSavingDate] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function saveDate() {
    setSavingDate(true);
    const supabase = createClient();
    const { error } = await supabase.from('home_assets')
      .update({ warranty_until: warrantyUntil || null }).eq('id', asset.id);
    setSavingDate(false);
    if (error) return toastError(describeDbError(error));
    success('Warranty date saved');
    onChanged();
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    const supabase = createClient();
    const { path, error: uploadError } = await uploadFamilyDocument(supabase, {
      familyId, folder: `warranties/${asset.id}`, file,
    });
    if (uploadError || !path) {
      setUploading(false);
      return toastError(uploadError ?? 'Upload failed');
    }
    const { error: insertError } = await supabase.from('documents').insert({
      family_id: familyId, created_by: userId, asset_id: asset.id,
      title: file.name, category: 'warranty', storage_path: path,
      mime_type: file.type || null, size_bytes: file.size, expires_at: warrantyUntil || null,
    });
    setUploading(false);
    if (insertError) {
      await removeFamilyDocument(supabase, path);
      return toastError(describeDbError(insertError));
    }
    success('Warranty document saved');
    onChanged();
  }

  async function viewFile(doc: WarrantyDoc) {
    const tab = preOpenWindow(); // sync, inside the tap gesture (iOS popup blocker)
    const supabase = createClient();
    const { url, error } = await getDocumentSignedUrl(supabase, doc.storage_path);
    if (error || !url) { tab.cancel(); return toastError(error ?? 'Could not open file'); }
    tab.navigate(url);
  }

  async function removeFile(doc: WarrantyDoc) {
    setRemovingId(doc.id);
    const supabase = createClient();
    await removeFamilyDocument(supabase, doc.storage_path);
    const { error } = await supabase.from('documents').delete().eq('id', doc.id);
    setRemovingId(null);
    if (error) return toastError(describeDbError(error));
    success('File removed');
    onChanged();
  }

  return (
    <Modal open onClose={onClose} title={`Warranty — ${asset.name}`} description={tr('homeModule.keepTheExpirationDateAnd')}>
      <div className="space-y-5">
        <Field label={tr('home.warrantyExpires')}>
          {(id) => (
            <div className="flex gap-2">
              <Input id={id} type="date" value={warrantyUntil} onChange={(e) => setWarrantyUntil(e.target.value)} disabled={!manager} />
              {manager && <Button variant="secondary" loading={savingDate} onClick={saveDate}>{tr('home.save')}</Button>}
            </div>
          )}
        </Field>

        <div>
          <p className="mb-2 text-sm font-medium">{tr('home.warrantyDocuments')}</p>
          {files.length === 0 ? (
            <p className="text-sm text-muted">{tr('home.noFileUploadedYet')}</p>
          ) : (
            <ul className="space-y-1.5">
              {files.map((f) => (
                <li key={f.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface/50 px-3 py-2">
                  <FileText className="h-4 w-4 shrink-0 text-brand-text" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{f.title}</p>
                    <p className="text-xs text-muted">{fmtBytes(f.size_bytes)} {tr('home.added')} {fmtDate(f.created_at, 'MMM d, yyyy')}</p>
                  </div>
                  <button onClick={() => viewFile(f)} className="rounded-lg p-1.5 text-muted hover:text-brand-text" aria-label={tr('home.viewFile')}>
                    <ExternalLink className="h-4 w-4" />
                  </button>
                  {manager && (
                    <button onClick={() => removeFile(f)} disabled={removingId === f.id} className="rounded-lg p-1.5 text-muted hover:text-danger disabled:opacity-50" aria-label={tr('home.removeFile')}>
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {manager && (
            <>
              <input ref={fileInputRef} type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.heic,.doc,.docx" onChange={handleFile} />
              <Button type="button" variant="secondary" className="mt-3 w-full" loading={uploading} onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-4 w-4" /> {tr('home.uploadWarrantyCardOrReceipt')}
              </Button>
            </>
          )}
        </div>

        <div className="flex justify-end pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('home.close')}</Button>
        </div>
      </div>
    </Modal>
  );
}

function NewAssetModal({ familyId, userId, onClose, onCreated }: {
  familyId: string; userId: string; onClose: () => void; onCreated: () => void;
}) {
  const tr = useTranslations();
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
    if (error) return toastError(describeDbError(error));
    success('Asset added');
    onCreated();
  }

  return (
    <Modal open onClose={onClose} title={tr('home.addHomeAsset')}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={tr('home.itemName')} required>
          {(id) => <Input id={id} name="name" placeholder={tr('home.dishwasher')} autoFocus />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('home.category')}>{(id) => <Input id={id} name="category" placeholder={tr('home.appliance')} />}</Field>
          <Field label={tr('home.location')}>{(id) => <Input id={id} name="location" placeholder={tr('home.kitchen')} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('home.brand')}>{(id) => <Input id={id} name="brand" placeholder={tr('home.bosch')} />}</Field>
          <Field label={tr('home.model')}>{(id) => <Input id={id} name="model" placeholder="SHPM88Z75N" />}</Field>
        </div>
        <Field label={tr('home.warrantyUntil')} hint={tr('homeModule.youCanAlsoUploadThe')}>
          {(id) => <Input id={id} name="warranty_until" type="date" />}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('home.cancel')}</Button>
          <Button type="submit" loading={loading}>{tr('home.addAsset')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function NewTaskModal({ familyId, userId, assets, onClose, onCreated }: {
  familyId: string; userId: string; assets: HomeAsset[];
  onClose: () => void; onCreated: () => void;
}) {
  const tr = useTranslations();
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
    if (error) return toastError(describeDbError(error));
    success('Task created');
    onCreated();
  }

  return (
    <Modal open onClose={onClose} title={tr('home.addMaintenanceTask')}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={tr('home.task')} required>
          {(id) => <Input id={id} name="title" placeholder={tr('home.replaceHvacFilter')} autoFocus />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('home.priority')}>
            {(id) => (
              <Select id={id} name="priority" defaultValue="medium">
                <option value="low">Low</option>
                <option value="medium">{tr('home.medium')}</option>
                <option value="high">{tr('home.high')}</option>
              </Select>
            )}
          </Field>
          <Field label={tr('home.dueDate')}>{(id) => <Input id={id} name="due_at" type="datetime-local" />}</Field>
        </div>
        {assets.length > 0 && (
          <Field label={tr('home.relatedAsset')}>
            {(id) => (
              <Select id={id} name="asset_id" defaultValue="">
                <option value="">{tr('home.none')}</option>
                {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            )}
          </Field>
        )}
        <Field label={tr('home.description')}>{(id) => <Textarea id={id} name="description" placeholder={tr('home.anyDetails')} />}</Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('home.cancel')}</Button>
          <Button type="submit" loading={loading}>{tr('home.createTask')}</Button>
        </div>
      </form>
    </Modal>
  );
}
