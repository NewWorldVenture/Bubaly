'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit } from '@/lib/marketing/admin';
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
  if (file.size > MAX_BYTES) return;

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
  if (upErr) return; // bucket missing / dup — surfaced as no-op (page reload shows no new row)

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

  if (error) {
    // Roll back the orphaned upload so storage and the table stay consistent.
    await supabase.storage.from(BUCKET).remove([path]);
    return;
  }

  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_asset', resourceId: data?.id ?? null, metadata: { name, kind } });
  revalidatePath('/admin/marketing/assets');
}

export async function updateAssetAction(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = s(formData, 'id');
  if (!id) return;
  const name = s(formData, 'name');
  await supabase.from('marketing_assets').update({
    ...(name ? { name } : {}),
    alt_text: s(formData, 'alt_text'),
    tags: parseTags(s(formData, 'tags')),
  }).eq('id', id);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'marketing_asset', resourceId: id });
  revalidatePath('/admin/marketing/assets');
}

export async function deleteAssetAction(id: string, storagePath: string): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  // Remove the file to free storage, then soft-delete the row (keeps history for
  // future "where used" backrefs without leaving an orphaned object behind).
  if (storagePath) await supabase.storage.from(BUCKET).remove([storagePath]);
  await supabase.from('marketing_assets').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'marketing_asset', resourceId: id });
  revalidatePath('/admin/marketing/assets');
}
