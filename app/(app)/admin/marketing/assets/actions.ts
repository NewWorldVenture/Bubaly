'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit, marketingActionFailure } from '@/lib/marketing/admin';
import { assetKindFromMime, buildAssetPath, isAssetKind, parseTags, type AssetKind } from '@/lib/marketing/assets';

const BUCKET = 'marketing-assets';
const MAX_BYTES = 50 * 1024 * 1024; // matches the bucket file_size_limit

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? '').trim();
  return v === '' ? null : v;
}

export async function uploadAssetAction(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return;
  if (file.size > MAX_BYTES) throw new Error('Asset exceeds the 50 MB upload limit.');

  // Explicit kind wins; otherwise infer from the file's MIME type.
  const explicit = s(formData, 'kind');
  const kind: AssetKind = explicit && isAssetKind(explicit) ? explicit : assetKindFromMime(file.type);

  const id = crypto.randomUUID();
  const name = s(formData, 'name') ?? file.name;
  const path = buildAssetPath(kind, id, file.name);

  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (upErr) marketingActionFailure('upload the marketing asset', upErr);

  const { data, error } = await supabase.from('marketing_assets').insert({
    id,
    name,
    kind,
    storage_path: path,
    mime_type: file.type || null,
    size_bytes: file.size,
    alt_text: s(formData, 'alt_text'),
    tags: parseTags(s(formData, 'tags')),
    created_by: actorId,
  }).select('id').single();

  if (error || !data) {
    // Roll back the orphaned upload so storage and the table stay consistent.
    const { error: removeError } = await supabase.storage.from(BUCKET).remove([path]);
    if (removeError) console.error('[marketing asset] rollback failed', removeError);
    marketingActionFailure('save the marketing asset', error ?? new Error('The asset row was not returned after upload.'));
  }

  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_asset', resourceId: data?.id ?? null, metadata: { name, kind } });
  revalidatePath('/admin/marketing/assets');
}

export async function updateAssetAction(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = s(formData, 'id');
  if (!id) throw new Error('Marketing asset id is required.');
  const name = s(formData, 'name');
  const { data, error } = await supabase.from('marketing_assets').update({
    ...(name ? { name } : {}),
    alt_text: s(formData, 'alt_text'),
    tags: parseTags(s(formData, 'tags')),
  }).eq('id', id).is('deleted_at', null).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('update the marketing asset', error ?? new Error('Marketing asset not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'marketing_asset', resourceId: id });
  revalidatePath('/admin/marketing/assets');
}

export async function deleteAssetAction(id: string, storagePath: string): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  // Remove the file to free storage, then soft-delete the row (keeps history for
  // future "where used" backrefs without leaving an orphaned object behind).
  const { data: asset, error: readError } = await supabase
    .from('marketing_assets').select('id, storage_path').eq('id', id).is('deleted_at', null).maybeSingle();
  if (readError || !asset) marketingActionFailure('find the marketing asset', readError ?? new Error('Marketing asset not found.'));
  const deletedAt = new Date().toISOString();
  const { data, error } = await supabase.from('marketing_assets').update({ deleted_at: deletedAt })
    .eq('id', id).is('deleted_at', null).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('delete the marketing asset', error ?? new Error('Marketing asset was already deleted.'));
  const storageFile = asset.storage_path ?? storagePath;
  const { error: removeError } = storageFile
    ? await supabase.storage.from(BUCKET).remove([storageFile])
    : { error: null };
  if (removeError) {
    const { error: restoreError } = await supabase.from('marketing_assets').update({ deleted_at: null })
      .eq('id', id).eq('deleted_at', deletedAt).select('id').maybeSingle();
    if (restoreError) console.error('[marketing asset] delete rollback failed', restoreError);
    marketingActionFailure('remove the marketing asset file', removeError);
  }
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'marketing_asset', resourceId: id });
  revalidatePath('/admin/marketing/assets');
}
