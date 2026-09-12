'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { requireSocialPermission } from '@/lib/social/access';
import { describeActionError } from '@/lib/supabase/errors';
import {
  isProviderConfigured, isPlatform, PROVIDERS, type SocialPlatform,
} from '@/lib/social/capabilities';
import {
  extractHashtags, extractMentions, effectiveLength, type PostKind,
} from '@/lib/social/content';
import { isSocialRole } from '@/lib/social/roles';
import { createTargets, runPublishNow } from '@/lib/social/publish';
import type { PublishOutcome } from '@/lib/social/publish';
import { beginXAuthorization, X_COOKIE, xCookieOptions } from '@/lib/social/x-oauth';
import { clearXTokens, XBoundaryError } from '@/lib/social/account-tokens';

type SocialSupabase = Awaited<ReturnType<typeof createServer>>;
const SOCIAL_SAVE_FAILURE = 'Social publishing could not be saved completely. Review the post status before retrying.';

async function cleanupPost(supabase: SocialSupabase, familyId: string, postId: string): Promise<void> {
  const { error } = await supabase
    .from('social_posts')
    .delete()
    .eq('id', postId)
    .eq('family_id', familyId);
  if (error) console.error('[social-action] incomplete post cleanup failed', error);
}

async function familyId() {
  const ctx = await requireUserContext();
  return { familyId: ctx.active.familyId, userId: ctx.user.id };
}

/**
 * X starts a bound OAuth authorization. Other providers record setup intent
 * until their live OAuth implementation exists; credentials alone never connect.
 */
export async function connectAccountAction(formData: FormData) {
  const tr = await getTranslations();
  const platform = String(formData.get('platform') ?? '');
  if (!isPlatform(platform)) return { ok: false, error: tr('actions.unknownPlatform') };
  const { familyId: fid, userId } = await familyId();
  await requireSocialPermission(fid, 'connect_accounts');

  if (platform === 'x') {
    try {
      const flow = await beginXAuthorization({ familyId: fid, userId });
      (await cookies()).set(X_COOKIE, flow.cookie, xCookieOptions(flow.redirectUri));
      revalidatePath('/dashboard/social/accounts');
      return { ok: true, requiresSetup: false, authorizationUrl: flow.authorizationUrl };
    } catch (error) {
      return { ok: false, error: tr(error instanceof XBoundaryError ? error.key : 'socialX.connectionFailed') };
    }
  }

  const supabase = await createServer();
  const configured = isProviderConfigured(platform);
  const def = PROVIDERS[platform];

  const { error } = await supabase.from('social_accounts').insert({
    family_id: fid,
    user_id: userId,
    platform,
    status: configured ? 'pending' : 'requires_setup',
    display_name: `${def.label} (not yet authorized)`,
    scopes: def.requiredScopes,
    last_error: configured
      ? 'Credentials present. Complete the OAuth authorization to finish connecting.'
      : `Add ${def.credentialEnv.join(', ')} to the environment, then authorize.`,
    created_by: userId,
    metadata: { needs_app_review: def.needsAppReview },
  });
  if (error) return { ok: false, error: describeActionError(error, tr('actions.couldNotStartTheAccount')) };
  revalidatePath('/dashboard/social/accounts');
  return { ok: true, requiresSetup: !configured };
}

export async function disconnectAccountAction(accountId: string) {
  const tr = await getTranslations();
  const { familyId: fid, userId } = await familyId();
  await requireSocialPermission(fid, 'connect_accounts');
  if (!accountId.trim()) return { ok: false, error: tr('actions.chooseAnAccountToDisconnect') };
  const supabase = await createServer();
  const account = await supabase.from('social_accounts').select('platform').eq('id', accountId).eq('family_id', fid).single();
  if (account.error || !account.data) return { ok: false, error: tr('actions.couldNotDisconnectThatAccount') };
  if (account.data.platform === 'x') {
    try { await clearXTokens({ familyId: fid, userId }, accountId); }
    catch { return { ok: false, error: tr('actions.couldNotDisconnectThatAccount') }; }
  }
  const { data, error } = await supabase
    .from('social_accounts')
    .update({ status: 'disconnected', deleted_at: new Date().toISOString(), updated_by: userId })
    .eq('id', accountId)
    .eq('family_id', fid)
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: describeActionError(error, tr('actions.couldNotDisconnectThatAccount')) };
  revalidatePath('/dashboard/social/accounts');
  return { ok: true };
}

export type CreatePostResult = {
  ok: boolean;
  error?: string;
  postId?: string;
  action?: 'draft' | 'schedule' | 'publish';
  outcome?: PublishOutcome;
};

/**
 * Create a post from the Content Studio: persists the draft, builds a
 * per-platform variant for each selected platform, creates publish targets for
 * the selected accounts, then either saves as draft, schedules, or publishes now.
 */
export async function createPostAction(formData: FormData): Promise<CreatePostResult> {
  const tr = await getTranslations();
  const { familyId: fid, userId } = await familyId();

  const intent = (String(formData.get('intent') ?? 'draft') as 'draft' | 'schedule' | 'publish');
  const permission = intent === 'publish' ? 'publish_posts' : intent === 'schedule' ? 'schedule_posts' : 'create_drafts';
  try {
    await requireSocialPermission(fid, permission);
  } catch {
    return { ok: false, error: `You do not have permission to ${intent} posts.` };
  }

  const title = String(formData.get('title') ?? '').trim() || null;
  const body = String(formData.get('body') ?? '').trim();
  const kind = (String(formData.get('kind') ?? 'text') as PostKind);
  const link = String(formData.get('link') ?? '').trim() || null;
  const scheduledForRaw = String(formData.get('scheduled_for') ?? '').trim();
  let scheduledFor: string | null = null;
  if (intent === 'schedule' && scheduledForRaw) {
    const parsedDate = new Date(scheduledForRaw);
    if (Number.isNaN(parsedDate.getTime())) return { ok: false, error: tr('actions.pickAValidDateAnd') };
    scheduledFor = parsedDate.toISOString();
  }

  const platforms = formData.getAll('platforms').map(String).filter(isPlatform) as SocialPlatform[];
  const accountIds = Array.from(new Set(formData.getAll('account_ids').map(String).filter(Boolean)));

  if (!body && !title) return { ok: false, error: tr('actions.addATitleOrBody') };
  if (intent === 'schedule' && !scheduledFor) return { ok: false, error: tr('actions.pickADateAndTime') };
  if (intent !== 'draft' && accountIds.length === 0) return { ok: false, error: tr('actions.selectAtLeastOneSocial') };

  const supabase = await createServer();
  let postId: string | null = null;
  let publishStarted = false;
  try {
    const { data: post, error: postErr } = await supabase
      .from('social_posts')
      .insert({
        family_id: fid,
        user_id: userId,
        title,
        body,
        kind,
        link,
        status: intent === 'draft' ? 'draft' : 'scheduled',
        scheduled_for: scheduledFor,
        created_by: userId,
      })
      .select('id')
      .single();
    if (postErr || !post) {
      return { ok: false, error: describeActionError(postErr, tr('actions.couldNotCreateThisSocial')) };
    }
    postId = post.id;

    // Per-platform variants (one body per platform; studio may later override).
    if (platforms.length) {
      const variants = platforms.map((p) => ({
        post_id: post.id,
        family_id: fid,
        platform: p,
        body,
        hashtags: extractHashtags(body),
        mentions: PROVIDERS[p].mentions ? extractMentions(body) : [],
        char_count: effectiveLength(body, p),
        created_by: userId,
      }));
      const { error: variantsError } = await supabase.from('social_post_variants').insert(variants);
      if (variantsError) throw variantsError;
    }

    // Publish targets from selected connected accounts.
    const targetCount = await createTargets(supabase, fid, post.id, accountIds, scheduledFor);
    if (intent !== 'draft' && targetCount === 0) throw new Error(tr('actions.selectAtLeastOneSocial'));

    if (intent === 'schedule' && scheduledFor) {
      const { error: scheduleError } = await supabase.from('social_schedules').insert({
        post_id: post.id, family_id: fid, scheduled_for: scheduledFor, created_by: userId,
      });
      if (scheduleError) throw scheduleError;
      const calItems = (platforms.length ? platforms : [null as SocialPlatform | null]).map((p) => ({
        family_id: fid,
        post_id: post.id,
        title: title ?? body.slice(0, 60),
        platform: p,
        scheduled_for: scheduledFor,
        created_by: userId,
      }));
      const { data: calendarRows, error: calendarError } = await supabase.from('social_calendar_items').insert(calItems).select('id');
      if (calendarError || (calendarRows?.length ?? 0) !== calItems.length) throw calendarError ?? new Error('Calendar rows were not saved.');
      revalidatePath('/dashboard/social/calendar');
      revalidatePath('/dashboard/social/scheduled');
      return { ok: true, postId: post.id, action: 'schedule' };
    }

    if (intent === 'publish') {
      publishStarted = true;
      const outcome = await runPublishNow(supabase, fid, post.id, userId);
      revalidatePath('/dashboard/social/posts');
      revalidatePath('/dashboard/social/published');
      revalidatePath('/dashboard/social/failed');
      return { ok: true, postId: post.id, action: 'publish', outcome };
    }

    revalidatePath('/dashboard/social/posts');
    return { ok: true, postId: post.id, action: 'draft' };
  } catch (error) {
    if (postId && !publishStarted) await cleanupPost(supabase, fid, postId);
    console.error('[social-action] create post failed', error);
    return {
      ok: false, error: describeActionError(error, SOCIAL_SAVE_FAILURE),
      ...(postId && publishStarted ? { postId, action: 'publish' as const } : {}),
    };
  }
}

/** Re-run publishing for failed/pending targets on an existing post. */
export async function retryPublishAction(postId: string): Promise<CreatePostResult> {
  const tr = await getTranslations();
  const { familyId: fid, userId } = await familyId();
  try {
    await requireSocialPermission(fid, 'publish_posts');
  } catch {
    return { ok: false, error: tr('actions.youDoNotHavePermission') };
  }
  const supabase = await createServer();
  try {
    const outcome = await runPublishNow(supabase, fid, postId, userId);
    revalidatePath(`/dashboard/social/posts/${postId}`);
    revalidatePath('/dashboard/social/failed');
    return { ok: true, postId, action: 'publish', outcome };
  } catch (error) {
    console.error('[social-action] retry publish failed', error);
    return { ok: false, postId, error: describeActionError(error, SOCIAL_SAVE_FAILURE) };
  }
}

export async function resolveCommentAction(id: string) {
  const tr = await getTranslations();
  const { familyId: fid, userId } = await familyId();
  await requireSocialPermission(fid, 'view_feed');
  if (!id.trim()) throw new Error('Choose a comment to resolve.');
  const supabase = await createServer();
  const { data, error } = await supabase
    .from('social_comments')
    .update({ status: 'resolved', updated_by: userId })
    .eq('id', id)
    .eq('family_id', fid)
    .select('id')
    .single();
  if (error || !data) throw new Error(describeActionError(error, tr('actions.couldNotResolveThatComment')));
  revalidatePath('/dashboard/social/inbox');
}

export async function createMediaAction(formData: FormData) {
  const tr = await getTranslations();
  const { familyId: fid, userId } = await familyId();
  await requireSocialPermission(fid, 'upload_media');
  const supabase = await createServer();
  const title = String(formData.get('title') ?? '').trim() || null;
  const url = String(formData.get('url') ?? '').trim() || null;
  const kindValue = String(formData.get('kind') ?? 'image');
  const mediaKinds = ['image', 'video', 'audio', 'document', 'thumbnail'] as const;
  if (!(mediaKinds as readonly string[]).includes(kindValue)) throw new Error('Choose a supported media type.');
  const kind = kindValue as typeof mediaKinds[number];
  const alt = String(formData.get('alt_text') ?? '').trim() || null;
  const tags = String(formData.get('tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (title && title.length > 200) throw new Error('Asset titles must be 200 characters or fewer.');
  if (alt && alt.length > 500) throw new Error('Alt text must be 500 characters or fewer.');
  if (tags.length > 20 || tags.some((tag) => tag.length > 80)) throw new Error('Use up to 20 tags, each 80 characters or fewer.');
  if (url) {
    try {
      const parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Unsupported URL protocol');
    } catch {
      throw new Error('Asset URLs must use http or https.');
    }
  }
  const { data, error } = await supabase.from('social_media_library').insert({
    family_id: fid, user_id: userId, kind, title, url, alt_text: alt, tags,
    source: url ? 'upload' : 'prompt', status: url ? 'ready' : 'prompt_only', created_by: userId,
  }).select('id').single();
  if (error || !data) throw new Error(describeActionError(error, tr('actions.couldNotSaveThatMedia')));
  revalidatePath('/dashboard/social/media-library');
}

export async function updateSettingsAction(formData: FormData) {
  const tr = await getTranslations();
  const { familyId: fid, userId } = await familyId();
  await requireSocialPermission(fid, 'manage_settings');
  const supabase = await createServer();
  const default_timezone = String(formData.get('default_timezone') ?? 'UTC');
  const require_approval = formData.get('require_approval') === 'on';
  const auto_hashtags = formData.get('auto_hashtags') === 'on';
  const signature = String(formData.get('signature') ?? '').trim() || null;
  const ai_tone = String(formData.get('ai_tone') ?? 'friendly');
  const default_platforms = formData.getAll('default_platforms').map(String).filter(isPlatform);
  if (!default_timezone.trim() || default_timezone.length > 80) throw new Error('Enter a valid timezone.');
  if (ai_tone.length > 80) throw new Error('AI tone must be 80 characters or fewer.');
  if (signature && signature.length > 300) throw new Error('Signature must be 300 characters or fewer.');
  const { data, error } = await supabase.from('social_settings').upsert(
    { family_id: fid, default_timezone, require_approval, auto_hashtags, signature, ai_tone, default_platforms, updated_by: userId },
    { onConflict: 'family_id' },
  ).select('id').single();
  if (error || !data) throw new Error(describeActionError(error, tr('actions.couldNotSaveSocialSettings')));
  revalidatePath('/dashboard/social/settings');
}

export async function grantAccessAction(formData: FormData) {
  const tr = await getTranslations();
  const { familyId: fid, userId } = await familyId();
  await requireSocialPermission(fid, 'manage_access');
  const supabase = await createServer();
  const targetUserId = String(formData.get('user_id') ?? '').trim();
  const role = String(formData.get('social_role') ?? 'read_only');
  if (!targetUserId) throw new Error('Choose a family member.');
  if (!isSocialRole(role)) throw new Error('Choose a valid social role.');
  const { data: member, error: memberError } = await supabase
    .from('family_members')
    .select('id')
    .eq('family_id', fid)
    .eq('user_id', targetUserId)
    .eq('is_active', true)
    .maybeSingle();
  if (memberError || !member) throw new Error(describeActionError(memberError, tr('actions.thatUserIsNotAn')));
  const { data, error } = await supabase.from('social_access_permissions').upsert(
    { family_id: fid, user_id: targetUserId, social_role: role as never, granted_by: userId, created_by: userId, status: 'active' },
    { onConflict: 'family_id,user_id' },
  ).select('id').single();
  if (error || !data) throw new Error(describeActionError(error, tr('actions.couldNotUpdateSocialAccess')));
  revalidatePath('/dashboard/social/settings');
}
