// lib/social/publish.ts
// Server-side publish pipeline. Creates a publish job, runs each target through
// its connector, records a real social_publish_results row per target, and rolls
// the per-target outcomes up into the post status via derivePostStatus. Nothing
// is marked 'published' unless a connector confirmed it.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getConnector } from './connectors';
import { derivePostStatus, type TargetStatus } from './content';
import type { SocialPlatform } from './capabilities';

type Client = SupabaseClient<Database>;

const PUBLISH_PERSISTENCE_FAILURE =
  'Social publishing could not be saved completely. Review the post status before retrying.';

function throwPersistenceFailure(stage: string, error: unknown): never {
  console.error(`[social-publish] ${stage}`, error);
  throw new Error(PUBLISH_PERSISTENCE_FAILURE);
}

async function markJobFailed(
  supabase: Client,
  familyId: string,
  jobId: string,
  userId: string | null,
  message: string,
): Promise<void> {
  const { error } = await supabase
    .from('social_publish_jobs')
    .update({ status: 'failed', last_error: message, updated_by: userId })
    .eq('id', jobId)
    .eq('family_id', familyId);
  if (error) console.error('[social-publish] failed-job update failed', error);
}

async function abortJob(
  supabase: Client,
  familyId: string,
  jobId: string,
  userId: string | null,
  stage: string,
  error: unknown,
  message = PUBLISH_PERSISTENCE_FAILURE,
): Promise<never> {
  await markJobFailed(supabase, familyId, jobId, userId, message);
  console.error(`[social-publish] ${stage}`, error);
  throw new Error(message);
}

export type PublishOutcome = {
  postId: string;
  jobId: string;
  status: string;
  targets: Array<{
    targetId: string;
    platform: SocialPlatform;
    status: TargetStatus;
    permalinkUrl: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  }>;
};

/** Create the per-platform target rows for a post from selected accounts. */
export async function createTargets(
  supabase: Client,
  familyId: string,
  postId: string,
  accountIds: string[],
  scheduledFor: string | null,
): Promise<number> {
  const requestedIds = Array.from(new Set(accountIds));
  if (requestedIds.length === 0) return 0;
  const { data: accounts, error: accountError } = await supabase
    .from('social_accounts')
    .select('id, platform')
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .in('id', requestedIds);
  if (accountError) throwPersistenceFailure('target account lookup failed', accountError);
  if ((accounts ?? []).length !== requestedIds.length) {
    throw new Error('One or more selected social accounts are unavailable. Refresh and try again.');
  }

  const rows = (accounts ?? []).map((a) => ({
    post_id: postId,
    family_id: familyId,
    account_id: a.id,
    platform: a.platform,
    status: (scheduledFor ? 'pending' : 'pending') as TargetStatus,
    scheduled_for: scheduledFor,
  }));
  if (rows.length) {
    const { error } = await supabase.from('social_post_targets').insert(rows);
    if (error) throwPersistenceFailure('target creation failed', error);
  }
  return rows.length;
}

/**
 * Execute publishing for a post NOW: run each pending target through its
 * connector, persist results, and update statuses. Returns the per-target
 * outcomes so the UI can show honest success/failure per platform.
 */
export async function runPublishNow(
  supabase: Client,
  familyId: string,
  postId: string,
  userId: string | null,
): Promise<PublishOutcome> {
  // Create the job row (RLS requires publish/schedule permission).
  const { data: job, error: jobErr } = await supabase
    .from('social_publish_jobs')
    .insert({
      post_id: postId,
      family_id: familyId,
      status: 'running',
      scheduled_for: new Date().toISOString(),
      attempts: 1,
      created_by: userId,
    })
    .select('id')
    .single();
  if (jobErr || !job) {
    throwPersistenceFailure('publish-job creation failed', jobErr ?? new Error('Missing publish job row'));
  }

  const { data: publishingPost, error: publishingPostError } = await supabase
    .from('social_posts')
    .update({ status: 'publishing', updated_by: userId })
    .eq('id', postId)
    .eq('family_id', familyId)
    .select('id')
    .single();
  if (publishingPostError || !publishingPost) {
    return abortJob(supabase, familyId, job.id, userId, 'post publishing-state update failed', publishingPostError ?? new Error('Missing post row'));
  }

  const { data: targets, error: targetsError } = await supabase
    .from('social_post_targets')
    .select('id, platform, account_id')
    .eq('post_id', postId)
    .eq('family_id', familyId)
    .in('status', ['pending', 'failed']);
  if (targetsError) {
    return abortJob(supabase, familyId, job.id, userId, 'publish-target lookup failed', targetsError);
  }

  const { data: variants, error: variantsError } = await supabase
    .from('social_post_variants')
    .select('platform, body')
    .eq('post_id', postId)
    .eq('family_id', familyId);
  if (variantsError) {
    return abortJob(supabase, familyId, job.id, userId, 'post-variant lookup failed', variantsError);
  }

  const { data: post, error: postError } = await supabase
    .from('social_posts')
    .select('body, link')
    .eq('id', postId)
    .eq('family_id', familyId)
    .single();
  if (postError || !post) {
    return abortJob(supabase, familyId, job.id, userId, 'post lookup failed', postError ?? new Error('Missing post row'));
  }
  if ((targets ?? []).length === 0) {
    return abortJob(
      supabase,
      familyId,
      job.id,
      userId,
      'publish invoked without pending targets',
      new Error('No pending social targets'),
      'No pending social accounts are available for this post.',
    );
  }

  const variantByPlatform = new Map((variants ?? []).map((v) => [v.platform, v.body]));
  const outcomes: PublishOutcome['targets'] = [];
  const finalStatuses: TargetStatus[] = [];

  for (const target of targets ?? []) {
    const platform = target.platform as SocialPlatform;
    let providerAccountId: string | null = null;
    if (target.account_id) {
      const { data: acct, error: accountError } = await supabase
        .from('social_accounts')
        .select('provider_account_id')
        .eq('id', target.account_id)
        .eq('family_id', familyId)
        .is('deleted_at', null)
        .maybeSingle();
      if (accountError || !acct) {
        return abortJob(supabase, familyId, job.id, userId, 'publish account lookup failed', accountError ?? new Error('Missing social account'));
      }
      providerAccountId = acct?.provider_account_id ?? null;
    }

    const { data: publishingTarget, error: publishingTargetError } = await supabase
      .from('social_post_targets')
      .update({ status: 'publishing', updated_by: userId })
      .eq('id', target.id)
      .eq('family_id', familyId)
      .select('id')
      .single();
    if (publishingTargetError || !publishingTarget) {
      return abortJob(supabase, familyId, job.id, userId, 'target publishing-state update failed', publishingTargetError ?? new Error('Missing target row'));
    }

    const connector = getConnector(platform);
    let result;
    try {
      result = await connector.publish({
        platform,
        providerAccountId,
        body: variantByPlatform.get(platform) ?? post.body,
        link: post.link ?? null,
        mediaUrls: [],
      });
    } catch (error) {
      return abortJob(supabase, familyId, job.id, userId, 'connector publish threw', error, 'The provider publish failed. Review the post before retrying.');
    }

    finalStatuses.push(result.status);

    const { error: resultError } = await supabase.from('social_publish_results').insert({
      job_id: job.id,
      target_id: target.id,
      post_id: postId,
      family_id: familyId,
      account_id: target.account_id,
      platform,
      status: result.status,
      provider_object_id: result.providerObjectId ?? null,
      permalink_url: result.permalinkUrl ?? null,
      error_code: result.errorCode ?? null,
      error_message: result.errorMessage ?? null,
      raw_response: (result.raw ?? {}) as Database['public']['Tables']['social_publish_results']['Insert']['raw_response'],
      created_by: userId,
    });
    if (resultError) {
      return abortJob(supabase, familyId, job.id, userId, 'publish-result persistence failed', resultError);
    }

    const { data: savedTarget, error: targetError } = await supabase
      .from('social_post_targets')
      .update({
        status: result.status,
        provider_object_id: result.providerObjectId ?? null,
        permalink_url: result.permalinkUrl ?? null,
        error: result.errorMessage ?? null,
        published_at: result.ok ? new Date().toISOString() : null,
        updated_by: userId,
      })
      .eq('id', target.id)
      .eq('family_id', familyId)
      .select('id')
      .single();
    if (targetError || !savedTarget) {
      return abortJob(supabase, familyId, job.id, userId, 'target outcome persistence failed', targetError ?? new Error('Missing target row'));
    }

    outcomes.push({
      targetId: target.id,
      platform,
      status: result.status,
      permalinkUrl: result.permalinkUrl ?? null,
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
    });
  }

  const postStatus = derivePostStatus(finalStatuses);
  const { data: savedPost, error: finalPostError } = await supabase
    .from('social_posts')
    .update({
      status: postStatus,
      published_at: postStatus === 'published' || postStatus === 'partially_published' ? new Date().toISOString() : null,
      updated_by: userId,
    })
    .eq('id', postId)
    .eq('family_id', familyId)
    .select('id')
    .single();
  if (finalPostError || !savedPost) {
    return abortJob(supabase, familyId, job.id, userId, 'final post status persistence failed', finalPostError ?? new Error('Missing post row'));
  }

  const jobStatus = finalStatuses.some((s) => s === 'published') ? 'succeeded' : 'failed';
  const { data: savedJob, error: finalJobError } = await supabase
    .from('social_publish_jobs')
    .update({ status: jobStatus, updated_by: userId })
    .eq('id', job.id)
    .eq('family_id', familyId)
    .select('id')
    .single();
  if (finalJobError || !savedJob) {
    return abortJob(supabase, familyId, job.id, userId, 'final job status persistence failed', finalJobError ?? new Error('Missing job row'));
  }

  const { error: usageError } = await supabase.from('social_usage_events').insert({
    family_id: familyId,
    user_id: userId,
    kind: 'publish',
    quantity: outcomes.length,
    unit: 'targets',
  });
  if (usageError) console.error('[social-publish] usage event persistence failed', usageError);

  return { postId, jobId: job.id, status: postStatus, targets: outcomes };
}
