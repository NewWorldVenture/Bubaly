'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit } from '@/lib/marketing/admin';
import { parseVideoUrl } from '@/lib/marketing/video';
import { parseTags } from '@/lib/marketing/assets';

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? '').trim();
  return v === '' ? null : v;
}

export async function saveVideoAction(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = s(formData, 'id');
  const title = s(formData, 'title');
  if (!title) return;

  // Source is EITHER an uploaded video asset (Asset Library) OR an external URL.
  const assetId = s(formData, 'asset_id');
  let provider = 'youtube';
  let video_id: string | null = null;
  let url: string | null = null;
  let storage_path: string | null = null;

  if (assetId) {
    const { data: asset } = await supabase
      .from('marketing_assets')
      .select('storage_path')
      .eq('id', assetId)
      .eq('kind', 'video')
      .is('deleted_at', null)
      .maybeSingle();
    if (!asset) return; // asset gone — no-op
    provider = 'upload';
    storage_path = asset.storage_path;
  } else {
    const parsed = parseVideoUrl(s(formData, 'url'));
    if (!parsed) return; // need a valid YouTube/Vimeo URL or an uploaded asset
    provider = parsed.provider;
    video_id = parsed.videoId;
    url = s(formData, 'url');
  }

  const durationRaw = Number(s(formData, 'duration_seconds') ?? '');
  const row = {
    title,
    provider,
    video_id,
    url,
    storage_path,
    poster_url: s(formData, 'poster_url'),
    transcript: s(formData, 'transcript'),
    duration_seconds: Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : null,
    status: s(formData, 'status') === 'published' ? 'published' : 'draft',
    tags: parseTags(s(formData, 'tags')),
  };

  if (id) {
    await supabase.from('marketing_videos').update(row).eq('id', id);
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'marketing_video', resourceId: id });
  } else {
    const { data } = await supabase.from('marketing_videos').insert({ ...row, created_by: actorId }).select('id').single();
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_video', resourceId: data?.id ?? null, metadata: { title, provider } });
  }
  revalidatePath('/admin/marketing/video');
}

export async function toggleVideoPublishAction(id: string, publish: boolean): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  await supabase.from('marketing_videos').update({ status: publish ? 'published' : 'draft' }).eq('id', id);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'marketing_video', resourceId: id, metadata: { status: publish ? 'published' : 'draft' } });
  revalidatePath('/admin/marketing/video');
}

export async function deleteVideoAction(id: string): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  // Soft-delete; any uploaded asset stays in the Asset Library (managed there).
  await supabase.from('marketing_videos').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'marketing_video', resourceId: id });
  revalidatePath('/admin/marketing/video');
}
